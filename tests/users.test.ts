import { describe, expect, it, vi } from "vitest";
import { Client } from "../src/Client.js";
import { MemorySessionStore } from "../src/auth/MemorySessionStore.js";
import { BackendError, UnsupportedOperationError, ValidationError } from "../src/errors/index.js";
import type { Interaction } from "../src/interactions/Interaction.js";
import { CapableMockBackend, MockBackend, groupMetadataFixture } from "./helpers/MockBackend.js";
import { groupParticipantsEvent, messageEvent, reactionEvent } from "./helpers/fixtures.js";

const LID = "987654321012345@lid";
const PN = "5511999999999@s.whatsapp.net";
const PHONE_DIGITS = "5511999999999";
const GROUP = "123456789@g.us";

async function readyClient(backend: MockBackend): Promise<Client> {
  const client = new Client({ backend, sessionStore: new MemorySessionStore() });
  const promise = client.login();
  backend.open();
  await promise;
  return client;
}

describe("client.users", () => {
  it("derives phone digits from phone-number ids without I/O", async () => {
    const backend = new CapableMockBackend();
    const client = await readyClient(backend);

    expect(client.users.phone(PN)).toBe(PHONE_DIGITS);
    expect(client.users.phone(LID)).toBeUndefined();
    expect(client.users.altId(PN)).toBeUndefined();
    expect(await client.users.resolvePhone(PN)).toBe(PHONE_DIGITS);
    expect(backend.lidLookups).toEqual([]);
  });

  it("records id pairs from messages and resolves users' phones", async () => {
    const backend = new CapableMockBackend();
    const client = await readyClient(backend);
    const received: Interaction[] = [];
    client.on("interactionCreate", (interaction) => {
      received.push(interaction);
    });

    backend.emit(
      "message",
      messageEvent({
        chatId: LID,
        authorId: LID,
        mentions: [LID],
        idPairs: [{ id: LID, altId: PN }],
      }),
    );
    await vi.waitFor(() => expect(received).toHaveLength(1));

    const interaction = received[0];
    expect(interaction?.isMessage()).toBe(true);
    if (interaction?.isMessage()) {
      expect(interaction.author.phone).toBe(PHONE_DIGITS);
      expect(interaction.message.mentions[0]?.phone).toBe(PHONE_DIGITS);
    }
    expect(client.users.phone(LID)).toBe(PHONE_DIGITS);
    expect(client.users.altId(LID)).toBe(PN);
    expect(client.users.altId(PN)).toBe(LID);
    expect(backend.lidLookups).toEqual([]);
  });

  it("ignores pairs that are not cross-scheme or not phone numbers", async () => {
    const backend = new CapableMockBackend();
    const client = await readyClient(backend);
    const received: Interaction[] = [];
    client.on("interactionCreate", (interaction) => {
      received.push(interaction);
    });

    backend.emit(
      "message",
      messageEvent({
        authorId: LID,
        idPairs: [
          { id: LID, altId: "111@lid" },
          { id: LID, altId: "mystery@elsewhere" },
        ],
      }),
    );
    await vi.waitFor(() => expect(received).toHaveLength(1));

    expect(client.users.phone(LID)).toBeUndefined();
    expect(client.users.altId(LID)).toBeUndefined();
  });

  it("records id pairs from group metadata", async () => {
    const backend = new CapableMockBackend();
    const client = await readyClient(backend);
    const fixture = groupMetadataFixture(GROUP);
    backend.metadataFixture = {
      ...fixture,
      participants: [
        ...fixture.participants,
        { id: LID, altId: PN, role: "member", name: undefined },
      ],
    };

    const group = await client.groups.fetch(GROUP);

    expect(client.users.phone(LID)).toBe(PHONE_DIGITS);
    expect(group.members.find((member) => member.user.id === LID)?.user.phone).toBe(PHONE_DIGITS);
  });

  it("records id pairs from membership events, including departed members", async () => {
    const backend = new CapableMockBackend();
    const client = await readyClient(backend);
    const received: Interaction[] = [];
    client.on("interactionCreate", (interaction) => {
      received.push(interaction);
    });

    backend.emit(
      "groupParticipants",
      groupParticipantsEvent({
        action: "remove",
        participantIds: [LID],
        idPairs: [{ id: LID, altId: PN }],
      }),
    );
    await vi.waitFor(() => expect(received).toHaveLength(1));

    expect(client.users.phone(LID)).toBe(PHONE_DIGITS);
  });

  it("resolves phone numbers via the backend when no pair is known", async () => {
    const backend = new CapableMockBackend();
    backend.phoneForLidResult = "5511888877777";
    const client = await readyClient(backend);

    expect(await client.users.resolvePhone(LID)).toBe("5511888877777");
    expect(backend.lidLookups).toEqual([LID]);
    expect(client.users.phone(LID)).toBe("5511888877777");
    expect(client.users.altId(LID)).toBe("5511888877777@s.whatsapp.net");

    // The recorded pair answers follow-up lookups without another round-trip.
    expect(await client.users.resolvePhone(LID)).toBe("5511888877777");
    expect(backend.lidLookups).toHaveLength(1);
  });

  it("resolves linked ids for phone numbers and records the pair", async () => {
    const backend = new CapableMockBackend();
    backend.lidForPhoneResult = LID;
    const client = await readyClient(backend);

    expect(await client.users.resolveLid(PN)).toBe(LID);
    expect(backend.phoneLookups).toEqual([PHONE_DIGITS]);
    expect(client.users.altId(PN)).toBe(LID);
    expect(client.users.phone(LID)).toBe(PHONE_DIGITS);

    expect(await client.users.resolveLid(LID)).toBe(LID);
    expect(backend.phoneLookups).toHaveLength(1);
  });

  it("resolves undefined when the backend has no identity capability", async () => {
    const backend = new MockBackend();
    const client = await readyClient(backend);

    expect(await client.users.resolvePhone(LID)).toBeUndefined();
    expect(await client.users.resolveLid(PN)).toBeUndefined();
  });

  it("resolves undefined for unknown schemes and when the provider cannot map", async () => {
    const backend = new CapableMockBackend();
    const client = await readyClient(backend);

    expect(await client.users.resolvePhone(GROUP)).toBeUndefined();
    expect(await client.users.resolveLid(LID)).toBe(LID);
    expect(await client.users.resolveLid(GROUP)).toBeUndefined();
    expect(await client.users.resolvePhone(LID)).toBeUndefined();
    expect(await client.users.resolveLid(PN)).toBeUndefined();
    expect(backend.lidLookups).toEqual([LID]);
    expect(backend.phoneLookups).toEqual([PHONE_DIGITS]);
  });

  it("propagates provider failures as backend errors", async () => {
    const backend = new CapableMockBackend();
    backend.identityError = new Error("boom");
    const client = await readyClient(backend);

    await expect(client.users.resolvePhone(LID)).rejects.toThrow(BackendError);
    await expect(client.users.resolveLid(PN)).rejects.toThrow(BackendError);
  });
});

