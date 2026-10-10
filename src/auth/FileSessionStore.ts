import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ValidationError } from "../errors/index.js";
import { type Session, type SessionStore, assertSafeSessionId } from "./SessionStore.js";

interface SessionFile {
  provider: string;
  data: string;
  updatedAt: string;
}

export interface FileSessionStoreOptions {
  /** Directory in which session files are stored. Defaults to `.libwa.js`. */
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
  /**
   * Distinguishes this instance's temp files. Two stores in one process used
   * to share `<file>.<pid>.tmp`, so their writes interleaved and the renamed
   * result was torn JSON.
   */
  readonly #writerId = randomUUID();

  constructor(options: FileSessionStoreOptions = {}) {
    this.#directory = options.directory ?? ".libwa.js";
  }

  get directory(): string {
    return this.#directory;
  }

  async load(id: string): Promise<Session | null> {
    assertSafeSessionId(id);
    let raw: string;
    try {
      raw = await readFile(this.#path(id), "utf8");
    } catch (error) {
      // Only "no such file" means "no session". Swallowing EACCES/EIO would
      // silently discard a stored session and restart the login flow.
      if (errnoCode(error) === "ENOENT") {
        return null;
      }
      throw new ValidationError(`Session file for "${id}" could not be read.`, {
        code: "ERR_SESSION_UNREADABLE",
        cause: error,
      });
    }
    const parsed = parseSessionFile(raw, id);
    const updatedAt = new Date(parsed.updatedAt);
    if (Number.isNaN(updatedAt.getTime())) {
      throw corruptSession(id, "updatedAt is not a valid date");
    }
    return {
      id,
      provider: parsed.provider,
      data: Buffer.from(parsed.data, "base64"),
      updatedAt,
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
      const temp = `${target}.${this.#writerId}.tmp`;
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

/** The `code` of a Node system error, when the thrown value carries one. */
function errnoCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const { code } = error as { code?: unknown };
  return typeof code === "string" ? code : undefined;
}

function corruptSession(id: string, detail: string, cause?: unknown): ValidationError {
  return new ValidationError(`Session file for "${id}" is corrupt (${detail}).`, {
    code: "ERR_SESSION_CORRUPT",
    cause,
  });
}

/**
 * Parses a session file, rejecting every malformed shape with a typed error.
 *
 * Field types are checked before use: `Buffer.from(undefined, "base64")` and
 * friends throw a raw `TypeError`, which `login()` does not classify as an
 * unfixable configuration problem — it would then retry forever instead of
 * failing fast.
 */
function parseSessionFile(raw: string, id: string): SessionFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw corruptSession(id, "file is not valid JSON", error);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw corruptSession(id, "file does not contain a JSON object");
  }
  const candidate = parsed as Partial<SessionFile>;
  if (
    typeof candidate.provider !== "string" ||
    typeof candidate.data !== "string" ||
    typeof candidate.updatedAt !== "string"
  ) {
    throw corruptSession(id, "provider, data and updatedAt must all be strings");
  }
  return {
    provider: candidate.provider,
    data: candidate.data,
    updatedAt: candidate.updatedAt,
  };
}
