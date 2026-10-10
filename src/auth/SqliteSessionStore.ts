import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ValidationError } from "../errors/index.js";
import { type Session, type SessionStore, assertSafeSessionId } from "./SessionStore.js";
import { type SqliteDatabase, type SqliteStatement, loadDriver } from "./sqliteDriver.js";

export interface SqliteSessionStoreOptions {
  /**
   * Path to the database file, or `":memory:"` for a database that lives only
   * in this process. Missing parent directories are created. Defaults to
   * `"libwa.js-sessions.db"` in the current working directory.
   */
  filename?: string;
  /**
   * How long SQLite waits for another writer (another process, or another
   * client sharing the file) before failing the statement, in milliseconds.
   * Defaults to `5000`.
   *
   * The wait happens synchronously on the event loop, so keep it short: it is
   * a backstop against a stray lock, not a queue to sit in.
   */
  busyTimeoutMs?: number;
}

/** Default database file, kept out of `.libwa.js/` because it is not a directory layout. */
const DEFAULT_FILENAME = "libwa.js-sessions.db";
const DEFAULT_BUSY_TIMEOUT_MS = 5000;
/**
 * Bumped only when the table changes shape. Opening a database written by a
 * newer libwa.js fails loudly instead of guessing at columns it does not know.
 */
const SCHEMA_VERSION = 1;

const CREATE_SESSIONS = `
  CREATE TABLE IF NOT EXISTS sessions (
    id         TEXT    PRIMARY KEY,
    provider   TEXT    NOT NULL,
    data       BLOB    NOT NULL,
    updated_at INTEGER NOT NULL
  ) WITHOUT ROWID
`;

const SELECT_SESSION = "SELECT provider, data, updated_at FROM sessions WHERE id = ?";

const UPSERT_SESSION = `
  INSERT INTO sessions (id, provider, data, updated_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    provider   = excluded.provider,
    data       = excluded.data,
    updated_at = excluded.updated_at
`;

const DELETE_SESSION = "DELETE FROM sessions WHERE id = ?";

const SELECT_USER_VERSION = "PRAGMA user_version";

interface SessionRow {
  provider: unknown;
  data: unknown;
  updated_at: unknown;
}

function storeError(message: string, cause: unknown): ValidationError {
  return new ValidationError(message, { code: "ERR_SESSION_STORE", cause });
}

function corruptRow(id: string, detail: string): ValidationError {
  return new ValidationError(`Session row for "${id}" is corrupt (${detail}).`, {
    code: "ERR_SESSION_CORRUPT",
  });
}

function readUserVersion(db: SqliteDatabase): number {
  const row: unknown = db.prepare(SELECT_USER_VERSION).get();
  if (typeof row !== "object" || row === null) {
    return 0;
  }
  const version: unknown = (row as { user_version?: unknown }).user_version;
  return typeof version === "number" && Number.isFinite(version) ? version : 0;
}

/**
 * Opens the database and brings it to {@link SCHEMA_VERSION}.
 *
 * Every failure path closes the handle before rethrowing, so a store that
 * refuses to open never leaves an fd behind.
 */
function openDatabase(filename: string, busyTimeoutMs: number): SqliteDatabase {
  if (filename !== ":memory:" && !filename.startsWith("file:")) {
    mkdirSync(dirname(filename), { recursive: true });
  }
  let db: SqliteDatabase;
  try {
    db = new (loadDriver())(filename);
  } catch (error) {
    if (error instanceof ValidationError) {
      throw error;
    }
    throw storeError(`Session database "${filename}" could not be opened.`, error);
  }
  try {
    // WAL lets a second process (a second bot instance, or a migration tool)
    // read while this one writes; FULL keeps the last credential write across
    // a power loss, and session writes are rare enough that it costs nothing.
    if (filename !== ":memory:") {
      db.exec("PRAGMA journal_mode = WAL");
    }
    db.exec("PRAGMA synchronous = FULL");
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    const version = readUserVersion(db);
    if (version > SCHEMA_VERSION) {
      throw new ValidationError(
        `Session database "${filename}" uses schema version ${version}, but this build of libwa.js ` +
          `understands up to ${SCHEMA_VERSION}. Upgrade libwa.js rather than opening it with an older release.`,
        { code: "ERR_SESSION_STORE" },
      );
    }
    db.exec(CREATE_SESSIONS);
    if (version < SCHEMA_VERSION) {
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    }
  } catch (error) {
    try {
      db.close();
    } catch {
      // The setup failure is the useful one; a close failure hides it.
    }
    throw error;
  }
  return db;
}

