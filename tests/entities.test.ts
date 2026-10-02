import { describe, expect, it, vi } from "vitest";
import { Client } from "../src/Client.js";
import { MemorySessionStore } from "../src/auth/MemorySessionStore.js";
import type { ChatId } from "../src/core/ids.js";
import type { GroupMetadata } from "../src/entities/Chat.js";
import { EntityFactory } from "../src/entities/EntityFactory.js";
import { GroupService } from "../src/groups/GroupService.js";
import { MockBackend, groupMetadataFixture } from "./helpers/MockBackend.js";

const GROUP_ID = "123456789@g.us";
const PN = "5511999999999@s.whatsapp.net";
const LID = "987654321012345@lid";

function harness(backend: MockBackend = new MockBackend()) {
  const client = new Client({ backend, sessionStore: new MemorySessionStore() });
  const entities = new EntityFactory(client);
  return { client, backend, entities };
}

describe("self identity", () => {
  it("resolves isMe through recorded id pairs", () => {
    const { entities } = harness();
    entities.setSelf({ id: PN, name: undefined });

    expect(entities.user(PN).isMe).toBe(true);
    expect(entities.user(LID).isMe).toBe(false);

    entities.recordIdPairs([{ id: LID, altId: PN }]);
    expect(entities.user(LID).isMe).toBe(true);
    expect(entities.user(PN).isMe).toBe(true);
    expect(entities.isSelf(LID)).toBe(true);
  });

  it("reports the bot as itself inside a LID-addressed group", () => {
    const { entities } = harness();
    entities.setSelf({ id: PN, name: undefined });
    entities.recordIdPairs([{ id: LID, altId: PN }]);
    entities.applyGroupMetadata({
      ...groupMetadataFixture(),
      ownerId: LID,
      participants: [{ id: LID, altId: PN, role: "superadmin", name: undefined }],
    });

    const group = entities.group(GROUP_ID);
    expect(group.owner?.isMe).toBe(true);
    expect(group.member(LID)?.user.isMe).toBe(true);
    expect(group.member(PN)?.user.isMe).toBe(true);
  });

  it("answers through the client too", async () => {
    const backend = new MockBackend();
    const client = new Client({ backend, sessionStore: new MemorySessionStore() });
    const login = client.login();
    backend.open();
    await login;
    expect(client.isSelf(client.me?.id ?? "")).toBe(true);
    expect(client.isSelf(LID)).toBe(false);
  });
});

describe("display names", () => {
  it("falls back when a remembered name is empty", () => {
    const { entities } = harness();
    const user = entities.user(PN, "");
    expect(user.name).toBeUndefined();
    expect(user.displayName).toBe("5511999999999");

    const chat = entities.chat({ id: PN, kind: "direct", name: "" });
    expect(chat.name).toBeUndefined();
    expect(chat.displayName).toBe(PN);
  });

  it("ignores an empty name arriving in a reference", () => {
    const { entities } = harness();
    const chat = entities.chat({ id: PN, kind: "direct", name: "Alice" });
    const group = entities.chat({ id: GROUP_ID, kind: "group", name: "Group Name" });

    entities.chat({ id: PN, kind: "direct", name: "" });
    entities.chat({ id: GROUP_ID, kind: "group", name: "" });

    expect(chat.name).toBe("Alice");
    expect(chat.displayName).toBe("Alice");
    expect(group.name).toBe("Group Name");
  });

  it("treats an empty updateName as a clear", () => {
    const { entities } = harness();
    const chat = entities.chat({ id: PN, kind: "direct", name: "Alice" });
    chat.updateName("");
    expect(chat.name).toBeUndefined();
    expect(chat.displayName).toBe(PN);
  });
});

describe("group label consistency", () => {
  it("keeps name and displayName on the metadata label", () => {
    const { entities } = harness();
    entities.applyGroupMetadata(groupMetadataFixture());
    const group = entities.group(GROUP_ID);

    group.updateName("Local Rename");
    expect(group.name).toBe("Test Group");
    expect(group.displayName).toBe("Test Group");
  });

  it("syncs metadata written through the instance into the factory cache", () => {
    const { entities } = harness();
    const group = entities.group(GROUP_ID);
    group.applyMetadata({ ...groupMetadataFixture(), name: "Instance Name" });

    expect(entities.groupMetadata(GROUP_ID)?.name).toBe("Instance Name");

    // Without the sync this took the "no cached metadata" path and dropped
    // everything but the name.
    entities.applyGroupChanges(GROUP_ID, { description: "updated" });
    expect(entities.groupMetadata(GROUP_ID)?.description).toBe("updated");
    expect(group.name).toBe("Instance Name");
  });
});

