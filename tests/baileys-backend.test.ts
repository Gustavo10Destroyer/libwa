import { type Mock, beforeEach, describe, expect, it, vi } from "vitest";
import { MemorySessionStore } from "../src/auth/MemorySessionStore.js";
import type {
  BackendConnectOptions,
  BackendSendMessage,
  WhatsAppBackend,
} from "../src/backend/Backend.js";
import { createBaileysBackend } from "../src/backend/baileys/BaileysBackend.js";
import type { BackendConnectionUpdate, BackendMessageEvent } from "../src/backend/events.js";
import { DisconnectReason } from "../src/core/DisconnectReason.js";
import { ConnectionError, NotFoundError, PermissionError } from "../src/errors/index.js";
import type { Logger } from "../src/logging/Logger.js";

interface FakeEmitter {
  on(event: string, listener: (arg: unknown) => void): void;
  off(event: string, listener: (arg: unknown) => void): void;
  emit(event: string, arg: unknown): void;
  listenerCount(event: string): number;
}

interface FakeSocket {
  readonly ev: FakeEmitter;
  user: { id: string; notify?: string | undefined; name?: string | undefined } | undefined;
  end: Mock;
  logout: Mock;
  requestPairingCode: Mock;
  sendMessage: Mock;
  groupMetadata: Mock;
  groupParticipantsUpdate: Mock;
  groupUpdateSubject: Mock;
  groupUpdateDescription: Mock;
}

/** The options `makeWASocket` receives — the only handle a test has on them. */
interface FakeConnectConfig {
  readonly auth: unknown;
  readonly browser: string[];
  readonly logger: unknown;
  readonly cachedGroupMetadata: (jid: string) => Promise<unknown>;
  readonly getMessage: (key: unknown) => Promise<unknown>;
}

const SELF_JID = "5511888888888@s.whatsapp.net";

/**
 * `createBackend()` is typed against the interface, where every
 * capability past send/download/metadata is optional. The Baileys adapter
 * implements them all, and these tests call them directly instead of
 * asserting presence first.
 */
type BaileysBackendSurface = WhatsAppBackend &
  Required<
    Pick<
      WhatsAppBackend,
      | "updateGroupParticipants"
      | "updateGroupName"
      | "updateGroupDescription"
      | "requestPairingCode"
      | "logout"
    >
  >;

function createBackend(): BaileysBackendSurface {
  return createBaileysBackend() as BaileysBackendSurface;
}

const h = vi.hoisted(() => ({
  sockets: [] as unknown as FakeSocket[],
  configs: [] as unknown as FakeConnectConfig[],
  registered: false,
  /** How many of the next `requestPairingCode` calls should fail. */
  pairingFailures: 0,
}));