/**
 * SQLite-backed {@link SessionStore} — the store to run a bot on in production.
 *
 * One file holds every session slot, so credentials survive restarts, several
 * bot processes can share a deployment, and moving the bot means copying one
 * file instead of a directory tree. Writes are single statements (SQLite
 * serializes them), ids are validated exactly like {@link FileSessionStore}'s,
 * and a row that does not parse fails with `ERR_SESSION_CORRUPT` rather than
 * quietly restarting the login flow.
 *
 * ```ts
 * const store = new SqliteSessionStore({ filename: "/var/lib/bot/bot.db" });
 * const client = new Client({ sessionStore: store, sessionId: "prod" });
 * // ... on shutdown:
 * await client.destroy();
 * store.close();
 * ```
 *
 * The store owns its connection: close it yourself when you are done with it.
 * `Client.destroy()` never closes a store it did not create.
 */
export class SqliteSessionStore implements SessionStore {
  readonly #db: SqliteDatabase;
  readonly #filename: string;
  readonly #loadSession: SqliteStatement;
  readonly #saveSession: SqliteStatement;
  readonly #clearSession: SqliteStatement;
  #closed = false;

  constructor(options: SqliteSessionStoreOptions = {}) {
    const filename = options.filename ?? DEFAULT_FILENAME;
    const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
    if (typeof filename !== "string" || filename.length === 0) {
      throw new ValidationError("SqliteSessionStore filename must be a non-empty string.", {
        code: "ERR_SESSION_STORE",
      });
    }
    if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
      throw new ValidationError(
        "SqliteSessionStore busyTimeoutMs must be a non-negative integer.",
        {
          code: "ERR_SESSION_STORE",
        },
      );
    }
    this.#filename = filename;
    const db = openDatabase(filename, busyTimeoutMs);
    this.#db = db;
    this.#loadSession = db.prepare(SELECT_SESSION);
    this.#saveSession = db.prepare(UPSERT_SESSION);
    this.#clearSession = db.prepare(DELETE_SESSION);
  }

  /** The database file this store reads and writes (`":memory:"` when private). */
  get filename(): string {
    return this.#filename;
  }

  /** Whether {@link close} has already been called. */
  get closed(): boolean {
    return this.#closed;
  }

  async load(id: string): Promise<Session | null> {
    this.#assertOpen();
    assertSafeSessionId(id);
    let row: unknown;
    try {
      row = this.#loadSession.get(id);
    } catch (error) {
      throw storeError(`Session "${id}" could not be read from "${this.#filename}".`, error);
    }
    if (row === undefined || row === null) {
      return null;
    }
    return parseRow(row, id);
  }

  async save(session: Session): Promise<void> {
    this.#assertOpen();
    assertSafeSessionId(session.id);
    const data = toBlob(session.data, session.id);
    const updatedAt = toTimestamp(session.updatedAt, session.id);
    try {
      this.#saveSession.run(session.id, session.provider, data, updatedAt);
    } catch (error) {
      throw storeError(
        `Session "${session.id}" could not be written to "${this.#filename}".`,
        error,
      );
    }
  }

  async clear(id: string): Promise<void> {
    this.#assertOpen();
    assertSafeSessionId(id);
    try {
      this.#clearSession.run(id);
    } catch (error) {
      throw storeError(`Session "${id}" could not be removed from "${this.#filename}".`, error);
    }
  }

  /** Closes the database. Safe to call twice; subsequent operations reject. */
  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    try {
      this.#db.close();
    } catch (error) {
      throw storeError(`Session database "${this.#filename}" could not be closed.`, error);
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new ValidationError(`Session store "${this.#filename}" is closed.`, {
        code: "ERR_SESSION_STORE",
      });
    }
  }
}

/**
 * Converts a stored row into a {@link Session}.
 *
 * Field types are checked before use: `new Date(undefined)` and friends would
 * silently produce `Invalid Date`, which the backend then treats as a
 * credentials timestamp and cannot explain.
 */
function parseRow(raw: unknown, id: string): Session {
  if (typeof raw !== "object" || raw === null) {
    throw corruptRow(id, "row is not an object");
  }
  const row = raw as Partial<SessionRow>;
  if (typeof row.provider !== "string") {
    throw corruptRow(id, "provider is not a string");
  }
  if (!(row.data instanceof Uint8Array)) {
    throw corruptRow(id, "data is not a blob");
  }
  if (typeof row.updated_at !== "number" || !Number.isFinite(row.updated_at)) {
    throw corruptRow(id, "updatedAt is not a number");
  }
  return {
    id,
    provider: row.provider,
    data: row.data,
    updatedAt: new Date(row.updated_at),
  };
}

function toBlob(value: unknown, id: string): Buffer {
  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  throw new ValidationError(`Session "${id}" data must be a Uint8Array.`, {
    code: "ERR_VALIDATION",
  });
}

function toTimestamp(value: unknown, id: string): number {
  if (!(value instanceof Date)) {
    throw new ValidationError(`Session "${id}" updatedAt must be a Date.`, {
      code: "ERR_VALIDATION",
    });
  }
  const milliseconds = value.getTime();
  if (!Number.isFinite(milliseconds)) {
    throw new ValidationError(`Session "${id}" updatedAt is not a valid date.`, {
      code: "ERR_VALIDATION",
    });
  }
  return milliseconds;
}
