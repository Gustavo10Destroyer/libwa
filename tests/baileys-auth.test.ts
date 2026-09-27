import { proto } from "@whiskeysockets/baileys";
import { describe, expect, it, vi } from "vitest";
import { MemorySessionStore } from "../src/auth/MemorySessionStore.js";
import type { Session } from "../src/auth/SessionStore.js";
import { createBaileysAuth } from "../src/backend/baileys/BaileysAuth.js";
import { ValidationError } from "../src/errors/index.js";
import type { Logger } from "../src/logging/Logger.js";

function spyLogger(): Logger & { warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    debug: () => undefined,
    info: () => undefined,
    warn: (...args: unknown[]) => warnings.push(String(args[0])),
    error: () => undefined,
  };
}

function options(store: MemorySessionStore, logger: Logger) {
  return { store, sessionId: "default", provider: "baileys", logger };
}

describe("createBaileysAuth", () => {
  it("initializes fresh credentials when no session exists", async () => {
    const handle = await createBaileysAuth(null, options(new MemorySessionStore(), spyLogger()));
    expect(handle.auth.creds.noiseKey).toBeDefined();
    expect(handle.auth.creds.signedIdentityKey).toBeDefined();
    const preKey = await handle.auth.keys.get("pre-key", ["1"]);
    expect(preKey).toEqual({});
  });

  it("persists and restores credentials and signal keys", async () => {
    const store = new MemorySessionStore();
    const first = await createBaileysAuth(null, options(store, spyLogger()));

    await first.auth.keys.set({
      "pre-key": { "1": { private: new Uint8Array([7, 7]), public: new Uint8Array([8, 8]) } },
    });
    await first.persistCreds();
    await first.flush();

    const saved = await store.load("default");
    expect(saved).not.toBeNull();
    expect(saved?.provider).toBe("baileys");

    const second = await createBaileysAuth(saved, options(store, spyLogger()));
    expect(second.auth.creds.noiseKey.public).toEqual(first.auth.creds.noiseKey.public);
    const restored = await second.auth.keys.get("pre-key", ["1"]);
    expect(restored["1"]).toBeDefined();
    const bytes = restored["1"] as { private?: Uint8Array };
    expect(new Uint8Array(bytes.private ?? new Uint8Array())).toEqual(new Uint8Array([7, 7]));
  });

  it("restores Buffer credential fields after the JSON round-trip", async () => {
    const store = new MemorySessionStore();
    const first = await createBaileysAuth(null, options(store, spyLogger()));
    first.auth.creds.advSecretKey = "abc123";
    await first.persistCreds();
    await first.flush();

    const saved = await store.load("default");
    const second = await createBaileysAuth(saved, options(store, spyLogger()));
    expect(second.auth.creds.advSecretKey).toBe("abc123");
    expect(Buffer.isBuffer(second.auth.creds.noiseKey.public)).toBe(true);
    expect(second.auth.creds.noiseKey.public.length).toBeGreaterThan(0);
  });

  it("coalesces bursts of writes into a single store save", async () => {
    const store = new MemorySessionStore();
    const save = vi.spyOn(store, "save");
    const handle = await createBaileysAuth(null, options(store, spyLogger()));

    for (let i = 0; i < 20; i += 1) {
      void handle.persistCreds();
    }
    await handle.flush();

    expect(save).toHaveBeenCalledTimes(1);
  });

  it("persists when signal keys change", async () => {
    const store = new MemorySessionStore();
    const save = vi.spyOn(store, "save");
    const handle = await createBaileysAuth(null, options(store, spyLogger()));
    await handle.auth.keys.set({
      "pre-key": { "1": { public: new Uint8Array([1]), private: new Uint8Array([1]) } },
    });
    await handle.auth.keys.set({
      "pre-key": { "1": { public: new Uint8Array([2]), private: new Uint8Array([2]) } },
    });
    await handle.flush();
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("supports null-deletes in signal keys", async () => {
    const store = new MemorySessionStore();
    const handle = await createBaileysAuth(null, options(store, spyLogger()));
    await handle.auth.keys.set({
      "pre-key": { "1": { public: new Uint8Array([1]), private: new Uint8Array([1]) } },
    });
    await handle.flush();
    const before = await handle.auth.keys.get("pre-key", ["1"]);
    expect(before["1"]).toBeDefined();

    await handle.auth.keys.set({ "pre-key": { "1": null } });
    await handle.flush();
    const after = await handle.auth.keys.get("pre-key", ["1"]);
    expect(after["1"]).toBeUndefined();
  });

  it("materializes app-state sync keys as protobuf objects", async () => {
    const store = new MemorySessionStore();
    const handle = await createBaileysAuth(null, options(store, spyLogger()));
    const keyData = { keyData: new Uint8Array([1, 2, 3]) };
    await handle.auth.keys.set({ "app-state-sync-key": { AAAA: keyData } });
    await handle.flush();

    // Both the live store and a session reloaded from disk must revive the key.
    const live = await handle.auth.keys.get("app-state-sync-key", ["AAAA"]);
    expect(live.AAAA).toBeInstanceOf(proto.Message.AppStateSyncKeyData);

    const reloaded = await createBaileysAuth(
      await store.load("default"),
      options(store, spyLogger()),
    );
    const restored = await reloaded.auth.keys.get("app-state-sync-key", ["AAAA"]);
    expect(restored.AAAA).toBeInstanceOf(proto.Message.AppStateSyncKeyData);
  });

  it("ignores sessions stored by another provider", async () => {
    const store = new MemorySessionStore();
    await store.save({
      id: "default",
      provider: "other",
      data: new TextEncoder().encode(JSON.stringify({ v: 1, creds: { fake: true } })),
      updatedAt: new Date(),
    });
    const logger = spyLogger();
    const handle = await createBaileysAuth(await store.load("default"), options(store, logger));
    expect(logger.warnings.join(" ")).toContain('provider "other"');
    expect(handle.auth.creds.noiseKey).toBeDefined();
  });

  it("rejects corrupt stored sessions", async () => {
    const store = new MemorySessionStore();
    const session: Session = {
      id: "default",
      provider: "baileys",
      data: new TextEncoder().encode("{not json"),
      updatedAt: new Date(),
    };
    await expect(createBaileysAuth(session, options(store, spyLogger()))).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("rejects unsupported session formats", async () => {
    const store = new MemorySessionStore();
    const session: Session = {
      id: "default",
      provider: "baileys",
      data: new TextEncoder().encode(JSON.stringify({ v: 999, creds: {}, keys: {} })),
      updatedAt: new Date(),
    };
    await expect(createBaileysAuth(session, options(store, spyLogger()))).rejects.toMatchObject({
      code: "ERR_VALIDATION",
    });
  });

  it("rejects sessions without credentials", async () => {
    const store = new MemorySessionStore();
    const session: Session = {
      id: "default",
      provider: "baileys",
      data: new TextEncoder().encode(JSON.stringify({ v: 1, keys: {} })),
      updatedAt: new Date(),
    };
    await expect(createBaileysAuth(session, options(store, spyLogger()))).rejects.toThrow(
      /missing credentials/,
    );
  });
});