describe("client.users.fetch", () => {
  it("accepts phone jids, legacy jids, device suffixes and bare digits", async () => {
    const backend = new CapableMockBackend();
    const client = await readyClient(backend);

    for (const input of [
      PN,
      "5511999999999@c.us",
      "5511999999999:12@s.whatsapp.net",
      "5511999999999",
      "+5511999999999",
    ]) {
      const user = await client.users.fetch(input);
      expect(user?.id).toBe(PN);
      expect(user?.phone).toBe(PHONE_DIGITS);
    }
    expect(backend.userFetchCalls).toEqual(Array.from({ length: 5 }, () => PHONE_DIGITS));
  });

  it("resolves undefined when the provider reports no account", async () => {
    const backend = new CapableMockBackend();
    backend.userLookup = { exists: false };
    const client = await readyClient(backend);

    expect(await client.users.fetch(PN)).toBeUndefined();
    expect(backend.userFetchCalls).toEqual([PHONE_DIGITS]);
  });

  it("checks linked ids under their resolved phone number", async () => {
    const backend = new CapableMockBackend();
    backend.phoneForLidResult = PHONE_DIGITS;
    const client = await readyClient(backend);

    const user = await client.users.fetch(LID);
    expect(user?.id).toBe(LID);
    expect(user?.phone).toBe(PHONE_DIGITS);
    expect(backend.lidLookups).toEqual([LID]);
    expect(backend.userFetchCalls).toEqual([PHONE_DIGITS]);
    // The pair discovered on the way answers later lookups.
    expect(client.users.altId(LID)).toBe(PN);
  });

  it("fetches linked ids through previously recorded pairs", async () => {
    const backend = new CapableMockBackend();
    backend.lidForPhoneResult = LID;
    const client = await readyClient(backend);
    await client.users.resolveLid(PN);

    const user = await client.users.fetch(LID);
    expect(user?.id).toBe(LID);
    expect(user?.phone).toBe(PHONE_DIGITS);
    expect(backend.userFetchCalls).toEqual([PHONE_DIGITS]);
    expect(backend.lidLookups).toEqual([]);
  });

  it("resolves undefined for linked ids the provider cannot map", async () => {
    const backend = new CapableMockBackend();
    backend.phoneForLidResult = null;
    const client = await readyClient(backend);

    expect(await client.users.fetch(LID)).toBeUndefined();
    expect(backend.userFetchCalls).toEqual([]);
  });

  it("prefers the lookup's name and falls back to the remembered push name", async () => {
    const backend = new CapableMockBackend();
    const client = await readyClient(backend);
    const received: Interaction[] = [];
    client.on("interactionCreate", (interaction) => {
      received.push(interaction);
    });

    backend.emit("message", messageEvent({ authorId: PN, authorName: "Gustavo" }));
    await vi.waitFor(() => expect(received).toHaveLength(1));

    // Without a provider name, the remembered push name answers.
    const remembered = await client.users.fetch(PN);
    expect(remembered?.name).toBe("Gustavo");

    // A provider-supplied name wins — and becomes the remembered one.
    backend.userLookup = { exists: true, name: "Fresh Name" };
    const fresh = await client.users.fetch(PN);
    expect(fresh?.name).toBe("Fresh Name");

    backend.userLookup = { exists: true };
    const after = await client.users.fetch(PN);
    expect(after?.name).toBe("Fresh Name");
  });

  it("rejects malformed ids with ERR_INVALID_USER_ID", async () => {
    const backend = new CapableMockBackend();
    const client = await readyClient(backend);

    await expect(client.users.fetch("hello")).rejects.toBeInstanceOf(ValidationError);
    for (const bad of [
      "",
      "   ",
      GROUP,
      "123@elsewhere",
      "abc@lid",
      "@lid",
      "111@s.whatsapp.net2",
    ]) {
      await expect(client.users.fetch(bad)).rejects.toMatchObject({
        code: "ERR_INVALID_USER_ID",
      });
    }
    expect(backend.userFetchCalls).toEqual([]);
  });

  it("throws UnsupportedOperationError when capabilities are missing", async () => {
    const plain = new MockBackend();
    const plainClient = await readyClient(plain);
    await expect(plainClient.users.fetch(PN)).rejects.toBeInstanceOf(UnsupportedOperationError);
    await expect(plainClient.users.fetch(LID)).rejects.toBeInstanceOf(UnsupportedOperationError);

    // Existence checks without linked-id resolution still fetch phone ids.
    class LookupOnlyBackend extends MockBackend {
      async fetchUser(): Promise<{ exists: boolean }> {
        return { exists: true };
      }
    }
    const lookupOnly = new LookupOnlyBackend();
    const client = await readyClient(lookupOnly);
    expect(await client.users.fetch(PN)).toBeDefined();
    await expect(client.users.fetch(LID)).rejects.toMatchObject({ code: "ERR_UNSUPPORTED" });
  });

  it("propagates provider failures as backend errors", async () => {
    const backend = new CapableMockBackend();
    backend.fetchError = new Error("boom");
    const client = await readyClient(backend);

    await expect(client.users.fetch(PN)).rejects.toThrow(BackendError);
  });
});

