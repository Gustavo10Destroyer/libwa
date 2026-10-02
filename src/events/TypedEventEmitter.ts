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

interface ListenerEntry {
  readonly listener: StoredListener;
  readonly once: boolean;
}

export interface TypedEventEmitterOptions {
  /** Invoked when a listener throws or its promise rejects. */
  onListenerError?: (error: unknown, event: string) => void;
}

/**
 * A small strongly-typed event emitter.
 *
 * Listener arguments are inferred from the event name, async listeners are
 * supported (rejections are routed to `onListenerError` instead of crashing
 * the process), and listeners are kept in one array per event so `on` and
 * `once` listeners dispatch strictly in registration order.
 */
export class TypedEventEmitter<Map extends EventMapConstraint<Map>> {
  readonly #entries = new Map<keyof Map, ListenerEntry[]>();
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
      this.#entries.delete(event);
      return;
    }
    const entries = this.#entries.get(event);
    if (entries === undefined) {
      return;
    }
    const stored = listener as StoredListener;
    const remaining = entries.filter((entry) => entry.listener !== stored);
    if (remaining.length === 0) {
      this.#entries.delete(event);
    } else {
      this.#entries.set(event, remaining);
    }
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

  /** Emits `event` and awaits every listener sequentially in registration order. */
  async emitAsync<Key extends keyof Map>(event: Key, ...args: Map[Key]): Promise<void> {
    const entries = this.#entries.get(event);
    if (entries === undefined || entries.length === 0) {
      return;
    }
    const snapshot = [...entries];
    // Consume `once` listeners before dispatch so a re-entrant emit (from
    // inside a listener) never fires them again.
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      if (entries[index]?.once === true) {
        entries.splice(index, 1);
      }
    }
    if (entries.length === 0 && this.#entries.get(event) === entries) {
      this.#entries.delete(event);
    }
    for (const entry of snapshot) {
      try {
        await (entry.listener as (...listenerArgs: Map[Key]) => unknown)(...args);
      } catch (error) {
        this.#reportError(error, String(event));
      }
    }
  }

  /**
   * Returns a snapshot of the listeners registered for `event` in
   * registration order. Non-consuming: `once` listeners stay registered for
   * the next {@link emitAsync}.
   */
  listenersOf<Key extends keyof Map>(event: Key): readonly ListenerOf<Map, Key>[] {
    const entries = this.#entries.get(event);
    if (entries === undefined) {
      return [];
    }
    return entries.map((entry) => entry.listener) as unknown as readonly ListenerOf<Map, Key>[];
  }

  /** Returns true when at least one listener is registered for `event`. */
  hasListeners<Key extends keyof Map>(event: Key): boolean {
    return (this.#entries.get(event)?.length ?? 0) > 0;
  }

  /** Removes every listener of every event. */
  removeAllListeners(): void {
    this.#entries.clear();
  }

  #add<Key extends keyof Map>(
    event: Key,
    listener: ListenerOf<Map, Key>,
    once: boolean,
  ): Unsubscribe {
    let entries = this.#entries.get(event);
    if (entries === undefined) {
      entries = [];
      this.#entries.set(event, entries);
    }
    const stored = listener as StoredListener;
    // One entry per listener per event: re-registering replaces the previous
    // registration (the old `Set` storage behaved the same way).
    const existing = entries.findIndex((entry) => entry.listener === stored);
    if (existing !== -1) {
      entries.splice(existing, 1);
    }
    const entry: ListenerEntry = { listener: stored, once };
    entries.push(entry);
    return () => {
      const current = this.#entries.get(event);
      if (current === undefined) {
        return;
      }
      const index = current.indexOf(entry);
      if (index !== -1) {
        current.splice(index, 1);
        if (current.length === 0) {
          this.#entries.delete(event);
        }
      }
    };
  }

  #reportError(error: unknown, event: string): void {
    this.#options.onListenerError?.(error, event);
  }
}
