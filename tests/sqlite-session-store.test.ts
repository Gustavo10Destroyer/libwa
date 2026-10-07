import { mkdtemp, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileSessionStore } from "../src/auth/FileSessionStore.js";
import { MemorySessionStore } from "../src/auth/MemorySessionStore.js";
import type { Session, SessionStore } from "../src/auth/SessionStore.js";
import { SqliteSessionStore } from "../src/auth/SqliteSessionStore.js";
import { resolveDriver } from "../src/auth/sqliteDriver.js";
import { ValidationError } from "../src/errors/index.js";

function session(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    provider: "baileys",
    data: new Uint8Array([1, 2, 3, 4]),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

/** The driver as the tests need it — opened beside the store under test. */
interface RawDatabase {
  prepare(sql: string): {
    get(...params: readonly unknown[]): unknown;
    run(...params: readonly unknown[]): unknown;
  };
  exec(sql: string): void;
  close(): void;
}

function openRaw(filename: string): RawDatabase {
  const require = createRequire(import.meta.url);
  const Database = require("better-sqlite3") as new (path: string) => RawDatabase;
  return new Database(filename);
}

async function rejectsCode(promise: Promise<unknown>, code: string): Promise<void> {
  const error: unknown = await promise.then(
    () => new Error(`expected a rejection carrying ${code}`),
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(ValidationError);
  expect((error as ValidationError).code).toBe(code);
}

function throwsCode(run: () => unknown, code: string): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ValidationError);
  expect((caught as ValidationError).code).toBe(code);
}

