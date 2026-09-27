import type { Unsubscribe } from "../core/ids.js";

/**
 * A listener registered on a {@link TypedEventEmitter}.
 *
 * The `never[]` rest parameter keeps listeners assignable while the emitter
 * invokes them with the exact tuple declared for each event.
 */
export type EventListener<Args extends readonly unknown[]> = (...args: never[]) => unknown;

export type EventMap = Record<string, readonly unknown[]>;

/**
 * Constraint for event maps that also accepts interfaces: interfaces have no
 * implicit index signature, so a plain `Record` constraint would reject them.
 * Requiring each declared key to map to an argument tuple is sufficient.
 */
export type EventMapConstraint<Map> = Record<keyof Map, readonly unknown[]>;

export type ListenerOf<Map extends EventMapConstraint<Map>, Key extends keyof Map> = (
  ...args: Map[Key]
) => void | Promise<void>;

type StoredListener = (...args: never[]) => unknown;

export interface TypedEventEmitterOptions {
  /** Invoked when a listener throws or its promise rejects. */
  onListenerError?: (error: unknown, event: string) => void;
}

/**
 * A small strongly-typed event emitter.
 *
 * Listener arguments are inferred from the event name, async listeners are
 * supported (rejections are routed to `onListenerError` instead of crashing
 * the process), and listeners can be enumerated for pipeline dispatch.
 */
export class TypedEventEmitter<Map extends EventMapConstraint<Map>> {
  readonly #listeners = new Map<keyof Map, Set<StoredListener>>();
  readonly #once = new Map<keyof Map, Set<StoredListener>>();
  readonly #options: TypedEventEmitterOptions;

  constructor(options: TypedEventEmitterOptions = {}) {
    this.#options = options;
  }

  /** Registers a listener for `event`. */
  on<Key extends keyof Map>(event: Key, listener: ListenerOf<Map, Key>): Unsubscribe {
    return this.#add(event, listener, false);
  }

  /** Registers a listener that fires at most once for `event`. */
  once<Key extends keyof Map>(event: Key, listener: ListenerOf<Map, Key>): Unsubscribe {
    return this.#add(event, listener, true);
  }

  /** Removes a previously registered listener (or all listeners when omitted). */
  off<Key extends keyof Map>(event: Key, listener?: ListenerOf<Map, Key>): void {
    if (listener === undefined) {
      this.#listeners.delete(event);
      this.#once.delete(event);
      return;
    }
    this.#listeners.get(event)?.delete(listener as StoredListener);
    this.#once.get(event)?.delete(listener as StoredListener);
  }

  /**
   * Emits `event`. Async listeners are awaited by {@link emitAsync}; this
   * method fires them and routes failures to `onListenerError`.
   */
  emit<Key extends keyof Map>(event: Key, ...args: Map[Key]): void {
    void this.emitAsync(event, ...args).catch((error: unknown) => {
      this.#reportError(error, String(event));
    });
  }

  /** Emits `event` and awaits every listener sequentially. */
  async emitAsync<Key extends keyof Map>(event: Key, ...args: Map[Key]): Promise<void> {
    const permanent = this.#listeners.get(event);
    const single = this.#once.get(event);
    if (permanent === undefined && single === undefined) {
      return;
    }
    const snapshot = [...(permanent ?? []), ...(single ?? [])];
    if (single !== undefined) {
      this.#once.delete(event);
    }
    for (const listener of snapshot) {
      try {
        await (listener as (...listenerArgs: Map[Key]) => unknown)(...args);
      } catch (error) {
        this.#reportError(error, String(event));
      }
    }
  }

  /** Returns a snapshot of the listeners registered for `event`. */
  listenersOf<Key extends keyof Map>(event: Key): readonly ListenerOf<Map, Key>[] {
    const permanent = this.#listeners.get(event);
    const single = this.#once.get(event);
    return [...(permanent ?? []), ...(single ?? [])] as unknown as readonly ListenerOf<Map, Key>[];
  }

  /** Returns true when at least one listener is registered for `event`. */
  hasListeners<Key extends keyof Map>(event: Key): boolean {
    return (this.#listeners.get(event)?.size ?? 0) + (this.#once.get(event)?.size ?? 0) > 0;
  }

  /** Removes every listener of every event. */
  removeAllListeners(): void {
    this.#listeners.clear();
    this.#once.clear();
  }

  #add<Key extends keyof Map>(
    event: Key,
    listener: ListenerOf<Map, Key>,
    once: boolean,
  ): Unsubscribe {
    const target = once ? this.#once : this.#listeners;
    let set = target.get(event);
    if (set === undefined) {
      set = new Set();
      target.set(event, set);
    }
    const stored = listener as StoredListener;
    set.add(stored);
    return () => {
      target.get(event)?.delete(stored);
    };
  }

  #reportError(error: unknown, event: string): void {
    this.#options.onListenerError?.(error, event);
  }
}