vi.mock("@whiskeysockets/baileys", () => {
  const createSocket = (): FakeSocket => {
    const listeners = new Map<string, Set<(arg: unknown) => void>>();
    const ev: FakeEmitter = {
      on(event, listener) {
        let bucket = listeners.get(event);
        if (bucket === undefined) {
          bucket = new Set();
          listeners.set(event, bucket);
        }
        bucket.add(listener);
      },
      off(event, listener) {
        listeners.get(event)?.delete(listener);
      },
      emit(event, arg) {
        for (const listener of [...(listeners.get(event) ?? [])]) listener(arg);
      },
      listenerCount(event) {
        return listeners.get(event)?.size ?? 0;
      },
    };

    return {
      ev,
      user: { id: SELF_JID, notify: "Bot", name: "Bot" },
      end: vi.fn(async () => undefined),
      logout: vi.fn(async () => undefined),
      requestPairingCode: vi.fn(async () => {
        if (h.pairingFailures > 0) {
          h.pairingFailures -= 1;
          throw new Error("provider said no");
        }
        return "ABCD-EFGH";
      }),
      sendMessage: vi.fn(async () => ({
        key: { id: "OUT-1", remoteJid: "111@s.whatsapp.net", fromMe: true },
        messageTimestamp: 1_700_000_000,
      })),
      groupMetadata: vi.fn(async (chatId: string) => ({
        id: chatId,
        subject: "Provider Group",
        desc: "provider description",
        participants: [{ id: SELF_JID, admin: "superadmin" }],
        announce: false,
        restrict: false,
      })),
      groupParticipantsUpdate: vi.fn(async () => [{ jid: "222@s.whatsapp.net", status: "200" }]),
      groupUpdateSubject: vi.fn(async () => undefined),
      groupUpdateDescription: vi.fn(async () => undefined),
    };
  };

  return {
    makeWASocket: (config: Record<string, unknown>) => {
      h.configs.push(config as unknown as FakeConnectConfig);
      const socket = createSocket();
      h.sockets.push(socket);
      return socket;
    },
    downloadMediaMessage: vi.fn(async () => new Uint8Array([9, 9, 9])),
    jidNormalizedUser: (jid: string): string => {
      const at = jid.indexOf("@");
      if (at < 0) return jid;
      const user = jid.slice(0, at).split(":")[0] ?? "";
      return `${user}${jid.slice(at)}`;
    },
    WAMessageStubType: { REVOKE: 0 },
    // Real provider codes: BaileysDisconnect builds its map at module load.
    DisconnectReason: {
      connectionClosed: 400,
      connectionLost: 408,
      connectionReplaced: 440,
      loggedOut: 401,
      badSession: 500,
      restartRequired: 515,
      multideviceMismatch: 411,
      forbidden: 403,
      unavailableService: 503,
    },
    BufferJSON: {
      replacer: (_key: string, value: unknown) => value,
      reviver: (_key: string, value: unknown) => value,
    },
    initAuthCreds: () => ({
      registered: h.registered,
      me: h.registered ? { id: SELF_JID, name: "Bot" } : undefined,
    }),
    proto: {
      Message: { AppStateSyncKeyData: { fromObject: (value: unknown) => value } },
    },
  };
});

function createLogger(): { logger: Logger; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  const logger: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn,
    error: vi.fn(),
  };
  return { logger, warn };
}

function connectOptions(overrides: Partial<BackendConnectOptions> = {}): BackendConnectOptions {
  const { logger } = createLogger();
  return {
    sessionId: "default",
    sessionStore: new MemorySessionStore(),
    logger,
    pairingPhoneNumber: undefined,
    ...overrides,
  };
}

function record(backend: WhatsAppBackend): BackendConnectionUpdate[] {
  const updates: BackendConnectionUpdate[] = [];
  backend.on("connection", (update) => {
    updates.push(update);
  });
  return updates;
}