describe("chat cache identity", () => {
  it("does not downgrade a live chat when a reference only knows the id", () => {
    const { entities } = harness();
    const direct = entities.chat({ id: PN, kind: "direct", name: "Alice" });

    expect(entities.chat({ id: PN, kind: "unknown" })).toBe(direct);
    expect(entities.knownChat(PN)).toBe(direct);
    expect(direct.kind).toBe("direct");
    expect(direct.name).toBe("Alice");
  });

  it("upgrades a placeholder chat when better knowledge arrives", () => {
    const { entities } = harness();
    const placeholder = entities.chat({ id: PN, kind: "unknown" });
    const direct = entities.chat({ id: PN, kind: "direct", name: "Alice" });

    expect(direct).not.toBe(placeholder);
    expect(direct.kind).toBe("direct");
    expect(entities.knownChat(PN)).toBe(direct);
  });

  it("resolves both addressing schemes to one chat", () => {
    const { entities } = harness();
    const chat = entities.chat({ id: PN, kind: "direct", name: "Alice" });
    entities.recordIdPairs([{ id: LID, altId: PN }]);

    expect(entities.chat({ id: LID, kind: "direct" })).toBe(chat);
    expect(entities.knownChat(LID)).toBe(chat);
  });

  it("merges a conversation cached under both schemes once the pair arrives", () => {
    const { entities } = harness();
    const byLid = entities.chat({ id: LID, kind: "direct", name: "Alice" });
    const byPn = entities.chat({ id: PN, kind: "direct", name: "Alice" });
    expect(byPn).not.toBe(byLid);

    entities.recordIdPairs([{ id: LID, altId: PN }]);

    expect(entities.chat({ id: PN, kind: "direct" })).toBe(byLid);
    expect(entities.chat({ id: LID, kind: "direct" })).toBe(byLid);
    expect(entities.knownChat(PN)).toBe(byLid);
  });
});

describe("bounded caches", () => {
  it("evicts the least recently used chats past the cap", () => {
    const { entities } = harness();
    for (let i = 0; i < 600; i += 1) {
      entities.chat({ id: `chat-${i}`, kind: "direct" });
    }
    expect(entities.knownChat("chat-0")).toBeUndefined();
    expect(entities.knownChat("chat-599")).toBeDefined();
  });

  it("keeps a chat that is still being used", () => {
    const { entities } = harness();
    const favourite = entities.chat({ id: "chat-favourite", kind: "direct" });
    for (let i = 0; i < 600; i += 1) {
      entities.chat({ id: `chat-${i}`, kind: "direct" });
      if (i % 25 === 0) {
        expect(entities.knownChat("chat-favourite")).toBe(favourite);
      }
    }
    expect(entities.knownChat("chat-favourite")).toBe(favourite);
  });

  it("evicts group metadata together with its group", () => {
    const { entities } = harness();
    for (let i = 0; i < 520; i += 1) {
      entities.applyGroupMetadata(groupMetadataFixture(`${i}@g.us`));
    }
    expect(entities.groupMetadata("0@g.us")).toBeUndefined();
    expect(entities.knownChat("0@g.us")).toBeUndefined();
    expect(entities.groupMetadata("519@g.us")).toBeDefined();
    expect(entities.knownChat("519@g.us")).toBeDefined();
  });

  it("drops every cached identity on reset", () => {
    const { entities } = harness();
    entities.setSelf({ id: PN, name: "Bot" });
    entities.recordIdPairs([{ id: LID, altId: PN }]);
    entities.rememberName(PN, "Alice");
    entities.chat({ id: PN, kind: "direct" });
    entities.applyGroupMetadata(groupMetadataFixture());
    expect(entities.user(LID).isMe).toBe(true);

    entities.reset();

    expect(entities.me).toBeNull();
    expect(entities.knownChat(PN)).toBeUndefined();
    expect(entities.groupMetadata(GROUP_ID)).toBeUndefined();
    expect(entities.altIdFor(LID)).toBeUndefined();
    expect(entities.user(LID).isMe).toBe(false);
  });
});

describe("metadata revision guard", () => {
  function gatedBackend(backend: MockBackend): { release: () => void } {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = backend.getGroupMetadata.bind(backend);
    vi.spyOn(backend, "getGroupMetadata").mockImplementation(
      async (chatId: ChatId): Promise<GroupMetadata> => {
        await gate;
        return original(chatId);
      },
    );
    return { release };
  }

  it("discards a metadata fetch that a local rename outran", async () => {
    const { backend, entities } = harness();
    const service = new GroupService(backend, entities);
    entities.applyGroupMetadata(groupMetadataFixture());

    const { release } = gatedBackend(backend);
    const pending = service.fetch(GROUP_ID);
    entities.applyGroupChanges(GROUP_ID, { name: "Renamed Locally" });
    release();
    await pending;

    expect(entities.groupMetadata(GROUP_ID)?.name).toBe("Renamed Locally");
    expect(entities.group(GROUP_ID).name).toBe("Renamed Locally");
  });

  it("applies a fetch when nothing changed while it was in flight", async () => {
    const { backend, entities } = harness();
    const service = new GroupService(backend, entities);
    entities.applyGroupMetadata(groupMetadataFixture());

    const { release } = gatedBackend(backend);
    const pending = service.fetch(GROUP_ID);
    release();
    const group = await pending;

    expect(entities.groupMetadata(GROUP_ID)?.name).toBe("Test Group");
    expect(group.name).toBe("Test Group");
  });
});
