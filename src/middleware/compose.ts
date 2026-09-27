import type { Interaction } from "../interactions/Interaction.js";

/**
 * A middleware in the interaction dispatch pipeline.
 *
 * Middlewares run in registration order before interaction listeners. Calling
 * `next()` continues the chain; skipping it stops dispatch (useful for
 * permissions, rate limiting, or filtering). Throwing aborts dispatch and
 * surfaces the error through the client's `error` event.
 */
export type Middleware = (
  interaction: Interaction,
  next: () => Promise<void>,
) => void | Promise<void>;

/**
 * Runs `middlewares` in order around `last` for a single interaction.
 *
 * Each middleware must call `next()` at most once; skipping `next()` stops
 * the chain (listeners and command execution never run). The returned promise
 * rejects when a middleware throws or misbehaves.
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
    await middleware(interaction, async () => {
      if (called) {
        throw new Error("next() called multiple times in the same middleware.");
      }
      called = true;
      await dispatch(position + 1);
    });
  };
  return dispatch(0);
}
