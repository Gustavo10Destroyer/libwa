/**
 * Session (authentication) persistence abstraction.
 *
 * The core never interprets session contents: a backend serializes its own
 * credentials/keys into {@link Session.data} and restores them later. This
 * keeps authentication provider-independent and lets applications plug in
 * file, memory, Redis, SQL or cloud stores without touching bot code.
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
}