describe("SqliteSessionStore", () => {
  let directory: string;
  const opened: SqliteSessionStore[] = [];

  function openStore(options: { filename?: string; busyTimeoutMs?: number } = {}) {
    const store = new SqliteSessionStore({ filename: join(directory, "sessions.db"), ...options });
    opened.push(store);
    return store;
  }

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "libwa-sqlite-"));
  });

  afterEach(async () => {
    for (const store of opened.splice(0)) {
      store.close();
    }
    await rm(directory, { recursive: true, force: true });
  });

  it("satisfies the SessionStore contract, close included", () => {
    const store: SessionStore = openStore();
    expect(typeof store.load).toBe("function");
    expect(typeof store.save).toBe("function");
    expect(typeof store.clear).toBe("function");
    expect(typeof store.close).toBe("function");
    const memory: SessionStore = new MemorySessionStore();
    const file: SessionStore = new FileSessionStore({ directory });
    expect(typeof memory.close).toBe("undefined");
    expect(typeof file.close).toBe("undefined");
  });

  it("round-trips sessions", async () => {
    const store = openStore();
    expect(await store.load("default")).toBeNull();

    const value = session("default");
    await store.save(value);
    const loaded = await store.load("default");
    expect(loaded?.id).toBe("default");
    expect(loaded?.provider).toBe("baileys");
    expect(new Uint8Array(loaded?.data ?? new Uint8Array())).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(loaded?.updatedAt.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("overwrites a slot instead of appending", async () => {
    const store = openStore();
    await store.save(session("default"));
    await store.save(session("default", { provider: "other", data: new Uint8Array([9]) }));

    const raw = openRaw(join(directory, "sessions.db"));
    const count = raw.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number };
    raw.close();
    expect(count.n).toBe(1);
    expect((await store.load("default"))?.provider).toBe("other");
  });

  it("clears slots without erroring on misses", async () => {
    const store = openStore();
    await store.save(session("a"));
    await store.clear("a");
    await store.clear("missing");
    expect(await store.load("a")).toBeNull();
  });

  it("keeps slots independent", async () => {
    const store = openStore();
    await store.save(session("one"));
    await store.save(session("two", { data: new Uint8Array([9]) }));
    const one = await store.load("one");
    const two = await store.load("two");
    expect(new Uint8Array(one?.data ?? new Uint8Array())).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(new Uint8Array(two?.data ?? new Uint8Array())).toEqual(new Uint8Array([9]));
  });

  it("shares one database file between store instances", async () => {
    const filename = join(directory, "shared.db");
    const first = new SqliteSessionStore({ filename });
    await first.save(session("prod"));
    first.close();

    const second = new SqliteSessionStore({ filename });
    opened.push(second);
    expect((await second.load("prod"))?.provider).toBe("baileys");
  });

  it("survives many sequential writes to one slot", async () => {
    const store = openStore();
    for (let i = 0; i < 25; i += 1) {
      await store.save(session("hot", { data: new Uint8Array([i]) }));
    }
    const hot = await store.load("hot");
    expect(new Uint8Array(hot?.data ?? new Uint8Array())).toEqual(new Uint8Array([24]));
  });

  it("accepts concurrent saves for the same slot", async () => {
    const store = openStore();
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        store.save(session("race", { data: new Uint8Array([i]) })),
      ),
    );
    const loaded = await store.load("race");
    expect(new Uint8Array(loaded?.data ?? new Uint8Array())).toEqual(new Uint8Array([19]));
  });

  it("creates missing parent directories", async () => {
    const filename = join(directory, "nested", "deeper", "bot.db");
    const store = new SqliteSessionStore({ filename });
    opened.push(store);
    await store.save(session("default"));
    expect((await stat(filename)).isFile()).toBe(true);
  });

  it("keeps an in-memory database out of the filesystem", async () => {
    const store = new SqliteSessionStore({ filename: ":memory:" });
    opened.push(store);
    await store.save(session("default"));
    expect(store.filename).toBe(":memory:");
    const loaded = await store.load("default");
    expect(new Uint8Array(loaded?.data ?? new Uint8Array())).toEqual(new Uint8Array([1, 2, 3, 4]));
    await expect(stat(join(directory, ":memory:"))).rejects.toThrow(/no such file or directory/);
  });

  it("applies WAL and stamps the schema version", async () => {
    const filename = join(directory, "wal.db");
    const store = new SqliteSessionStore({ filename });
    opened.push(store);

    const raw = openRaw(filename);
    const journal = raw.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    const version = raw.prepare("PRAGMA user_version").get() as { user_version: number };
    raw.close();

    expect(journal.journal_mode).toBe("wal");
    expect(version.user_version).toBe(1);
  });

  it("gives up on a locked database instead of hanging", async () => {
    const filename = join(directory, "locked.db");
    const store = new SqliteSessionStore({ filename, busyTimeoutMs: 100 });
    opened.push(store);

    // A second connection holds the write lock, as another bot process would.
    const blocker = openRaw(filename);
    blocker.exec("BEGIN IMMEDIATE");
    try {
      await rejectsCode(store.save(session("blocked")), "ERR_SESSION_STORE");
    } finally {
      blocker.exec("ROLLBACK");
      blocker.close();
    }
    await store.save(session("blocked"));
    expect((await store.load("blocked"))?.provider).toBe("baileys");
  });

  it("exposes filename and closed state", () => {
    const filename = join(directory, "meta.db");
    const store = new SqliteSessionStore({ filename });
    expect(store.filename).toBe(filename);
    expect(store.closed).toBe(false);
    store.close();
    expect(store.closed).toBe(true);
    store.close(); // idempotent
    expect(store.closed).toBe(true);
  });

  it("rejects unsafe session ids on every operation", async () => {
    const store = openStore();
    for (const id of ["", "../escape", "a b", "x".repeat(65)]) {
      await rejectsCode(store.load(id), "ERR_SESSION_ID");
      await rejectsCode(store.save(session(id)), "ERR_SESSION_ID");
      await rejectsCode(store.clear(id), "ERR_SESSION_ID");
    }
  });

  it("rejects a payload the store cannot represent", async () => {
    const store = openStore();
    await rejectsCode(
      store.save(session("bad", { data: "nope" as unknown as Uint8Array })),
      "ERR_VALIDATION",
    );
    await rejectsCode(
      store.save(session("bad", { updatedAt: new Date(Number.NaN) })),
      "ERR_VALIDATION",
    );
    await rejectsCode(
      store.save(session("bad", { updatedAt: "today" as unknown as Date })),
      "ERR_VALIDATION",
    );
  });

  it("reports a row it cannot parse instead of restarting the login", async () => {
    const filename = join(directory, "corrupt.db");
    const writer = new SqliteSessionStore({ filename });
    await writer.save(session("x"));
    writer.close();

    const raw = openRaw(filename);
    raw.exec("UPDATE sessions SET updated_at = 'nope' WHERE id = 'x'");
    raw.close();

    const reader = new SqliteSessionStore({ filename });
    opened.push(reader);
    await rejectsCode(reader.load("x"), "ERR_SESSION_CORRUPT");
  });

  it("reports a database it cannot open", () => {
    throwsCode(() => new SqliteSessionStore({ filename: directory }), "ERR_SESSION_STORE");
  });

  it("refuses a database written by a newer libwa", async () => {
    const filename = join(directory, "future.db");
    const store = new SqliteSessionStore({ filename });
    await store.save(session("default"));
    store.close();

    const raw = openRaw(filename);
    raw.exec("PRAGMA user_version = 99");
    raw.close();

    throwsCode(() => new SqliteSessionStore({ filename }), "ERR_SESSION_STORE");
  });

  it("validates its own options", () => {
    throwsCode(() => new SqliteSessionStore({ filename: "" }), "ERR_SESSION_STORE");
    throwsCode(() => new SqliteSessionStore({ busyTimeoutMs: -1 }), "ERR_SESSION_STORE");
    throwsCode(() => new SqliteSessionStore({ busyTimeoutMs: 1.5 }), "ERR_SESSION_STORE");
  });

  it("refuses to work after close", async () => {
    const store = openStore();
    await store.save(session("default"));
    store.close();

    await rejectsCode(store.load("default"), "ERR_SESSION_STORE");
    await rejectsCode(store.save(session("default")), "ERR_SESSION_STORE");
    await rejectsCode(store.clear("default"), "ERR_SESSION_STORE");
  });

  it("is closed through the optional contract, not a concrete type", async () => {
    const store = openStore();
    const stores: SessionStore[] = [
      new MemorySessionStore(),
      new FileSessionStore({ directory }),
      store,
    ];
    for (const candidate of stores) {
      await candidate.close?.();
    }
    expect(store.closed).toBe(true);
  });

  it("reports a database that stops answering", async () => {
    const filename = join(directory, "dropped.db");
    const store = new SqliteSessionStore({ filename });
    opened.push(store);
    await store.save(session("default"));

    const raw = openRaw(filename);
    raw.exec("DROP TABLE sessions");
    raw.close();

    await rejectsCode(store.load("default"), "ERR_SESSION_STORE");
    await rejectsCode(store.save(session("default")), "ERR_SESSION_STORE");
    await rejectsCode(store.clear("default"), "ERR_SESSION_STORE");
  });

  it("reports every shape of row it cannot parse", async () => {
    const filename = join(directory, "shapes.db");
    const store = new SqliteSessionStore({ filename });
    opened.push(store);
    await store.save(session("seed"));
    store.close();

    const raw = openRaw(filename);
    raw.exec(
      "INSERT INTO sessions (id, provider, data, updated_at) VALUES ('blob', x'4142', x'01', 1)",
    );
    raw.exec(
      "INSERT INTO sessions (id, provider, data, updated_at) VALUES ('int', 'baileys', 42, 1)",
    );
    raw.close();

    const reader = new SqliteSessionStore({ filename });
    opened.push(reader);
    await rejectsCode(reader.load("blob"), "ERR_SESSION_CORRUPT");
    await rejectsCode(reader.load("int"), "ERR_SESSION_CORRUPT");
    expect(await reader.load("seed")).not.toBeNull();
  });

  it("narrows a required module to a driver", () => {
    function Driver(): void {}
    expect(resolveDriver(Driver)).toBe(Driver);
    throwsCode(() => resolveDriver({}), "ERR_SESSION_STORE");
    throwsCode(() => resolveDriver({ default: 42 }), "ERR_SESSION_STORE");
    throwsCode(() => resolveDriver("better-sqlite3"), "ERR_SESSION_STORE");

    // The message is what an operator sees when the binding is missing.
    let caught: unknown;
    try {
      resolveDriver({});
    } catch (error) {
      caught = error;
    }
    const failure = caught as ValidationError;
    expect(failure.message).toMatch(/needs the "better-sqlite3" driver that ships with libwa/);
    expect(failure.message).toMatch(/--ignore-scripts/);
    expect((failure.cause as Error).message).toMatch(/does not export a Database constructor/);
  });

  it("is reachable from the package root", async () => {
    const root = await import("../src/index.js");
    expect(root.SqliteSessionStore).toBe(SqliteSessionStore);
  });
});
