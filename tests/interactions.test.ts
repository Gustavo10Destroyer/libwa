import { describe, expect, it, vi } from "vitest";
import { Client } from "../src/Client.js";
import { MemorySessionStore } from "../src/auth/MemorySessionStore.js";
import { CommandRegistry } from "../src/commands/CommandRegistry.js";
import type { Attachment } from "../src/core/content.js";
import { Chat } from "../src/entities/Chat.js";
import { EntityFactory } from "../src/entities/EntityFactory.js";
import type { Interaction } from "../src/interactions/Interaction.js";
import { InteractionFactory } from "../src/interactions/InteractionFactory.js";
import { InteractionType } from "../src/interactions/InteractionType.js";
import { MockBackend, groupMetadataFixture } from "./helpers/MockBackend.js";
import {
  groupParticipantsEvent,
  groupUpdateEvent,
  messageEvent,
  messageUpdateEvent,
  reactionEvent,
} from "./helpers/fixtures.js";

interface Harness {
  readonly client: Client;
  readonly entities: EntityFactory;
  readonly registry: CommandRegistry;
  readonly factory: InteractionFactory;
}

function harness(
  commandOptions: { prefixes: readonly string[]; ignoreSelf: boolean } | null = {
    prefixes: ["!"],
    ignoreSelf: false,
  },
): Harness {
  const client = new Client({
    backend: new MockBackend(),
    sessionStore: new MemorySessionStore(),
  });
  const registry = new CommandRegistry();
  const entities = new EntityFactory(client);
  const factory = new InteractionFactory(client, entities, registry, commandOptions);
  return { client, entities, registry, factory };
}

function attachmentFixture(overrides: Partial<Attachment> = {}): Attachment {
  return {
    kind: "image",
    mimeType: "image/jpeg",
    size: 1024,
    fileName: undefined,
    durationSeconds: undefined,
    isVoiceNote: false,
    isAnimated: false,
    download: async () => new Uint8Array([1]),
    ...overrides,
  };
}

