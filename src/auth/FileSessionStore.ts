import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ValidationError } from "../errors/index.js";
import type { Session, SessionStore } from "./SessionStore.js";

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Validates a session id so it can never escape the store directory. */
export function assertSafeSessionId(id: string): void {
  if (!SESSION_ID_PATTERN.test(id)) {
    throw new ValidationError(
      `Invalid session id "${id}": use 1-64 characters from [A-Za-z0-9_-].`,
      { code: "ERR_SESSION_ID" },
    );
  }
}

interface SessionFile {
  provider: string;
  data: string;
  updatedAt: string;
}

export interface FileSessionStoreOptions {
  /** Directory in which session files are stored. Defaults to `.libwa`. */
  directory?: string;
}

/**
 * Filesystem-backed {@link SessionStore}.
 *
 * Each session is stored as a single JSON file (`<directory>/<id>.json`) with
 * the payload encoded as base64. Writes are atomic (temp file + rename) and
 * serialized per file, so the store is safe under concurrent updates.
 */
export class FileSessionStore implements SessionStore {
  readonly #directory: string;
  readonly #queues = new Map<string, Promise<unknown>>();

  constructor(options: FileSessionStoreOptions = {}) {
    this.#directory = options.directory ?? ".libwa";
  }

  get directory(): string {
    return this.#directory;
  }

  async load(id: string): Promise<Session | null> {
    assertSafeSessionId(id);
    const raw = await readFile(this.#path(id), "utf8").catch(() => null);
    if (raw === null) {
      return null;
    }
    let parsed: SessionFile;
    try {
      parsed = JSON.parse(raw) as SessionFile;
    } catch (error) {
      throw new ValidationError(`Session file for "${id}" is corrupt.`, {
        code: "ERR_SESSION_CORRUPT",
        cause: error,
      });
    }
    return {
      id,
      provider: parsed.provider,
      data: Buffer.from(parsed.data, "base64"),
      updatedAt: new Date(parsed.updatedAt),
    };
  }

  async save(session: Session): Promise<void> {
    assertSafeSessionId(session.id);
    await this.#serialize(session.id, async () => {
      await mkdir(this.#directory, { recursive: true });
      const payload: SessionFile = {
        provider: session.provider,
        data: Buffer.from(session.data).toString("base64"),
        updatedAt: session.updatedAt.toISOString(),
      };
      const target = this.#path(session.id);
      const temp = `${target}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify(payload), "utf8");
      await rename(temp, target);
    });
  }

  async clear(id: string): Promise<void> {
    assertSafeSessionId(id);
    await this.#serialize(id, async () => {
      await rm(this.#path(id), { force: true });
    });
  }

  #path(id: string): string {
    return join(this.#directory, `${id}.json`);
  }

  #serialize<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(id) ?? Promise.resolve();
    const next = previous.then(task, task);
    this.#queues.set(
      id,
      next.catch(() => undefined),
    );
    return next;
  }
}