describe("client.users picture/about/accountType", () => {
  it("fetches profile picture urls for both id schemes with default and explicit types", async () => {
    const backend = new CapableMockBackend();
    backend.pictureUrlResult = "https://pps.example/pic.jpg";
    const client = await readyClient(backend);

    expect(await client.users.pictureUrl(PN)).toBe("https://pps.example/pic.jpg");
    expect(await client.users.pictureUrl(PN, "preview")).toBe("https://pps.example/pic.jpg");
    expect(await client.users.pictureUrl(LID)).toBe("https://pps.example/pic.jpg");
    expect(backend.pictureCalls).toEqual([PN, PN, LID]);
    expect(backend.pictureTypeCalls).toEqual(["image", "preview", "image"]);
  });

  it("resolves undefined for accounts without a picture", async () => {
    const backend = new CapableMockBackend();
    const client = await readyClient(backend);

    expect(await client.users.pictureUrl(PN)).toBeUndefined();
    expect(await client.users.about(PN)).toBeUndefined();
  });

  it("normalizes input formats like fetch", async () => {
    const backend = new CapableMockBackend();
    const client = await readyClient(backend);

    await client.users.pictureUrl("5511999999999");
    await client.users.pictureUrl("+5511999999999");
    await client.users.pictureUrl("5511999999999@c.us");
    expect(backend.pictureCalls).toEqual([PN, PN, PN]);
  });

  it("fetches about texts", async () => {
    const backend = new CapableMockBackend();
    backend.aboutResult = "living la vida loca";
    const client = await readyClient(backend);

    expect(await client.users.about(PN)).toBe("living la vida loca");
    expect(await client.users.about(LID)).toBe("living la vida loca");
    expect(backend.aboutCalls).toEqual([PN, LID]);
  });

  it("classifies accounts by probing the business profile", async () => {
    const backend = new CapableMockBackend();
    const client = await readyClient(backend);

    expect(await client.users.accountType(PN)).toBe("standard");
    expect(backend.businessCalls).toEqual([PN]);

    backend.businessProfileResult = {
      description: "we sell things",
      category: "Shopping & Retail",
      email: "hi@example.com",
      website: ["https://example.com"],
      address: "São Paulo",
    };
    expect(await client.users.accountType(LID)).toBe("business");
    expect(backend.businessCalls).toEqual([PN, LID]);
  });

  it("rejects malformed ids with ERR_INVALID_USER_ID", async () => {
    const backend = new CapableMockBackend();
    const client = await readyClient(backend);

    for (const bad of ["", "   ", GROUP, "abc@lid"]) {
      await expect(client.users.pictureUrl(bad)).rejects.toMatchObject({
        code: "ERR_INVALID_USER_ID",
      });
      await expect(client.users.about(bad)).rejects.toMatchObject({
        code: "ERR_INVALID_USER_ID",
      });
      await expect(client.users.accountType(bad)).rejects.toMatchObject({
        code: "ERR_INVALID_USER_ID",
      });
    }
    expect(backend.pictureCalls).toEqual([]);
    expect(backend.aboutCalls).toEqual([]);
    expect(backend.businessCalls).toEqual([]);
  });

  it("throws UnsupportedOperationError when capabilities are missing", async () => {
    const plain = new MockBackend();
    const plainClient = await readyClient(plain);

    await expect(plainClient.users.pictureUrl(PN)).rejects.toBeInstanceOf(
      UnsupportedOperationError,
    );
    await expect(plainClient.users.about(PN)).rejects.toBeInstanceOf(UnsupportedOperationError);
    await expect(plainClient.users.accountType(PN)).rejects.toBeInstanceOf(
      UnsupportedOperationError,
    );
  });

  it("propagates provider failures as backend errors", async () => {
    const backend = new CapableMockBackend();
    backend.profileError = new Error("boom");
    const client = await readyClient(backend);

    await expect(client.users.pictureUrl(PN)).rejects.toThrow(BackendError);
    await expect(client.users.about(PN)).rejects.toThrow(BackendError);
    await expect(client.users.accountType(PN)).rejects.toThrow(BackendError);
    expect(backend.pictureCalls).toEqual([]);
  });
});