describe("InteractionFactory messages", () => {
  it("creates a MessageInteraction for plain text", () => {
    const { factory } = harness();
    const interaction = factory.fromMessage(messageEvent());
    expect(interaction.type).toBe(InteractionType.Message);
    expect(interaction.isMessage()).toBe(true);
    expect(interaction.isCommand()).toBe(false);
    if (!interaction.isMessage()) return;
    expect(interaction.isText()).toBe(true);
    expect(interaction.id).toBe("msg-1");
    expect(interaction.text).toBe("hello");
    expect(interaction.author?.name).toBe("Alice");
    expect(interaction.chat.id).toBe("111@s.whatsapp.net");
    expect(interaction.chat.isDirect()).toBe(true);
    expect(interaction.isFromGroup()).toBe(false);
  });

  it("creates a CommandInteraction when the prefix matches", () => {
    const { factory, registry } = harness();
    const command = { name: "ping", execute: () => undefined };
    registry.register(command);
    const interaction = factory.fromMessage(
      messageEvent({ content: { kind: "text", text: "!ping a b" } }),
    );
    expect(interaction.isCommand()).toBe(true);
    expect(interaction.isMessage()).toBe(true);
    if (!interaction.isCommand()) return;
    expect(interaction.type).toBe(InteractionType.Command);
    expect(interaction.name).toBe("ping");
    expect(interaction.args).toEqual(["a", "b"]);
    expect(interaction.rawArgs).toBe("a b");
    expect(interaction.command).toBe(command);
    expect(interaction.text).toBe("!ping a b");
  });

  it("keeps unknown prefixed commands as commands", () => {
    const { factory } = harness();
    const interaction = factory.fromMessage(
      messageEvent({ content: { kind: "text", text: "!unknown arg" } }),
    );
    expect(interaction.isCommand()).toBe(true);
    if (!interaction.isCommand()) return;
    expect(interaction.command).toBeUndefined();
    expect(interaction.name).toBe("unknown");
  });

  it("does not parse own messages when ignoreSelf is enabled", () => {
    const { factory } = harness({ prefixes: ["!"], ignoreSelf: true });
    const interaction = factory.fromMessage(
      messageEvent({ content: { kind: "text", text: "!ping" }, isFromMe: true }),
    );
    expect(interaction.isCommand()).toBe(false);
    expect(interaction.isMessage()).toBe(true);
  });

  it("does not parse commands when parsing is disabled", () => {
    const { factory } = harness(null);
    const interaction = factory.fromMessage(
      messageEvent({ content: { kind: "text", text: "!ping" } }),
    );
    expect(interaction.isCommand()).toBe(false);
  });

  it("creates a ButtonInteraction for button replies", () => {
    const { factory } = harness();
    const interaction = factory.fromMessage(
      messageEvent({
        content: {
          kind: "buttonReply",
          buttonId: "btn-ok",
          title: "Choose one",
          displayText: "OK",
          variant: "template",
        },
      }),
    );
    expect(interaction.isButton()).toBe(true);
    expect(interaction.isMessage()).toBe(false);
    if (!interaction.isButton()) return;
    expect(interaction.buttonId).toBe("btn-ok");
    expect(interaction.title).toBe("Choose one");
    expect(interaction.displayText).toBe("OK");
    expect(interaction.variant).toBe("template");
  });

  it("creates a ListInteraction for list replies", () => {
    const { factory } = harness();
    const interaction = factory.fromMessage(
      messageEvent({
        content: {
          kind: "listReply",
          rowId: "row-1",
          title: "First",
          description: "First option",
        },
      }),
    );
    expect(interaction.isList()).toBe(true);
    if (!interaction.isList()) return;
    expect(interaction.rowId).toBe("row-1");
    expect(interaction.title).toBe("First");
    expect(interaction.description).toBe("First option");
  });

  it("exposes quoted references and media attachments", () => {
    const { factory } = harness();
    const interaction = factory.fromMessage(
      messageEvent({
        content: { kind: "image", caption: "pic", attachment: attachmentFixture() },
        reference: {
          messageId: "quoted-9",
          chatId: "111@s.whatsapp.net",
          authorId: "111@s.whatsapp.net",
          content: { kind: "text", text: "before" },
        },
        mentions: ["222@s.whatsapp.net"],
      }),
    );
    if (!interaction.isMessage()) return;
    expect(interaction.isImage()).toBe(true);
    expect(interaction.isMedia()).toBe(true);
    expect(interaction.isReply).toBe(true);
    expect(interaction.reference?.messageId).toBe("quoted-9");
    expect(interaction.mentions.map((user) => user.id)).toEqual(["222@s.whatsapp.net"]);
    expect(interaction.attachments).toHaveLength(1);
  });

  it("replies quoting the interaction's own message", async () => {
    const backend = new MockBackend();
    const client = new Client({ backend, sessionStore: new MemorySessionStore() });
    const factory = new InteractionFactory(
      client,
      new EntityFactory(client),
      new CommandRegistry(),
      { prefixes: ["!"], ignoreSelf: false },
    );
    const interaction = factory.fromMessage(messageEvent());
    await interaction.reply("pong");
    expect(backend.sent[0]?.replyToMessageId).toBe("msg-1");
    expect(backend.sent[0]?.content).toEqual({ kind: "text", text: "pong" });
  });
});

