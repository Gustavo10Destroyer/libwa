import type { Session, SessionStore } from "./SessionStore.js";

/**
 * In-memory {@link SessionStore}.
 *
 * Ideal for tests and throwaway processes. Sessions do not survive restarts.
 */
export class MemorySessionStore implements SessionStore {
  readonly #sessions = new Map<string, Session>();

  async load(id: string): Promise<Session | null> {
    return this.#sessions.get(id) ?? null;
  }

  async save(session: Session): Promise<void> {
    this.#sessions.set(session.id, session);
  }

  async clear(id: string): Promise<void> {
    this.#sessions.delete(id);
  }
}
