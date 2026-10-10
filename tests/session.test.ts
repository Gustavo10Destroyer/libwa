import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileSessionStore } from "../src/auth/FileSessionStore.js";
import { MemorySessionStore } from "../src/auth/MemorySessionStore.js";
import type { Session } from "../src/auth/SessionStore.js";
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

describe("MemorySessionStore", () => {
  it("round-trips sessions", async () => {
    const store = new MemorySessionStore();
    expect(await store.load("default")).toBeNull();
    const value = session("default");
    await store.save(value);
    expect(await store.load("default")).toBe(value);
  });

  it("clears sessions without erroring on misses", async () => {
    const store = new MemorySessionStore();
    await store.save(session("a"));
    await store.clear("a");
    await store.clear("missing");
    expect(await store.load("a")).toBeNull();
  });

  it("keeps slots independent", async () => {
    const store = new MemorySessionStore();
    await store.save(session("one"));
    await store.save(session("two", { data: new Uint8Array([9]) }));
    expect((await store.load("one"))?.data).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect((await store.load("two"))?.data).toEqual(new Uint8Array([9]));
  });
});

describe("FileSessionStore", () => {
  let directory: string;
  let store: FileSessionStore;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "libwa.js-sessions-"));
    store = new FileSessionStore({ directory });
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("exposes its directory", () => {
    expect(store.directory).toBe(directory);
    expect(new FileSessionStore().directory).toBe(".libwa.js");
  });

  it("round-trips sessions through JSON files", async () => {
    const value = session("bot");
    await store.save(value);
    const loaded = await store.load("bot");
    expect(loaded).not.toBeNull();
    expect(loaded?.id).toBe("bot");
    expect(loaded?.provider).toBe("baileys");
    expect(new Uint8Array(loaded?.data ?? new Uint8Array())).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(loaded?.updatedAt).toEqual(new Date("2026-01-01T00:00:00.000Z"));

    const raw = JSON.parse(await readFile(join(directory, "bot.json"), "utf8")) as {
      provider: string;
      data: string;
    };
    expect(raw.provider).toBe("baileys");
    expect(raw.data).toBe(Buffer.from([1, 2, 3, 4]).toString("base64"));
  });

  it("returns null for missing sessions", async () => {
    expect(await store.load("nope")).toBeNull();
  });

  it("clears sessions and tolerates misses", async () => {
    await store.save(session("bot"));
    await store.clear("bot");
    expect(await store.load("bot")).toBeNull();
    await store.clear("bot");
  });

  it("rejects unsafe session ids", async () => {
    await expect(store.load("../escape")).rejects.toBeInstanceOf(ValidationError);
    await expect(store.save(session("has space"))).rejects.toBeInstanceOf(ValidationError);
    await expect(store.clear("")).rejects.toBeInstanceOf(ValidationError);
  });

  it("reports corrupt session files", async () => {
    await writeFile(join(directory, "bad.json"), "{not json", "utf8");
    await expect(store.load("bad")).rejects.toMatchObject({ code: "ERR_SESSION_CORRUPT" });
  });

  it("reports non-object session files as corrupt", async () => {
    await writeFile(join(directory, "nullish.json"), "null", "utf8");
    await expect(store.load("nullish")).rejects.toMatchObject({ code: "ERR_SESSION_CORRUPT" });
  });

  it("reports wrong-typed session fields as corrupt instead of throwing a TypeError", async () => {
    const malformed = JSON.stringify({
      provider: "baileys",
      data: 42,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await writeFile(join(directory, "typed.json"), malformed, "utf8");
    await expect(store.load("typed")).rejects.toMatchObject({ code: "ERR_SESSION_CORRUPT" });
    await expect(store.load("typed")).rejects.toBeInstanceOf(ValidationError);
  });

  it("reports an unparseable updatedAt as corrupt", async () => {
    await writeFile(
      join(directory, "date.json"),
      JSON.stringify({ provider: "baileys", data: "AQID", updatedAt: "not a date" }),
      "utf8",
    );
    await expect(store.load("date")).rejects.toMatchObject({ code: "ERR_SESSION_CORRUPT" });
  });

  it("fails on an unreadable session file instead of reporting no session", async () => {
    // A directory at the session path makes readFile fail with EISDIR: only
    // ENOENT may be translated into "no session".
    await mkdir(join(directory, "blocked.json"));
    await expect(store.load("blocked")).rejects.toMatchObject({
      code: "ERR_SESSION_UNREADABLE",
    });
    await expect(store.load("blocked")).rejects.toBeInstanceOf(ValidationError);
    expect(await store.load("nope")).toBeNull();
  });

  it("keeps concurrent writers from different stores from tearing the file", async () => {
    const other = new FileSessionStore({ directory });
    for (let round = 0; round < 5; round += 1) {
      const short = session("bot", { data: new Uint8Array([round]) });
      const long = session("bot", { data: new Uint8Array(4096).fill(round + 1) });
      await Promise.all([store.save(short), other.save(long)]);
      const loaded = await store.load("bot");
      expect(loaded).not.toBeNull();
      expect(loaded?.data.length).toBeGreaterThan(0);
    }
  });

  it("serializes concurrent writes to the same slot", async () => {
    const first = store.save(session("bot", { data: new Uint8Array([1]) }));
    const second = store.save(session("bot", { data: new Uint8Array([2]) }));
    await Promise.all([first, second]);
    const loaded = await store.load("bot");
    expect(new Uint8Array(loaded?.data ?? new Uint8Array())).toEqual(new Uint8Array([2]));
  });
});