describe("InteractionFactory other events", () => {
  it("creates a ReactionInteraction", () => {
    const { factory } = harness();
    const interaction: Interaction = factory.fromReaction(reactionEvent());
    expect(interaction.isReaction()).toBe(true);
    if (!interaction.isReaction()) return;
    expect(interaction.emoji).toBe("👍");
    expect(interaction.author?.id).toBe("111@s.whatsapp.net");
    expect(interaction.chat.id).toBe("111@s.whatsapp.net");
  });

  it("creates MessageUpdateInteractions for edits and deletes", () => {
    const { factory } = harness();
    const edit = factory.fromMessageUpdate(messageUpdateEvent());
    expect(edit.isMessageUpdate()).toBe(true);
    expect(edit.action).toBe("edit");
    expect(edit.content).toEqual({ kind: "text", text: "edited" });

    const remove = factory.fromMessageUpdate(
      messageUpdateEvent({ action: "delete", content: undefined }),
    );
    expect(remove.action).toBe("delete");
    expect(remove.content).toBeUndefined();
    expect(remove.id).not.toBe(edit.id);
  });

  it("creates GroupParticipantInteractions for membership changes", () => {
    const { factory } = harness();
    const interaction = factory.fromGroupParticipants(
      groupParticipantsEvent({ action: "promote", participantIds: ["222@s.whatsapp.net"] }),
    );
    expect(interaction.isGroupParticipantUpdate()).toBe(true);
    expect(interaction.action).toBe("promote");
    expect(interaction.isFromGroup()).toBe(true);
    expect(interaction.chat.kind).toBe("group");
    expect(interaction.group).toBe(interaction.chat);
    expect(interaction.users.map((user) => user.id)).toEqual(["222@s.whatsapp.net"]);
    expect(interaction.user?.id).toBe("222@s.whatsapp.net");
    expect(interaction.author?.id).toBe("111@s.whatsapp.net");
    expect(interaction.isFromMe).toBe(false);
  });

  it("exposes the affected user singular alongside users", () => {
    const { factory } = harness();
    const single = factory.fromGroupParticipants(
      groupParticipantsEvent({ action: "remove", participantIds: ["333@s.whatsapp.net"] }),
    );
    expect(single.user?.id).toBe("333@s.whatsapp.net");
    expect(single.user).toBe(single.users[0]);

    const batch = factory.fromGroupParticipants(
      groupParticipantsEvent({
        action: "add",
        participantIds: ["444@s.whatsapp.net", "555@s.whatsapp.net"],
      }),
    );
    expect(batch.users).toHaveLength(2);
    expect(batch.user?.id).toBe("444@s.whatsapp.net");
  });

  it("exposes the group on any group-chat interaction after isFromGroup()", () => {
    const { factory } = harness();
    const groupMessage: Interaction = factory.fromMessage(
      messageEvent({ chatId: "123456789@g.us", chatKind: "group" }),
    );
    expect(groupMessage.isFromGroup()).toBe(true);
    if (!groupMessage.isFromGroup()) return;
    expect(groupMessage.group).toBeDefined();
    expect(groupMessage.group.id).toBe("123456789@g.us");
    expect(groupMessage.group).toBe(groupMessage.chat);

    const direct: Interaction = factory.fromMessage(messageEvent());
    expect(direct.isFromGroup()).toBe(false);
    expect(direct.group).toBeUndefined();
  });

  it("marks group actions performed by the bot itself", () => {
    const { factory, entities } = harness();
    entities.setSelf({ id: "5511888888888@s.whatsapp.net", name: "Bot" });
    const interaction = factory.fromGroupParticipants(
      groupParticipantsEvent({ actorId: "5511888888888@s.whatsapp.net" }),
    );
    expect(interaction.isFromMe).toBe(true);
  });

  it("creates GroupUpdateInteractions and applies changes", () => {
    const { factory } = harness();
    const interaction = factory.fromGroupUpdate(groupUpdateEvent());
    expect(interaction.isGroupUpdate()).toBe(true);
    if (!interaction.isGroupUpdate()) return;
    expect(interaction.changes.name).toBe("Renamed Group");
    expect(interaction.group.name).toBe("Renamed Group");
  });
});

