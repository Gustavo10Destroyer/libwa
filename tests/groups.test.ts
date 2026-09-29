import { beforeEach, describe, expect, it } from "vitest";
import { Client } from "../src/Client.js";
import { MemorySessionStore } from "../src/auth/MemorySessionStore.js";
import { EntityFactory } from "../src/entities/EntityFactory.js";
import { NotFoundError, ValidationError } from "../src/errors/index.js";
import { CapableMockBackend, MockBackend, groupMetadataFixture } from "./helpers/MockBackend.js";

const GROUP_ID = "123456789@g.us";

describe("GroupService", () => {
  let backend: CapableMockBackend;
  let client: Client;

  beforeEach(() => {
    backend = new CapableMockBackend();
    client = new Client({ backend, sessionStore: new MemorySessionStore() });
  });

  it("fetches metadata and synchronizes the group entity", async () => {
    const group = await client.groups.fetch(GROUP_ID);
    expect(group.isGroup()).toBe(true);
    expect(group.name).toBe("Test Group");
    expect(group.description).toBe("A group for tests");
    expect(group.owner?.id).toBe("111@s.whatsapp.net");
    expect(group.memberCount).toBe(2);
    expect(group.members.map((member) => member.user.id)).toEqual([
      "111@s.whatsapp.net",
      "222@s.whatsapp.net",
    ]);
    expect(group.members.map((member) => member.role)).toEqual(["admin", "member"]);
    expect(group.members[0]?.tag).toBe("Owner");
    expect(group.announceOnly).toBe(false);
    expect(group.metadata?.createdAt).toEqual(new Date(1_700_000_000_000));
  });

  it("preserves library errors from the backend", async () => {
    backend.metadataError = new NotFoundError("Group not found");
    await expect(client.groups.fetch(GROUP_ID)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("accepts bare group ids and appends the group suffix", async () => {
    const bare = GROUP_ID.slice(0, -"@g.us".length);
    const group = await client.groups.fetch(bare);
    expect(group.id).toBe(GROUP_ID);
    expect(backend.metadataCalls).toEqual([GROUP_ID]);

    await client.groups.rename("123456789-1601234567890", "Legacy");
    expect(backend.renameCalls).toEqual([
      { chatId: "123456789-1601234567890@g.us", name: "Legacy" },
    ]);
  });

  it("wraps provider errors as backend errors", async () => {
    backend.metadataError = new Error("boom");
    await expect(client.groups.fetch(GROUP_ID)).rejects.toMatchObject({
      name: "BackendError",
      message: `Failed to fetch group ${GROUP_ID}: boom`,
    });
  });

  it("updates participants", async () => {
    await client.groups.addMembers(GROUP_ID, ["222@s.whatsapp.net", { id: "333@s.whatsapp.net" }]);
    expect(backend.participantCalls).toEqual([
      {
        chatId: GROUP_ID,
        userIds: ["222@s.whatsapp.net", "333@s.whatsapp.net"],
        action: "add",
      },
    ]);
    await client.groups.removeMembers(GROUP_ID, ["222@s.whatsapp.net"]);
    await client.groups.promote(GROUP_ID, ["222@s.whatsapp.net"]);
    await client.groups.demote(GROUP_ID, ["222@s.whatsapp.net"]);
    expect(backend.participantCalls.map((call) => call.action)).toEqual([
      "add",
      "remove",
      "promote",
      "demote",
    ]);
  });

  it("rejects empty participant lists", async () => {
    await expect(client.groups.addMembers(GROUP_ID, [])).rejects.toMatchObject({
      code: "ERR_EMPTY_USER_LIST",
    });
    expect(backend.participantCalls).toHaveLength(0);
  });

  it("renames groups and keeps cached metadata in sync", async () => {
    const group = await client.groups.fetch(GROUP_ID);
    await client.groups.rename(group, "New Name");
    expect(backend.renameCalls).toEqual([{ chatId: GROUP_ID, name: "New Name" }]);
    expect(group.name).toBe("New Name");
    await expect(client.groups.rename(group, "")).rejects.toBeInstanceOf(ValidationError);
  });

  it("updates descriptions and keeps cached metadata in sync", async () => {
    const group = await client.groups.fetch(GROUP_ID);
    await client.groups.setDescription(group, "New description");
    expect(backend.descriptionCalls).toEqual([
      { chatId: GROUP_ID, description: "New description" },
    ]);
    expect(group.description).toBe("New description");
    await client.groups.setDescription(group, undefined);
    expect(backend.descriptionCalls[1]?.description).toBeUndefined();
  });

  it("surfaces unsupported capabilities", async () => {
    const plain = new MockBackend();
    const plainClient = new Client({ backend: plain, sessionStore: new MemorySessionStore() });
    await expect(
      plainClient.groups.addMembers(GROUP_ID, ["222@s.whatsapp.net"]),
    ).rejects.toMatchObject({
      name: "UnsupportedOperationError",
    });
    await expect(plainClient.groups.rename(GROUP_ID, "x")).rejects.toMatchObject({
      name: "UnsupportedOperationError",
    });
    await expect(plainClient.groups.setDescription(GROUP_ID, "x")).rejects.toMatchObject({
      name: "UnsupportedOperationError",
    });
  });
});

describe("Group member lookups", () => {
  let backend: CapableMockBackend;
  let client: Client;

  beforeEach(() => {
    backend = new CapableMockBackend();
    client = new Client({ backend, sessionStore: new MemorySessionStore() });
  });

  it("looks up membership by id and by user instance", async () => {
    const group = await client.groups.fetch(GROUP_ID);

    const byId = group.member("111@s.whatsapp.net");
    expect(byId?.role).toBe("admin");
    expect(byId?.tag).toBe("Owner");
    expect(byId?.user.id).toBe("111@s.whatsapp.net");

    const owner = byId?.user;
    expect(owner).toBeDefined();
    if (owner === undefined) throw new Error("expected the owner member");
    expect(group.member(owner)).toEqual(byId);

    const plain = group.member("222@s.whatsapp.net");
    expect(plain?.role).toBe("member");
    expect(plain?.tag).toBeUndefined();
    expect(group.member("999@s.whatsapp.net")).toBeUndefined();
  });

  it("matches across id schemes and tags participants by username", async () => {
    const LID = "987654321012345@lid";
    const PN = "5511999999999@s.whatsapp.net";
    const fixture = groupMetadataFixture(GROUP_ID);
    backend.metadataFixture = {
      ...fixture,
      participants: [
        { id: LID, altId: PN, role: "superadmin", name: undefined, username: "gustavo" },
      ],
    };
    const group = await client.groups.fetch(GROUP_ID);

    expect(group.member(LID)?.role).toBe("superadmin");
    expect(group.member(LID)?.tag).toBe("gustavo");
    expect(group.member(PN)?.role).toBe("superadmin");
    expect(group.member(PN)?.tag).toBe("gustavo");
  });

  it("stays undefined while metadata is unknown", () => {
    const entities = new EntityFactory(client);
    const group = entities.group(GROUP_ID);
    expect(group.member("111@s.whatsapp.net")).toBeUndefined();
    expect(group.members).toEqual([]);
  });
});

describe("Group entity actions", () => {
  it("delegates member management to the client services", async () => {
    const backend = new CapableMockBackend();
    const client = new Client({ backend, sessionStore: new MemorySessionStore() });
    const group = await client.groups.fetch(GROUP_ID);
    await group.addMembers(["444@s.whatsapp.net"]);
    await group.rename("Renamed via entity");
    await group.setDescription("via entity");
    await group.refresh();
    expect(backend.participantCalls).toHaveLength(1);
    expect(backend.renameCalls).toHaveLength(1);
    expect(backend.descriptionCalls).toHaveLength(1);
    expect(group.metadata).toEqual(groupMetadataFixture(GROUP_ID));
  });
});
