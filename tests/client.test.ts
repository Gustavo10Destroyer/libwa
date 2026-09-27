import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "../src/Client.js";
import type { ClientOptions } from "../src/ClientOptions.js";
import { MemorySessionStore } from "../src/auth/MemorySessionStore.js";
import type { Session } from "../src/auth/SessionStore.js";
import { DisconnectReason } from "../src/core/DisconnectReason.js";
import { ConnectionError, ValidationError } from "../src/errors/index.js";
import type { Interaction } from "../src/interactions/Interaction.js";
import { CapableMockBackend, MockBackend } from "./helpers/MockBackend.js";
import { groupParticipantsEvent, groupUpdateEvent, messageEvent } from "./helpers/fixtures.js";

const SELF_ID = "5511888888888@s.whatsapp.net";

function createClient(
  backend: MockBackend,
  overrides: Partial<ClientOptions> = {},
): { client: Client; store: MemorySessionStore } {
  const store = new MemorySessionStore();
  const client = new Client({ backend, sessionStore: store, ...overrides });
  return { client, store };
}

async function login(client: Client, backend: MockBackend): Promise<void> {
  const promise = client.login();
  backend.open();
  await promise;
}

function sessionFixture(): Session {
  return {
    id: "default",
    provider: "mock",
    data: new Uint8Array([1, 2, 3]),
    updatedAt: new Date(),
  };
}

