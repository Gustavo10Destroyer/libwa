import { beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "../src/Client.js";
import { MemorySessionStore } from "../src/auth/MemorySessionStore.js";
import { Group } from "../src/entities/Chat.js";
import { User } from "../src/entities/User.js";
import { ValidationError } from "../src/errors/index.js";
import { CapableMockBackend, MockBackend } from "./helpers/MockBackend.js";

describe("MessageService", () => {
  let backend: MockBackend;
  let client: Client;

  beforeEach(() => {
    backend = new MockBackend();
    client = new Client({ backend, sessionStore: new MemorySessionStore() });
  });

  it("sends plain text by string id", async () => {
    const message = await client.messages.send("111@s.whatsapp.net", "hello");
    expect(backend.sent).toHaveLength(1);
    expect(backend.sent[0]?.content).toEqual({ kind: "text", text: "hello" });
    expect(backend.sent[0]?.replyToMessageId).toBeUndefined();
    expect(message.id).toBe("sent-1");
    expect(message.isFromMe).toBe(true);
    expect(message.chat.kind).toBe("direct");
    expect(message.text).toBe("hello");
  });

  it("resolves a User target to their direct chat", async () => {
    const user = new User({ id: "222@s.whatsapp.net", name: "Bob" });
    await client.messages.send(user, "hi bob");
    expect(backend.sent[0]?.chatId).toBe("222@s.whatsapp.net");
  });

  it("resolves an existing Chat target", async () => {
    const group = new Group({ client, id: "123@g.us" });
    const message = await client.messages.send(group, "hi group");
    expect(backend.sent[0]?.chatId).toBe("123@g.us");
    expect(message.chat.kind).toBe("group");
  });

  it("classifies unknown ids as unknown chats", async () => {
    const message = await client.messages.send("mystery@unknown", "hi");
    expect(message.chat.kind).toBe("unknown");
  });

  it("passes quotes as replyToMessageId", async () => {
    const sent = await client.messages.send("111@s.whatsapp.net", "first");
    await client.messages.send("111@s.whatsapp.net", "second", { quote: sent });
    expect(backend.sent[1]?.replyToMessageId).toBe("sent-1");
    await client.messages.send("111@s.whatsapp.net", "third", { replyToMessageId: "abc" });
    expect(backend.sent[2]?.replyToMessageId).toBe("abc");
  });

  it("keeps option mentions on plain string content", async () => {
    await client.messages.send("111@s.whatsapp.net", "hello", {
      mentions: ["222@s.whatsapp.net"],
    });
    expect(backend.sent[0]?.mentionUserIds).toEqual(["222@s.whatsapp.net"]);
  });

  it("unions payload and option mentions for object payloads", async () => {
    await client.messages.send(
      "111@s.whatsapp.net",
      { text: "hi", mentions: ["222@s.whatsapp.net"] },
      { mentions: ["222@s.whatsapp.net", "333@s.whatsapp.net"] },
    );
    expect(backend.sent[0]?.mentionUserIds).toEqual(["222@s.whatsapp.net", "333@s.whatsapp.net"]);
  });

  it("deduplicates mentions given as User objects and ids", async () => {
    await client.messages.send("111@s.whatsapp.net", "hi", {
      mentions: [new User({ id: "222@s.whatsapp.net", name: "Bob" }), "222@s.whatsapp.net"],
    });
    expect(backend.sent[0]?.mentionUserIds).toEqual(["222@s.whatsapp.net"]);
  });

  it("sends media and wires lazy downloads", async () => {
    backend.media = new Uint8Array([9, 9]);
    const message = await client.messages.send("111@s.whatsapp.net", {
      image: new Uint8Array([1, 2, 3]),
      caption: "look",
    });
    const content = message.content;
    expect(content.kind).toBe("image");
    if (content.kind !== "image") return;
    expect(content.caption).toBe("look");
    expect(content.attachment.mimeType).toBe("image/jpeg");
    const bytes = await content.attachment.download();
    expect(bytes).toEqual(new Uint8Array([9, 9]));
  });

  it("rejects invalid payloads before reaching the backend", async () => {
    await expect(client.messages.send("111@s.whatsapp.net", "")).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(backend.sent).toHaveLength(0);
  });

  it("wraps backend send failures", async () => {
    backend.sendError = new Error("provider down");
    await expect(client.messages.send("111@s.whatsapp.net", "hi")).rejects.toMatchObject({
      name: "BackendError",
      message: "Failed to send message: provider down",
    });
  });

  describe("reactions", () => {
    it("reacts through a message instance", async () => {
      const capable = new CapableMockBackend();
      const capClient = new Client({ backend: capable, sessionStore: new MemorySessionStore() });
      const message = await capClient.messages.send("111@s.whatsapp.net", "hi");
      await capClient.messages.react(message, "👍");
      expect(capable.reactCalls).toEqual([
        { chatId: "111@s.whatsapp.net", messageId: "sent-1", emoji: "👍" },
      ]);
      await capClient.messages.reactTo("111@s.whatsapp.net", "msg-x", null);
      expect(capable.reactCalls[1]?.emoji).toBeNull();
    });

    it("rejects empty reaction emojis", async () => {
      const capable = new CapableMockBackend();
      const capClient = new Client({ backend: capable, sessionStore: new MemorySessionStore() });
      const message = await capClient.messages.send("111@s.whatsapp.net", "hi");
      await expect(capClient.messages.react(message, "")).rejects.toMatchObject({
        code: "ERR_EMPTY_REACTION",
      });
    });

    it("surfaces missing backend support", async () => {
      const message = await client.messages.send("111@s.whatsapp.net", "hi");
      await expect(client.messages.react(message, "👍")).rejects.toMatchObject({
        name: "UnsupportedOperationError",
      });
    });

    it("wraps backend reaction failures", async () => {
      const capable = new CapableMockBackend();
      capable.reactError = new Error("nope");
      const capClient = new Client({ backend: capable, sessionStore: new MemorySessionStore() });
      const message = await capClient.messages.send("111@s.whatsapp.net", "hi");
      await expect(capClient.messages.react(message, "👍")).rejects.toMatchObject({
        name: "BackendError",
      });
    });
  });

  describe("editing", () => {
    it("edits and returns an updated message", async () => {
      const capable = new CapableMockBackend();
      const capClient = new Client({ backend: capable, sessionStore: new MemorySessionStore() });
      const message = await capClient.messages.send("111@s.whatsapp.net", "hi");
      const edited = await capClient.messages.edit(message, "hi, edited");
      expect(capable.editCalls).toEqual([
        { chatId: "111@s.whatsapp.net", messageId: "sent-1", text: "hi, edited" },
      ]);
      expect(edited.content).toEqual({ kind: "text", text: "hi, edited" });
      expect(edited.id).toBe(message.id);
      expect(edited.isFromMe).toBe(true);
    });

    it("rejects empty edits and missing support", async () => {
      const capable = new CapableMockBackend();
      const capClient = new Client({ backend: capable, sessionStore: new MemorySessionStore() });
      const message = await capClient.messages.send("111@s.whatsapp.net", "hi");
      await expect(capClient.messages.edit(message, "")).rejects.toBeInstanceOf(ValidationError);

      const plain = await client.messages.send("111@s.whatsapp.net", "hi");
      await expect(client.messages.edit(plain, "x")).rejects.toMatchObject({
        name: "UnsupportedOperationError",
      });
    });
  });

  describe("deleting", () => {
    it("deletes through the backend", async () => {
      const capable = new CapableMockBackend();
      const capClient = new Client({ backend: capable, sessionStore: new MemorySessionStore() });
      const message = await capClient.messages.send("111@s.whatsapp.net", "hi");
      await capClient.messages.delete(message);
      expect(capable.deleteCalls).toEqual([{ chatId: "111@s.whatsapp.net", messageId: "sent-1" }]);
    });

    it("surfaces missing backend support", async () => {
      const message = await client.messages.send("111@s.whatsapp.net", "hi");
      await expect(client.messages.delete(message)).rejects.toMatchObject({
        name: "UnsupportedOperationError",
      });
    });
  });

  it("keeps chat identity stable across sends", async () => {
    const first = await client.messages.send("111@s.whatsapp.net", "one");
    const second = await client.messages.send("111@s.whatsapp.net", "two");
    expect(second.chat).toBe(first.chat);
  });
});

describe("Message entity actions", () => {
  it("routes reply/react/delete through the client services", async () => {
    const backend = new CapableMockBackend();
    const client = new Client({ backend, sessionStore: new MemorySessionStore() });
    const sent = await client.messages.send("111@s.whatsapp.net", "root");
    const reply = await sent.reply("answer");
    expect(backend.sent[1]?.replyToMessageId).toBe("sent-1");
    await sent.reply("answer again", { mentions: ["222@s.whatsapp.net"] });
    expect(backend.sent[2]?.replyToMessageId).toBe("sent-1");
    expect(backend.sent[2]?.mentionUserIds).toEqual(["222@s.whatsapp.net"]);
    await reply.react("🎉");
    expect(backend.reactCalls[0]?.messageId).toBe("sent-2");
    const spy = vi.spyOn(client.messages, "delete");
    await reply.delete();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
