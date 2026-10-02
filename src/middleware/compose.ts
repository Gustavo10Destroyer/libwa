import type { Interaction } from "../interactions/Interaction.js";

/**
 * A middleware in the interaction dispatch pipeline.
 *
 * Middlewares run in registration order before interaction listeners. Calling
 * `next()` continues the chain; skipping it stops dispatch (useful for
 * permissions, rate limiting, or filtering). Throwing aborts dispatch and
 * surfaces the error through the client's `error` event.
 *
 * `next()` may be awaited or fired and forgotten. When it is awaited (or
 * otherwise handled) the middleware owns the outcome and may swallow it;
 * when it is left untouched the chain adopts it, so a downstream failure
 * still rejects the dispatch instead of escaping as an unhandled rejection.
 */
export type Middleware = (
  interaction: Interaction,
  next: () => Promise<void>,
) => void | Promise<void>;

/**
 * A `Promise` that records whether anything attached a handler to it.
 *
 * The composer needs to tell "`await next()` failed" apart from "nobody is
 * watching `next()`", which a plain promise cannot express: there is no way
 * to observe who called `.then`. This thenable exposes that one bit without
 * changing any other behaviour of the promise it wraps.
 */
class TrackedPromise implements Promise<void> {
  readonly [Symbol.toStringTag] = "Promise";
  readonly #promise: Promise<void>;
  #touched = false;

  constructor(promise: Promise<void>) {
    this.#promise = promise;
  }

  /** True once `then`/`catch`/`finally` was called on this promise. */
  get touched(): boolean {
    return this.#touched;
  }

  // biome-ignore lint/suspicious/noThenProperty: an intentional thenable — awaiting it is how a middleware adopts next()
  then<TResult1 = void, TResult2 = never>(
    // biome-ignore lint/suspicious/noConfusingVoidType: mirrors Promise<void>'s own parameter type
    onfulfilled?: ((value: void) => TResult1 | PromiseLike<TResult1>) | undefined | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | undefined | null,
  ): Promise<TResult1 | TResult2> {
    this.#touched = true;
    return this.#promise.then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | undefined | null,
    // biome-ignore lint/suspicious/noConfusingVoidType: mirrors Promise<void>'s own union return type
  ): Promise<void | TResult> {
    this.#touched = true;
    return this.#promise.catch(onrejected);
  }

  finally(onfinally?: (() => void) | undefined | null): Promise<void> {
    this.#touched = true;
    return this.#promise.finally(onfinally);
  }
}

/**
 * Runs `middlewares` in order around `last` for a single interaction.
 *
 * Each middleware must call `next()` at most once; skipping `next()` stops
 * the chain (listeners and command execution never run). The returned promise
 * rejects when a middleware throws or misbehaves — including when it detaches
 * from `next()` and the rest of the chain fails.
 */
export function runMiddlewareChain(
  middlewares: readonly Middleware[],
  interaction: Interaction,
  last: () => Promise<void>,
): Promise<void> {
  const dispatch = async (position: number): Promise<void> => {
    const middleware = middlewares[position];
    if (middleware === undefined) {
      await last();
      return;
    }

    let called = false;
    const spawned: TrackedPromise[] = [];

    const track = (downstream: Promise<void>): Promise<void> => {
      // Observe the rejection right away so it is never reported as
      // unhandled while ownership is still undecided. Every later consumer
      // (the middleware, or the adoption below) sees the same rejection.
      void downstream.then(undefined, () => undefined);
      const tracked = new TrackedPromise(downstream);
      spawned.push(tracked);
      return tracked;
    };

    const next = (): Promise<void> => {
      if (called) {
        return track(
          Promise.reject(new Error("next() called multiple times in the same middleware.")),
        );
      }
      called = true;
      return track(dispatch(position + 1));
    };

    await middleware(interaction, next);

    // A middleware that returned `next()`'s promise without touching it has
    // detached the chain. Adopt those promises so their failures reject this
    // frame and reach the caller's error handling rather than the process.
    for (const tracked of spawned) {
      if (!tracked.touched) {
        await tracked;
      }
    }
  };

  return dispatch(0);
}