describe("push-name memory", () => {
  it("carries names seen on messages to later id-only users", async () => {
    const backend = new CapableMockBackend();
    const client = await readyClient(backend);
    const received: Interaction[] = [];
    client.on("interactionCreate", (interaction) => {
      received.push(interaction);
    });

    backend.emit(
      "message",
      messageEvent({ chatId: GROUP, chatKind: "group", authorId: LID, authorName: "Gustavo" }),
    );
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]?.author?.name).toBe("Gustavo");

    // Later payloads that carry only ids still know the name.
    backend.emit(
      "message",
      messageEvent({
        id: "msg-2",
        chatId: GROUP,
        chatKind: "group",
        authorId: LID,
        authorName: undefined,
        mentions: [LID],
      }),
    );
    backend.emit("reaction", reactionEvent({ chatId: GROUP, chatKind: "group", reactorId: LID }));
    await vi.waitFor(() => expect(received).toHaveLength(3));

    const second = received[1];
    expect(second?.author?.name).toBe("Gustavo");
    if (second?.isMessage()) {
      expect(second.message.mentions[0]?.name).toBe("Gustavo");
    }
    expect(received[2]?.author?.name).toBe("Gustavo");
  });

  it("shares names across linked id pairs", async () => {
    const backend = new CapableMockBackend();
    const client = await readyClient(backend);
    const received: Interaction[] = [];
    client.on("interactionCreate", (interaction) => {
      received.push(interaction);
    });

    backend.emit(
      "message",
      messageEvent({ authorId: PN, authorName: "Alice", idPairs: [{ id: LID, altId: PN }] }),
    );
    await vi.waitFor(() => expect(received).toHaveLength(1));

    backend.emit("message", messageEvent({ id: "msg-2", authorId: LID, authorName: undefined }));
    await vi.waitFor(() => expect(received).toHaveLength(2));
    expect(received[1]?.author?.name).toBe("Alice");
  });

  it("fills group members with remembered names", async () => {
    const backend = new CapableMockBackend();
    const client = await readyClient(backend);
    const received: Interaction[] = [];
    client.on("interactionCreate", (interaction) => {
      received.push(interaction);
    });

    backend.emit(
      "message",
      messageEvent({ chatId: GROUP, chatKind: "group", authorId: LID, authorName: "Gustavo" }),
    );
    await vi.waitFor(() => expect(received).toHaveLength(1));

    const fixture = groupMetadataFixture(GROUP);
    backend.metadataFixture = {
      ...fixture,
      participants: [
        ...fixture.participants,
        { id: LID, altId: PN, role: "member", name: undefined },
      ],
    };
    const group = await client.groups.fetch(GROUP);

    expect(group.members.find((member) => member.user.id === LID)?.user.name).toBe("Gustavo");
  });
});
