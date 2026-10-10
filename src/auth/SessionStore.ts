import { ValidationError } from "../errors/index.js";

/**
 * Session (authentication) persistence abstraction.
 *
 * The core never interprets session contents: a backend serializes its own
 * credentials/keys into {@link Session.data} and restores them later. This
 * keeps authentication provider-independent and lets applications plug in
 * file, SQLite, memory, Redis or cloud stores without touching bot code.
 */

/** An opaque, provider-owned authentication snapshot. */
export interface Session {
  /** Session identifier (see `ClientOptions.sessionId`). */
  readonly id: string;
  /** Identifier of the backend that produced this session (e.g. `baileys`). */
  readonly provider: string;
  /** Serialized provider state. Opaque to everything but the backend. */
  readonly data: Uint8Array;
  /** When this session was last saved. */
  readonly updatedAt: Date;
}

/** Persistence contract used by backends to load and store sessions. */
export interface SessionStore {
  /** Loads the session with the given id, or `null` when none exists. */
  load(id: string): Promise<Session | null>;
  /** Persists the given session (its `id` selects the slot). */
  save(session: Session): Promise<void>;
  /** Removes the session with the given id. Missing sessions are not an error. */
  clear(id: string): Promise<void>;
  /**
   * Releases resources the store holds — database handles, sockets, timers.
   *
   * Optional: stores with nothing to release omit it, and callers must use
   * `store.close?.()` until they know which store they were handed. libwa.js
   * never calls this on your behalf: whoever constructed the store closes it,
   * so a store shared by several clients survives any one of them shutting
   * down. Once closed, `load`/`save`/`clear` reject instead of writing to a
   * half-released resource.
   */
  close?(): Promise<void> | void;
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Validates a session id so it is safe in every store.
 *
 * The concrete rule matters beyond the filesystem store: ids must round-trip
 * unchanged when a bot is moved from one store to another, so a slot that
 * works with `MemorySessionStore` also works with `SqliteSessionStore`.
 */
export function assertSafeSessionId(id: string): void {
  if (!SESSION_ID_PATTERN.test(id)) {
    throw new ValidationError(
      `Invalid session id "${id}": use 1-64 characters from [A-Za-z0-9_-].`,
      { code: "ERR_SESSION_ID" },
    );
  }
}