describe("Client lifecycle", () => {
  it("logs in, reports ready and exposes the logged-in user", async () => {
    const backend = new CapableMockBackend();
    const { client } = createClient(backend);
    const ready = vi.fn();
    client.on("ready", ready);

    await login(client, backend);

    expect(client.state).toBe("ready");
    expect(client.isReady).toBe(true);
    expect(client.me?.id).toBe(SELF_ID);
    expect(client.me?.isMe).toBe(true);
    expect(ready).toHaveBeenCalledTimes(1);
    expect(ready).toHaveBeenCalledWith(client);
    expect(backend.connectCalls[0]?.sessionId).toBe("default");
    expect(backend.connected).toBe(true);
  });

  it("passes sessionId and session store to the backend", async () => {
    const backend = new CapableMockBackend();
    const store = new MemorySessionStore();
    const client = new Client({ backend, sessionStore: store, sessionId: "acct1" });
    await login(client, backend);
    expect(backend.connectCalls[0]?.sessionId).toBe("acct1");
    expect(backend.connectCalls[0]?.sessionStore).toBe(store);
    expect(client.sessionId).toBe("acct1");
    expect(client.backend).toBe(backend);
  });

  it("resolves login() immediately when already ready", async () => {
    const backend = new CapableMockBackend();
    const { client } = createClient(backend);
    await login(client, backend);
    await client.login();
    expect(backend.connectCalls).toHaveLength(1);
  });

  it("forwards qr and pairing code updates", async () => {
    const backend = new CapableMockBackend();
    const { client } = createClient(backend);
    const qr = vi.fn();
    const pairing = vi.fn();
    client.on("qr", qr);
    client.on("pairingCode", pairing);

    const promise = client.login();
    backend.showQr("QRDATA");
    backend.connection({ status: "connecting", pairingCode: "ABCD-1234" });
    backend.open();
    await promise;

    expect(qr).toHaveBeenCalledWith("QRDATA");
    expect(pairing).toHaveBeenCalledWith("ABCD-1234");
  });

  it("fails fast when the backend rejects the connection with a configuration error", async () => {
    const backend = new MockBackend();
    backend.connectError = new ValidationError("bad session config", {
      code: "ERR_BAD_CONFIG",
    });
    const { client } = createClient(backend);
    const reconnecting = vi.fn();
    client.on("reconnecting", reconnecting);

    await expect(client.login()).rejects.toBeInstanceOf(ValidationError);
    expect(reconnecting).not.toHaveBeenCalled();
    expect(client.state).toBe("idle");
    expect(backend.connectCalls).toHaveLength(1);
  });

  it("fails login with a connection error when connect throws generically and retries are off", async () => {
    const backend = new MockBackend();
    backend.connectError = new Error("network unreachable");
    const { client } = createClient(backend, { reconnect: false });
    const error = vi.fn();
    const disconnected = vi.fn();
    client.on("error", error);
    client.on("disconnect", disconnected);

    await expect(client.login()).rejects.toBeInstanceOf(ConnectionError);
    expect(error).toHaveBeenCalled();
    expect(disconnected).toHaveBeenCalledWith(DisconnectReason.NetworkError);
    expect(client.state).toBe("idle");
  });

  it("destroys permanently", async () => {
    const backend = new CapableMockBackend();
    const { client } = createClient(backend);
    await login(client, backend);

    await client.destroy();

    expect(client.state).toBe("destroyed");
    expect(client.isReady).toBe(false);
    expect(backend.connected).toBe(false);
    await expect(client.login()).rejects.toThrow(/destroyed/);

    const received: Interaction[] = [];
    client.on("interactionCreate", (interaction) => {
      received.push(interaction);
    });
    backend.emit("message", messageEvent());
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(received).toHaveLength(0);
  });

  it("logs out via the backend and clears the stored session", async () => {
    const backend = new CapableMockBackend();
    const { client, store } = createClient(backend);
    await login(client, backend);
    await store.save(sessionFixture());

    await client.logout();

    expect(backend.logoutCalled).toBe(true);
    expect(await store.load("default")).toBeNull();
    expect(client.state).toBe("idle");
    expect(client.isReady).toBe(false);
  });

  it("clears the session even when the backend lacks logout()", async () => {
    const backend = new MockBackend();
    const { client, store } = createClient(backend);
    await store.save(sessionFixture());
    await client.logout();
    expect(await store.load("default")).toBeNull();
    expect(client.state).toBe("idle");
  });

  it("validates pairing phone numbers and delegates to the backend", async () => {
    const backend = new CapableMockBackend();
    const { client } = createClient(backend);
    const code = await client.requestPairingCode("5511999999999");
    expect(code).toBe("ABCD-EFGH");
    expect(backend.pairingRequests).toEqual(["5511999999999"]);
    await expect(client.requestPairingCode("+5511999999999")).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("rejects pairing codes when the backend lacks support", async () => {
    const backend = new MockBackend();
    const { client } = createClient(backend);
    await expect(client.requestPairingCode("5511999999999")).rejects.toMatchObject({
      code: "ERR_UNSUPPORTED",
    });
  });
});

describe("Client interaction dispatch", () => {
  let backend: CapableMockBackend;
  let client: Client;

  beforeEach(async () => {
    backend = new CapableMockBackend();
    ({ client } = createClient(backend));
    await login(client, backend);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("dispatches messages as interactions", async () => {
    const received: Interaction[] = [];
    client.on("interactionCreate", (interaction) => {
      received.push(interaction);
    });

    backend.emit("message", messageEvent());
    await vi.waitFor(() => expect(received).toHaveLength(1));
    const first = received[0];
    expect(first?.isMessage()).toBe(true);
    if (first === undefined || !first.isMessage()) return;
    expect(first.text).toBe("hello");
    expect(first.chat.id).toBe("111@s.whatsapp.net");
  });

  it("dispatches group participant and group update events", async () => {
    const received: Interaction[] = [];
    client.on("interactionCreate", (interaction) => {
      received.push(interaction);
    });

    backend.emit("groupParticipants", groupParticipantsEvent());
    backend.emit("groupUpdate", groupUpdateEvent());
    await vi.waitFor(() => expect(received).toHaveLength(2));
    expect(received[0]?.isGroupParticipantUpdate()).toBe(true);
    expect(received[1]?.isGroupUpdate()).toBe(true);
  });

  it("executes matching commands with parsed arguments", async () => {
    const executed: Interaction[] = [];
    client.commands.register({
      name: "ping",
      execute: (interaction) => {
        executed.push(interaction);
      },
    });
    const received: Interaction[] = [];
    client.on("interactionCreate", (interaction) => {
      received.push(interaction);
    });

    backend.emit("message", messageEvent({ content: { kind: "text", text: "!ping a b" } }));
    await vi.waitFor(() => expect(executed).toHaveLength(1));
    expect(executed[0]?.isCommand()).toBe(true);
    if (!executed[0]?.isCommand()) return;
    expect(executed[0].args).toEqual(["a", "b"]);
    expect(executed[0].command?.name).toBe("ping");
    expect(received).toHaveLength(1);
  });

  it("enforces groupOnly commands", async () => {
    const executed: Interaction[] = [];
    client.commands.register({
      name: "members",
      groupOnly: true,
      execute: (interaction) => {
        executed.push(interaction);
      },
    });
    const received: Interaction[] = [];
    client.on("interactionCreate", (interaction) => {
      received.push(interaction);
    });

    backend.emit("message", messageEvent({ content: { kind: "text", text: "!members" } }));
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(executed).toHaveLength(0);
    expect(received[0]?.isCommand()).toBe(true);

    backend.emit(
      "message",
      messageEvent({
        chatId: "123456789@g.us",
        chatKind: "group",
        content: { kind: "text", text: "!members" },
      }),
    );
    await vi.waitFor(() => expect(executed).toHaveLength(1));
  });

  it("enforces dmOnly commands", async () => {
    const executed: Interaction[] = [];
    client.commands.register({
      name: "private",
      dmOnly: true,
      execute: (interaction) => {
        executed.push(interaction);
      },
    });

    backend.emit(
      "message",
      messageEvent({
        chatId: "123456789@g.us",
        chatKind: "group",
        content: { kind: "text", text: "!private" },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(executed).toHaveLength(0);

    backend.emit("message", messageEvent({ content: { kind: "text", text: "!private" } }));
    await vi.waitFor(() => expect(executed).toHaveLength(1));
  });

  it("reports command execution failures through the error event", async () => {
    client.commands.register({
      name: "boom",
      execute: () => {
        throw new Error("command exploded");
      },
    });
    const error = vi.fn();
    client.on("error", error);
    const received: Interaction[] = [];
    client.on("interactionCreate", (interaction) => {
      received.push(interaction);
    });

    backend.emit("message", messageEvent({ content: { kind: "text", text: "!boom" } }));
    await vi.waitFor(() => expect(received).toHaveLength(1));
    await vi.waitFor(() => expect(error).toHaveBeenCalled());
    const first = error.mock.calls[0]?.[0] as Error;
    expect(first.message).toBe("command exploded");
  });

  it("skips dispatch entirely when a middleware does not call next()", async () => {
    client.use(() => {
      // Intentionally stops the chain.
    });
    const received: Interaction[] = [];
    client.on("interactionCreate", (interaction) => {
      received.push(interaction);
    });

    backend.emit("message", messageEvent());
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(received).toHaveLength(0);
  });

  it("reports middleware failures through the error event", async () => {
    client.use(() => {
      throw new Error("mw boom");
    });
    const error = vi.fn();
    client.on("error", error);

    backend.emit("message", messageEvent());
    await vi.waitFor(() => expect(error).toHaveBeenCalled());
    expect((error.mock.calls[0]?.[0] as Error).message).toBe("mw boom");
  });

  it("reports listener failures through the error event without re-entering it", async () => {
    const received: string[] = [];
    client.on("error", () => {
      throw new Error("error listener exploded");
    });
    client.on("error", (failure) => {
      received.push(failure.message);
    });
    client.on("interactionCreate", () => {
      throw new Error("listener exploded");
    });

    backend.emit("message", messageEvent());
    await vi.waitFor(() => expect(received).toContain("listener exploded"));
    expect(received).not.toContain("error listener exploded");
  });
});

describe("Client reconnection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries recoverable disconnects with exponential backoff", async () => {
    const backend = new CapableMockBackend();
    const { client } = createClient(backend, {
      reconnect: { attempts: 3, initialDelayMs: 100, maxDelayMs: 1000, factor: 2 },
    });
    const reconnecting = vi.fn();
    const ready = vi.fn();
    client.on("reconnecting", reconnecting);
    client.on("ready", ready);

    await login(client, backend);
    expect(ready).toHaveBeenCalledTimes(1);

    backend.close(DisconnectReason.ConnectionLost);
    expect(client.isReady).toBe(false);
    expect(client.state).toBe("connecting");
    expect(reconnecting).toHaveBeenCalledWith(1, 100);

    await vi.advanceTimersByTimeAsync(100);
    expect(backend.connectCalls).toHaveLength(2);
    backend.open();
    expect(client.state).toBe("ready");
    expect(ready).toHaveBeenCalledTimes(2);

    // Successful reconnects reset the attempt counter.
    backend.close(DisconnectReason.ConnectionLost);
    expect(reconnecting).toHaveBeenLastCalledWith(1, 100);

    await vi.advanceTimersByTimeAsync(100);
    expect(backend.connectCalls).toHaveLength(3);
    backend.open();

    backend.close(DisconnectReason.ConnectionLost);
    expect(reconnecting).toHaveBeenLastCalledWith(1, 100);
    await vi.advanceTimersByTimeAsync(100);
    expect(backend.connectCalls).toHaveLength(4);
  });

  it("caps the backoff delay at maxDelayMs", async () => {
    const backend = new CapableMockBackend();
    const { client } = createClient(backend, {
      reconnect: { attempts: 5, initialDelayMs: 100, maxDelayMs: 150, factor: 10 },
    });
    const reconnecting = vi.fn();
    client.on("reconnecting", reconnecting);
    await login(client, backend);

    backend.close(DisconnectReason.ConnectionLost);
    expect(reconnecting).toHaveBeenLastCalledWith(1, 100);
    await vi.advanceTimersByTimeAsync(100);
    backend.close(DisconnectReason.ConnectionLost);
    expect(reconnecting).toHaveBeenLastCalledWith(2, 150);
  });

  it("gives up after exhausting attempts", async () => {
    const backend = new CapableMockBackend();
    const { client } = createClient(backend, {
      reconnect: { attempts: 1, initialDelayMs: 50, maxDelayMs: 50, factor: 2 },
    });
    const reconnecting = vi.fn();
    const disconnect = vi.fn();
    const error = vi.fn();
    client.on("reconnecting", reconnecting);
    client.on("disconnect", disconnect);
    client.on("error", error);

    const pending = client.login();
    backend.close(DisconnectReason.ConnectionLost);
    expect(reconnecting).toHaveBeenCalledWith(1, 50);

    await vi.advanceTimersByTimeAsync(50);
    expect(backend.connectCalls).toHaveLength(2);

    backend.close(DisconnectReason.ConnectionLost);
    await expect(pending).rejects.toBeInstanceOf(ConnectionError);
    expect(disconnect).toHaveBeenCalledWith(DisconnectReason.ConnectionLost);
    expect(reconnecting).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("Gave up reconnecting") }),
    );
    expect(client.state).toBe("idle");
  });

  it("never retries fatal disconnects", async () => {
    const backend = new CapableMockBackend();
    const { client } = createClient(backend);
    const reconnecting = vi.fn();
    const disconnect = vi.fn();
    client.on("reconnecting", reconnecting);
    client.on("disconnect", disconnect);

    const pending = client.login();
    backend.close(DisconnectReason.LoggedOut);

    await expect(pending).rejects.toThrow(/Authentication failed/);
    expect(reconnecting).not.toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalledWith(DisconnectReason.LoggedOut);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(backend.connectCalls).toHaveLength(1);
  });

  it("keeps the state idle when reconnection is disabled", async () => {
    const backend = new CapableMockBackend();
    const { client } = createClient(backend, { reconnect: false });
    const disconnect = vi.fn();
    client.on("disconnect", disconnect);
    await login(client, backend);

    backend.close(DisconnectReason.ConnectionLost);
    expect(disconnect).toHaveBeenCalledWith(DisconnectReason.ConnectionLost);
    expect(client.state).toBe("idle");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(backend.connectCalls).toHaveLength(1);
  });

  it("cancels pending reconnection when destroyed", async () => {
    const backend = new CapableMockBackend();
    const { client } = createClient(backend, {
      reconnect: { attempts: 3, initialDelayMs: 50, maxDelayMs: 100, factor: 2 },
    });
    const reconnecting = vi.fn();
    client.on("reconnecting", reconnecting);
    await login(client, backend);

    backend.close(DisconnectReason.ConnectionLost);
    expect(reconnecting).toHaveBeenCalledTimes(1);
    await client.destroy();
    await vi.advanceTimersByTimeAsync(1000);
    expect(backend.connectCalls).toHaveLength(1);
    expect(client.state).toBe("destroyed");
  });
});