/** Lets the pairing-code promise chain (and anything else queued) settle. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  h.sockets.length = 0;
  h.configs.length = 0;
  h.registered = false;
  h.pairingFailures = 0;
});

describe("BaileysBackend lifecycle", () => {
  it("reports connecting on connect and open once the provider opens", async () => {
    const backend = createBackend();
    const updates = record(backend);

    await backend.connect(connectOptions());

    expect(h.configs).toHaveLength(1);
    expect(updates.map((update) => update.status)).toEqual(["connecting"]);
    expect(backend.isConnected()).toBe(false);

    h.sockets[0]?.ev.emit("connection.update", { connection: "open" });

    expect(backend.isConnected()).toBe(true);
    expect(updates.at(-1)).toMatchObject({
      status: "open",
      me: { id: SELF_JID, name: "Bot" },
    });
  });

  it("hands the provider a session-backed auth state and cache hooks", async () => {
    const backend = createBackend();
    await backend.connect(connectOptions());

    const config = h.configs[0];
    expect(config?.auth).toBeDefined();
    expect(config?.cachedGroupMetadata).toBeTypeOf("function");
    expect(config?.getMessage).toBeTypeOf("function");
    expect(config?.browser).toEqual(["libwa.js", "1.0.0", "1"]);
  });

  it("maps a provider close onto a library disconnect reason", async () => {
    const backend = createBackend();
    const updates = record(backend);
    await backend.connect(connectOptions());

    const error = Object.assign(new Error("Connection Closed"), {
      output: { statusCode: 401 },
    });
    h.sockets[0]?.ev.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error },
    });

    expect(backend.isConnected()).toBe(false);
    expect(updates.at(-1)).toMatchObject({
      status: "close",
      reason: DisconnectReason.LoggedOut,
      detail: "Connection Closed",
    });
  });

  it("abandons a connect that a disconnect raced past (M6)", async () => {
    const store = new MemorySessionStore();
    const load = store.load.bind(store);
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(store, "load").mockImplementation(async (id) => {
      await gate;
      return load(id);
    });

    const backend = createBackend();
    const updates = record(backend);
    const connecting = backend.connect(connectOptions({ sessionStore: store }));

    await backend.disconnect();
    release();
    await connecting;

    expect(h.configs).toHaveLength(0);
    expect(updates).toEqual([]);
    expect(backend.isConnected()).toBe(false);
  });

  it("detaches provider listeners on disconnect so stale sockets go quiet", async () => {
    const backend = createBackend();
    const updates = record(backend);
    await backend.connect(connectOptions());
    const socket = h.sockets[0];
    expect(socket?.ev.listenerCount("connection.update")).toBe(1);

    socket?.ev.emit("connection.update", { connection: "open" });
    expect(backend.isConnected()).toBe(true);

    await backend.disconnect();
    expect(backend.isConnected()).toBe(false);
    expect(socket?.ev.listenerCount("connection.update")).toBe(0);

    const seen = updates.length;
    socket?.ev.emit("connection.update", { connection: "open" });
    expect(updates).toHaveLength(seen);
    expect(backend.isConnected()).toBe(false);
  });

  it("ends the provider socket when reconnecting", async () => {
    const backend = createBackend();
    await backend.connect(connectOptions());
    const first = h.sockets[0];

    await backend.connect(connectOptions());

    expect(first?.end).toHaveBeenCalled();
    expect(h.sockets).toHaveLength(2);
    expect(h.sockets[1]).not.toBe(first);
    expect(first?.ev.listenerCount("connection.update")).toBe(0);
  });

  it("logs out through the provider and tears the socket down", async () => {
    const backend = createBackend();
    await backend.connect(connectOptions());
    const socket = h.sockets[0];
    socket?.ev.emit("connection.update", { connection: "open" });
    expect(backend.isConnected()).toBe(true);

    await backend.logout();

    expect(socket?.logout).toHaveBeenCalledTimes(1);
    expect(socket?.ev.listenerCount("connection.update")).toBe(0);
    expect(backend.isConnected()).toBe(false);

    await expect(backend.logout()).resolves.toBeUndefined();
  });

  it("rejects provider calls made before any socket exists", async () => {
    const backend = createBackend();
    const request: BackendSendMessage = {
      chatId: "111@s.whatsapp.net",
      content: { kind: "text", text: "hi" },
      replyToMessageId: undefined,
      mentionUserIds: [],
    };
    await expect(backend.sendMessage(request)).rejects.toBeInstanceOf(ConnectionError);
    await expect(backend.getGroupMetadata("1@g.us")).rejects.toBeInstanceOf(ConnectionError);
    await expect(backend.requestPairingCode("5511999999999")).rejects.toBeInstanceOf(
      ConnectionError,
    );
  });
});

describe("BaileysBackend messaging", () => {
  it("sends text and returns a normalized confirmation", async () => {
    const backend = createBackend();
    await backend.connect(connectOptions());

    const sent = await backend.sendMessage({
      chatId: "111@s.whatsapp.net",
      content: { kind: "text", text: "hello" },
      replyToMessageId: undefined,
      mentionUserIds: [],
    });

    expect(sent).toMatchObject({
      id: "OUT-1",
      chatId: "111@s.whatsapp.net",
      chatKind: "direct",
    });
    expect(h.sockets[0]?.sendMessage).toHaveBeenCalledWith(
      "111@s.whatsapp.net",
      { text: "hello" },
      {},
    );
  });

  it("wraps provider send failures as MessageError", async () => {
    const backend = createBackend();
    await backend.connect(connectOptions());
    h.sockets[0]?.sendMessage.mockRejectedValueOnce(new Error("boom"));

    await expect(
      backend.sendMessage({
        chatId: "111@s.whatsapp.net",
        content: { kind: "text", text: "hello" },
        replyToMessageId: undefined,
        mentionUserIds: [],
      }),
    ).rejects.toMatchObject({ name: "MessageError" });
  });

  it("surfaces an unconfirmed send as MessageError", async () => {
    const backend = createBackend();
    await backend.connect(connectOptions());
    h.sockets[0]?.sendMessage.mockResolvedValueOnce(undefined);

    await expect(
      backend.sendMessage({
        chatId: "111@s.whatsapp.net",
        content: { kind: "text", text: "hello" },
        replyToMessageId: undefined,
        mentionUserIds: [],
      }),
    ).rejects.toMatchObject({ name: "MessageError" });
  });

  it("emits normalized message events from the provider stream", async () => {
    const backend = createBackend();
    const messages: BackendMessageEvent[] = [];
    backend.on("message", (event) => messages.push(event));
    await backend.connect(connectOptions());

    h.sockets[0]?.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { remoteJid: "111@s.whatsapp.net", fromMe: false, id: "IN-1" },
          message: { conversation: "hi" },
          messageTimestamp: 1_700_000_000,
          pushName: "Alice",
        },
      ],
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      chatId: "111@s.whatsapp.net",
      id: "IN-1",
      authorName: "Alice",
      content: { kind: "text", text: "hi" },
      isFromMe: false,
    });
  });

  it("ignores history backfills and stale generations", async () => {
    const backend = createBackend();
    const messages: BackendMessageEvent[] = [];
    backend.on("message", (event) => messages.push(event));
    await backend.connect(connectOptions());
    const socket = h.sockets[0];

    socket?.ev.emit("messages.upsert", {
      type: "append",
      messages: [
        { key: { remoteJid: "111@s.whatsapp.net", fromMe: false, id: "OLD" }, message: {} },
      ],
    });
    expect(messages).toHaveLength(0);

    await backend.disconnect();
    socket?.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { remoteJid: "111@s.whatsapp.net", fromMe: false, id: "STALE" },
          message: { conversation: "late" },
        },
      ],
    });
    expect(messages).toHaveLength(0);
  });
});

describe("BaileysBackend group metadata", () => {
  it("fetches metadata and feeds the provider cache hook", async () => {
    const backend = createBackend();
    await backend.connect(connectOptions());
    const config = h.configs[0];

    const metadata = await backend.getGroupMetadata("1@g.us");

    expect(metadata.name).toBe("Provider Group");
    expect(metadata.description).toBe("provider description");
    expect(metadata.participants).toHaveLength(1);

    expect(await config?.cachedGroupMetadata?.("1@g.us")).toMatchObject({
      subject: "Provider Group",
    });
  });

  it("caches metadata announced by groups.upsert", async () => {
    const backend = createBackend();
    await backend.connect(connectOptions());
    const config = h.configs[0];

    h.sockets[0]?.ev.emit("groups.upsert", [
      { id: "2@g.us", subject: "Announced", participants: [] },
    ]);

    expect(await config?.cachedGroupMetadata?.("2@g.us")).toMatchObject({
      subject: "Announced",
    });
    expect(await config?.cachedGroupMetadata?.("missing@g.us")).toBeUndefined();
  });

  it("translates provider status codes into typed errors", async () => {
    const backend = createBackend();
    await backend.connect(connectOptions());

    h.sockets[0]?.groupMetadata.mockRejectedValueOnce(
      Object.assign(new Error("not found"), { output: { statusCode: 404 } }),
    );
    await expect(backend.getGroupMetadata("gone@g.us")).rejects.toBeInstanceOf(NotFoundError);

    h.sockets[0]?.groupMetadata.mockRejectedValueOnce(
      Object.assign(new Error("forbidden"), { output: { statusCode: 403 } }),
    );
    await expect(backend.getGroupMetadata("secret@g.us")).rejects.toBeInstanceOf(PermissionError);
  });

  it("reports a fully rejected participant update", async () => {
    const backend = createBackend();
    await backend.connect(connectOptions());
    h.sockets[0]?.groupParticipantsUpdate.mockResolvedValueOnce([
      { jid: "222@s.whatsapp.net", status: "403" },
    ]);

    await expect(
      backend.updateGroupParticipants({
        chatId: "1@g.us",
        userIds: ["222@s.whatsapp.net"],
        action: "add",
      }),
    ).rejects.toBeInstanceOf(PermissionError);
  });

  it("renames and rewrites descriptions through the provider", async () => {
    const backend = createBackend();
    await backend.connect(connectOptions());

    await backend.updateGroupName({ chatId: "1@g.us", name: "Renamed" });
    await backend.updateGroupDescription({ chatId: "1@g.us", description: "New desc" });

    expect(h.sockets[0]?.groupUpdateSubject).toHaveBeenCalledWith("1@g.us", "Renamed");
    expect(h.sockets[0]?.groupUpdateDescription).toHaveBeenCalledWith("1@g.us", "New desc");
  });
});

describe("BaileysBackend pairing", () => {
  it("starts automatic pairing as soon as an unregistered session connects", async () => {
    const backend = createBackend();
    const updates = record(backend);
    await backend.connect(connectOptions({ pairingPhoneNumber: "5511999999999" }));
    const socket = h.sockets[0];

    expect(socket?.requestPairingCode).toHaveBeenCalledTimes(1);
    expect(socket?.requestPairingCode).toHaveBeenCalledWith("5511999999999");
    await tick();
    expect(updates.some((update) => update.pairingCode === "ABCD-EFGH")).toBe(true);

    // A later QR must not stack a second request on the in-flight one.
    socket?.ev.emit("connection.update", { qr: "qr-payload" });
    await tick();
    expect(socket?.requestPairingCode).toHaveBeenCalledTimes(1);
    expect(updates.at(-1)).toMatchObject({ status: "connecting", qr: "qr-payload" });
  });

  it("re-arms automatic pairing after a failed request (M11)", async () => {
    h.pairingFailures = 1;
    const { logger, warn } = createLogger();
    const backend = createBackend();
    const updates = record(backend);
    await backend.connect(connectOptions({ pairingPhoneNumber: "5511999999999", logger }));
    const socket = h.sockets[0];
    await tick();

    expect(socket?.requestPairingCode).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    expect(updates.some((update) => update.pairingCode !== undefined)).toBe(false);

    socket?.ev.emit("connection.update", { qr: "qr-payload" });
    await tick();
    expect(socket?.requestPairingCode).toHaveBeenCalledTimes(2);
    expect(updates.some((update) => update.pairingCode === "ABCD-EFGH")).toBe(true);
  });

  it("does not auto-pair a session that is already registered", async () => {
    h.registered = true;
    const backend = createBackend();
    await backend.connect(connectOptions({ pairingPhoneNumber: "5511999999999" }));
    const socket = h.sockets[0];

    socket?.ev.emit("connection.update", { qr: "qr-payload" });
    await tick();

    expect(socket?.requestPairingCode).not.toHaveBeenCalled();
  });

  it("does not auto-pair without a configured phone number", async () => {
    const backend = createBackend();
    await backend.connect(connectOptions());
    const socket = h.sockets[0];

    socket?.ev.emit("connection.update", { qr: "qr-payload" });
    await tick();

    expect(socket?.requestPairingCode).not.toHaveBeenCalled();
  });

  it("returns an explicitly requested code and re-arms after a failure", async () => {
    const backend = createBackend();
    const updates = record(backend);
    await backend.connect(connectOptions({ pairingPhoneNumber: "5511999999999" }));
    const socket = h.sockets[0];
    await tick();
    expect(socket?.requestPairingCode).toHaveBeenCalledTimes(1);

    const code = await backend.requestPairingCode("5511999999999");
    expect(code).toBe("ABCD-EFGH");
    expect(updates.some((update) => update.pairingCode === code)).toBe(true);

    h.pairingFailures = 1;
    await expect(backend.requestPairingCode("5511999999999")).rejects.toMatchObject({
      name: "BackendError",
    });

    // A failed request must not leave automatic pairing wedged.
    socket?.ev.emit("connection.update", { qr: "retry" });
    await tick();
    expect(socket?.requestPairingCode).toHaveBeenCalledTimes(4);
  });

  it("persists credentials whenever the provider updates them", async () => {
    const store = new MemorySessionStore();
    const backend = createBackend();
    await backend.connect(connectOptions({ sessionStore: store }));

    expect(await store.load("default")).toBeNull();

    h.sockets[0]?.ev.emit("creds.update", {});
    await tick();

    expect(await store.load("default")).not.toBeNull();
  });
});