describe("interaction.member", () => {
  const GROUP_ID = "123456789@g.us";
  const OWNER = "111@s.whatsapp.net";
  const PLAIN = "222@s.whatsapp.net";

  it("exposes the author's role, tag and user for group messages", () => {
    const { factory, entities } = harness();
    entities.applyGroupMetadata(groupMetadataFixture());
    const interaction: Interaction = factory.fromMessage(
      messageEvent({ chatId: GROUP_ID, chatKind: "group", authorId: OWNER, authorName: "Alice" }),
    );

    expect(interaction.isFromGroup()).toBe(true);
    expect(interaction.member?.role).toBe("admin");
    expect(interaction.member?.tag).toBe("Owner");
    expect(interaction.member?.user).toBe(interaction.author);
    expect(interaction.member?.user.id).toBe(OWNER);
  });

  it("exposes the member for reactions and group participant events too", () => {
    const { factory, entities } = harness();
    entities.applyGroupMetadata(groupMetadataFixture());

    const reaction = factory.fromReaction(
      reactionEvent({ chatId: GROUP_ID, chatKind: "group", reactorId: PLAIN }),
    );
    expect(reaction.member?.role).toBe("member");
    expect(reaction.member?.tag).toBeUndefined();

    const participants = factory.fromGroupParticipants(groupParticipantsEvent());
    expect(participants.member?.role).toBe("admin");
    expect(participants.member?.user).toBe(participants.author);
  });

  it("stays undefined without group context, metadata, author or participation", () => {
    const { factory, entities } = harness();

    // Direct chat.
    expect(factory.fromMessage(messageEvent()).member).toBeUndefined();
    // Group chat whose metadata is unknown.
    const unknownMetadata = factory.fromMessage(
      messageEvent({ chatId: GROUP_ID, chatKind: "group", authorId: OWNER }),
    );
    expect(unknownMetadata.member).toBeUndefined();
    // Group metadata known, but the author is not a participant.
    entities.applyGroupMetadata(groupMetadataFixture());
    expect(
      factory.fromMessage(
        messageEvent({ chatId: GROUP_ID, chatKind: "group", authorId: "999@s.whatsapp.net" }),
      ).member,
    ).toBeUndefined();
    // Group event without an author.
    expect(factory.fromGroupUpdate(groupUpdateEvent()).member).toBeUndefined();
  });

  it("matches participants across id schemes and keeps the given user", () => {
    const { factory, entities } = harness();
    const LID = "987654321012345@lid";
    const PN = "5511999999999@s.whatsapp.net";
    entities.applyGroupMetadata({
      ...groupMetadataFixture(),
      participants: [{ id: LID, altId: PN, role: "admin", name: undefined, username: "gustavo" }],
    });

    const byPn = factory.fromMessage(
      messageEvent({ chatId: GROUP_ID, chatKind: "group", authorId: PN, authorName: undefined }),
    );
    expect(byPn.member?.role).toBe("admin");
    expect(byPn.member?.tag).toBe("gustavo");
    expect(byPn.member?.user).toBe(byPn.author);
    expect(byPn.member?.user.id).toBe(PN);

    const byLid = factory.fromMessage(
      messageEvent({ id: "msg-2", chatId: GROUP_ID, chatKind: "group", authorId: LID }),
    );
    expect(byLid.member?.role).toBe("admin");
    expect(byLid.member?.tag).toBe("gustavo");
  });
});

describe("interaction construction safety", () => {
  it("rejects constructing plain Chat instances for groups", () => {
    const { client } = harness();
    expect(() => new Chat({ client, id: "123@g.us", kind: "group" })).toThrow(
      /must be constructed as Group/,
    );
  });

  it("exposes one listener-facing client reference", () => {
    const { factory, client } = harness();
    const interaction = factory.fromMessage(messageEvent());
    expect(interaction.client).toBe(client);
    const reply = vi.spyOn(client.messages, "send");
    void interaction.reply("x");
    expect(reply).toHaveBeenCalledTimes(1);
  });
});
