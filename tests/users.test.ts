import { describe, expect, it, vi } from "vitest";
import { Client } from "../src/Client.js";
import { MemorySessionStore } from "../src/auth/MemorySessionStore.js";
import { BackendError } from "../src/errors/index.js";
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
    expect(group.members.find((member) => member.id === LID)?.phone).toBe(PHONE_DIGITS);
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

    expect(group.members.find((member) => member.id === LID)?.name).toBe("Gustavo");
  });
});
