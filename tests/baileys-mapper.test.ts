import { WAMessageStubType } from "@whiskeysockets/baileys";
import type {
  ParticipantAction,
  GroupMetadata as ProviderGroupMetadata,
  GroupParticipant as ProviderGroupParticipant,
  WAMessage,
  WAMessageKey,
  WAMessageUpdate,
} from "@whiskeysockets/baileys";
import { describe, expect, it } from "vitest";
import {
  mapChatKind,
  mapGroupMetadata,
  mapGroupParticipants,
  mapGroupUpdates,
  mapIncomingMessage,
  mapMessageUpdates,
  mapMessagesDelete,
  mapReaction,
  providerDate,
} from "../src/backend/baileys/BaileysMapper.js";
import type {
  MapperContext,
  ProviderGroupParticipantsEvent,
  ProviderMessagesDelete,
} from "../src/backend/baileys/BaileysMapper.js";
import type { ChatId } from "../src/core/ids.js";

const SELF_ID = "999@s.whatsapp.net";
const TIMESTAMP = 1_700_000_000;

interface Harness {
  readonly context: MapperContext;
  readonly cached: Map<string, WAMessage>;
  downloads: number;
}

function harness(selfId: string | null = SELF_ID): Harness {
  const cached = new Map<string, WAMessage>();
  const harnessRef: Harness = {
    downloads: 0,
    cached,
    context: {
      selfId: selfId ?? undefined,
      cacheRaw(chatId: ChatId, messageId: string, message: WAMessage) {
        cached.set(`${chatId}:${messageId}`, message);
      },
      createDownloader() {
        return async () => {
          harnessRef.downloads += 1;
          return new Uint8Array([7, 7, 7]);
        };
      },
    },
  };
  return harnessRef;
}

describe("mapChatKind", () => {
  it("classifies provider jids", () => {
    expect(mapChatKind("123456789@g.us")).toBe("group");
    expect(mapChatKind("111@s.whatsapp.net")).toBe("direct");
    expect(mapChatKind("222:13@s.whatsapp.net")).toBe("direct");
    expect(mapChatKind("5511999999999@lid")).toBe("direct");
    expect(mapChatKind("newsletter@newsletter")).toBe("newsletter");
    expect(mapChatKind("123-456@broadcast")).toBe("broadcast");
    expect(mapChatKind("mystery@somewhere")).toBe("unknown");
  });
});

describe("mapIncomingMessage", () => {
  it("maps plain conversation text with all defaults", () => {
    const { context, cached } = harness();
    const message: WAMessage = {
      key: { remoteJid: "111@s.whatsapp.net", id: "MSG1", fromMe: false },
      message: { conversation: "hello there" },
      messageTimestamp: TIMESTAMP,
      pushName: "Alice",
    };
    const event = mapIncomingMessage(message, context);
    expect(event).not.toBeNull();
    if (event === null) return;
    expect(event.id).toBe("MSG1");
    expect(event.chatId).toBe("111@s.whatsapp.net");
    expect(event.chatKind).toBe("direct");
    expect(event.authorId).toBe("111@s.whatsapp.net");
    expect(event.authorName).toBe("Alice");
    expect(event.timestamp).toEqual(new Date(TIMESTAMP * 1000));
    expect(event.content).toEqual({ kind: "text", text: "hello there" });
    expect(event.isFromMe).toBe(false);
    expect(event.isForwarded).toBe(false);
    expect(event.mentions).toEqual([]);
    expect(event.reference).toBeUndefined();
    expect(cached.get("111@s.whatsapp.net:MSG1")).toBe(message);
  });

  it("attributes own messages to the logged-in user", () => {
    const { context } = harness();
    const event = mapIncomingMessage(
      {
        key: { remoteJid: "111@s.whatsapp.net", id: "M2", fromMe: true },
        message: { conversation: "outgoing" },
        messageTimestamp: TIMESTAMP,
      },
      context,
    );
    expect(event?.authorId).toBe(SELF_ID);
    expect(event?.isFromMe).toBe(true);
    expect(event?.authorName).toBeUndefined();
  });

  it("falls back to the chat id when no self id is known", () => {
    const { context } = harness(null);
    const event = mapIncomingMessage(
      {
        key: { remoteJid: "111@s.whatsapp.net", id: "M3", fromMe: true },
        message: { conversation: "outgoing" },
      },
      context,
    );
    expect(event?.authorId).toBe("111@s.whatsapp.net");
  });

  it("normalizes group messages and device suffixes", () => {
    const { context } = harness();
    const event = mapIncomingMessage(
      {
        key: {
          remoteJid: "123456789@g.us",
          id: "G1",
          fromMe: false,
          participant: "222:13@s.whatsapp.net",
        },
        message: { conversation: "group hi" },
        messageTimestamp: TIMESTAMP,
      },
      context,
    );
    expect(event?.chatKind).toBe("group");
    expect(event?.chatId).toBe("123456789@g.us");
    expect(event?.authorId).toBe("222@s.whatsapp.net");
  });

  it("resolves quoted references, mentions and forwarding from context info", () => {
    const { context, cached } = harness();
    const event = mapIncomingMessage(
      {
        key: { remoteJid: "111@s.whatsapp.net", id: "M4", fromMe: false },
        message: {
          extendedTextMessage: {
            text: "replying to you",
            contextInfo: {
              stanzaId: "QUOTED1",
              participant: "333:7@s.whatsapp.net",
              quotedMessage: { conversation: "original text" },
              mentionedJid: ["222@s.whatsapp.net"],
              isForwarded: true,
            },
          },
        },
        messageTimestamp: TIMESTAMP,
      },
      context,
    );
    expect(event?.content).toEqual({ kind: "text", text: "replying to you" });
    expect(event?.mentions).toEqual(["222@s.whatsapp.net"]);
    expect(event?.isForwarded).toBe(true);
    expect(event?.reference).toEqual({
      messageId: "QUOTED1",
      chatId: "111@s.whatsapp.net",
      authorId: "333@s.whatsapp.net",
      content: { kind: "text", text: "original text" },
    });
    const quotedRaw = cached.get("111@s.whatsapp.net:QUOTED1");
    expect(quotedRaw?.message?.conversation).toBe("original text");
  });

  it("detects forwarding scores and newsletter forwards", () => {
    const { context } = harness();
    const event = mapIncomingMessage(
      {
        key: { remoteJid: "111@s.whatsapp.net", id: "F1", fromMe: false },
        message: {
          extendedTextMessage: {
            text: "fw",
            contextInfo: { forwardingScore: 3, isForwarded: false },
          },
        },
      },
      context,
    );
    expect(event?.isForwarded).toBe(true);
  });

  it("maps image messages with attachment metadata and lazy downloads", async () => {
    const { context } = harness();
    const event = mapIncomingMessage(
      {
        key: { remoteJid: "111@s.whatsapp.net", id: "IMG1", fromMe: false },
        message: {
          imageMessage: {
            caption: "look at this",
            mimetype: "image/png",
            fileLength: 2048,
          },
        },
        messageTimestamp: TIMESTAMP,
      },
      context,
    );
    expect(event?.content.kind).toBe("image");
    if (event?.content.kind !== "image") return;
    expect(event.content.caption).toBe("look at this");
    expect(event.content.attachment).toMatchObject({
      kind: "image",
      mimeType: "image/png",
      size: 2048,
      fileName: undefined,
      isVoiceNote: false,
      isAnimated: false,
    });
    const bytes = await event.content.attachment.download();
    expect(bytes).toEqual(new Uint8Array([7, 7, 7]));
  });

  it("defaults missing media fields", () => {
    const { context } = harness();
    const event = mapIncomingMessage(
      {
        key: { remoteJid: "111@s.whatsapp.net", id: "IMG2", fromMe: false },
        message: { imageMessage: {} },
      },
      context,
    );
    if (event?.content.kind !== "image") throw new Error("expected image content");
    expect(event.content.caption).toBe("");
    expect(event.content.attachment.mimeType).toBe("application/octet-stream");
    expect(event.content.attachment.size).toBeUndefined();
  });

  it("maps audio voice notes, documents, stickers and videos", () => {
    const { context } = harness();
    const audio = mapIncomingMessage(
      {
        key: { remoteJid: "111@s.whatsapp.net", id: "A1", fromMe: false },
        message: { audioMessage: { mimetype: "audio/ogg", ptt: true, seconds: 12 } },
      },
      context,
    );
    if (audio?.content.kind !== "audio") throw new Error("expected audio");
    expect(audio.content.attachment.isVoiceNote).toBe(true);
    expect(audio.content.attachment.durationSeconds).toBe(12);

    const document = mapIncomingMessage(
      {
        key: { remoteJid: "111@s.whatsapp.net", id: "D1", fromMe: false },
        message: {
          documentMessage: { mimetype: "application/pdf", fileName: "report.pdf", caption: "doc" },
        },
      },
      context,
    );
    if (document?.content.kind !== "document") throw new Error("expected document");
    expect(document.content.caption).toBe("doc");
    expect(document.content.attachment.fileName).toBe("report.pdf");

    const sticker = mapIncomingMessage(
      {
        key: { remoteJid: "111@s.whatsapp.net", id: "S1", fromMe: false },
        message: { stickerMessage: { isAnimated: true } },
      },
      context,
    );
    if (sticker?.content.kind !== "sticker") throw new Error("expected sticker");
    expect(sticker.content.attachment.isAnimated).toBe(true);

    const video = mapIncomingMessage(
      {
        key: { remoteJid: "111@s.whatsapp.net", id: "V1", fromMe: false },
        message: { videoMessage: { gifPlayback: true, caption: "gif" } },
      },
      context,
    );
    if (video?.content.kind !== "video") throw new Error("expected video");
    expect(video.content.attachment.isAnimated).toBe(true);
    expect(video.content.caption).toBe("gif");
  });

  it("maps static and live locations", () => {
    const { context } = harness();
    const location = mapIncomingMessage(
      {
        key: { remoteJid: "111@s.whatsapp.net", id: "L1", fromMe: false },
        message: {
          locationMessage: {
            degreesLatitude: -23.55,
            degreesLongitude: -46.63,
            address: "Sao Paulo",
            name: "Home",
          },
        },
      },
      context,
    );
    expect(location?.content).toEqual({
      kind: "location",
      latitude: -23.55,
      longitude: -46.63,
      address: "Sao Paulo",
      name: "Home",
    });

    const live = mapIncomingMessage(
      {
        key: { remoteJid: "111@s.whatsapp.net", id: "L2", fromMe: false },
        message: {
          liveLocationMessage: { degreesLatitude: 1, degreesLongitude: 2 },
        },
      },
      context,
    );
    expect(live?.content).toEqual({
      kind: "location",
      latitude: 1,
      longitude: 2,
      address: undefined,
      name: undefined,
    });
  });

  it("maps contact cards from vcard data", () => {
    const { context } = harness();
    const event = mapIncomingMessage(
      {
        key: { remoteJid: "111@s.whatsapp.net", id: "C1", fromMe: false },
        message: {
          contactMessage: {
            displayName: "Alice",
            vcard:
              "BEGIN:VCARD\nVERSION:3.0\nFN:Alice Silva\nTEL;type=cell:+5511999999999\nEND:VCARD",
          },
        },
      },
      context,
    );
    expect(event?.content).toEqual({
      kind: "contact",
      cards: [{ name: "Alice", phone: "+5511999999999" }],
    });
  });

  it("maps polls with provider option names", () => {
    const { context } = harness();
    const event = mapIncomingMessage(
      {
        key: { remoteJid: "111@s.whatsapp.net", id: "P1", fromMe: false },
        message: {
          pollCreationMessage: {
            name: "Lunch?",
            options: [{ optionName: "Pizza" }, { optionName: "Sushi" }],
            selectableOptionsCount: 2,
          },
        },
      },
      context,
    );
    expect(event?.content).toEqual({
      kind: "poll",
      name: "Lunch?",
      options: ["Pizza", "Sushi"],
      selectableCount: 2,
    });
  });

  it("defaults the poll selectable count", () => {
    const { context } = harness();
    const event = mapIncomingMessage(
      {
        key: { remoteJid: "111@s.whatsapp.net", id: "P2", fromMe: false },
        message: { pollCreationMessage: { name: "Q", options: [{ optionName: "A" }] } },
      },
      context,
    );
    if (event?.content.kind !== "poll") throw new Error("expected poll");
    expect(event.content.selectableCount).toBe(1);
  });

  it("maps button replies with the prompt title from the quote", () => {
    const { context } = harness();
    const plain = mapIncomingMessage(
      {
        key: { remoteJid: "111@s.whatsapp.net", id: "B1", fromMe: false },
        message: {
          buttonsResponseMessage: {
            selectedButtonId: "btn-yes",
            selectedDisplayText: "Yes",
            contextInfo: { quotedMessage: { buttonsMessage: { contentText: "Continue?" } } },
          },
        },
      },
      context,
    );
    expect(plain?.content).toEqual({
      kind: "buttonReply",
      buttonId: "btn-yes",
      title: "Continue?",
      displayText: "Yes",
      variant: "plain",
    });

    const template = mapIncomingMessage(
      {
        key: { remoteJid: "111@s.whatsapp.net", id: "B2", fromMe: false },
        message: {
          templateButtonReplyMessage: {
            selectedId: "tpl-1",
            selectedDisplayText: "Choose",
            contextInfo: { quotedMessage: { buttonsMessage: { contentText: "Pick one" } } },
          },
        },
      },
      context,
    );
    expect(template?.content).toMatchObject({
      kind: "buttonReply",
      buttonId: "tpl-1",
      title: "Pick one",
      variant: "template",
    });
  });

  it("maps native-flow interactive responses", () => {
    const { context } = harness();
    const event = mapIncomingMessage(
      {
        key: { remoteJid: "111@s.whatsapp.net", id: "B3", fromMe: false },
        message: {
          interactiveResponseMessage: {
            nativeFlowResponseMessage: {
              name: "quick_reply",
              paramsJson: '{"id":"flow-btn-9"}',
            },
          },
        },
      },
      context,
    );
    expect(event?.content).toEqual({
      kind: "buttonReply",
      buttonId: "flow-btn-9",
      title: "",
      displayText: "quick_reply",
      variant: "plain",
    });
  });

  it("maps list replies", () => {
    const { context } = harness();
    const event = mapIncomingMessage(
      {
        key: { remoteJid: "111@s.whatsapp.net", id: "LST1", fromMe: false },
        message: {
          listResponseMessage: {
            title: "Menu",
            description: "Main options",
            singleSelectReply: { selectedRowId: "row-2" },
          },
        },
      },
      context,
    );
    expect(event?.content).toEqual({
      kind: "listReply",
      rowId: "row-2",
      title: "Menu",
      description: "Main options",
    });
  });

  it("unwraps provider content wrappers", () => {
    const { context } = harness();
    const event = mapIncomingMessage(
      {
        key: { remoteJid: "111@s.whatsapp.net", id: "W1", fromMe: false },
        message: {
          ephemeralMessage: {
            message: {
              viewOnceMessageV2: { message: { conversation: "wrapped secret" } },
            },
          },
        },
        messageTimestamp: TIMESTAMP,
      },
      context,
    );
    expect(event?.content).toEqual({ kind: "text", text: "wrapped secret" });

    const edited = mapIncomingMessage(
      {
        key: { remoteJid: "111@s.whatsapp.net", id: "W2", fromMe: false },
        message: { editedMessage: { message: { conversation: "after edit" } } },
      },
      context,
    );
    expect(edited?.content).toEqual({ kind: "text", text: "after edit" });

    const deviceSent = mapIncomingMessage(
      {
        key: { remoteJid: "111@s.whatsapp.net", id: "W3", fromMe: true },
        message: {
          deviceSentMessage: { message: { conversation: "from other device" } },
        },
      },
      context,
    );
    expect(deviceSent?.content).toEqual({ kind: "text", text: "from other device" });
  });

  it("skips protocol and reaction payloads", () => {
    const { context } = harness();
    expect(
      mapIncomingMessage(
        {
          key: { remoteJid: "111@s.whatsapp.net", id: "X1", fromMe: false },
          message: { protocolMessage: { type: 0 } },
        },
        context,
      ),
    ).toBeNull();
    expect(
      mapIncomingMessage(
        {
          key: { remoteJid: "111@s.whatsapp.net", id: "X2", fromMe: false },
          message: { reactionMessage: {} },
        },
        context,
      ),
    ).toBeNull();
    expect(
      mapIncomingMessage(
        {
          key: { remoteJid: "111@s.whatsapp.net", id: "X3", fromMe: false },
          message: { messageContextInfo: {} },
        },
        context,
      ),
    ).toBeNull();
  });

  it("keeps content when sender-key distribution rides along", () => {
    const { context } = harness();
    // The first message a sender delivers in a group carries the sender-key
    // distribution next to the real text — the plumbing must not shadow it.
    const event = mapIncomingMessage(
      {
        key: {
          remoteJid: "123456789@g.us",
          id: "F1",
          fromMe: false,
          participant: "111@s.whatsapp.net",
        },
        message: {
          messageContextInfo: {},
          senderKeyDistributionMessage: {
            groupId: "123456789@g.us",
            axolotlSenderKeyDistributionMessage: new Uint8Array([1, 2, 3]),
          },
          conversation: "first message!",
        },
        messageTimestamp: TIMESTAMP,
        pushName: "Alice",
      },
      context,
    );
    expect(event).not.toBeNull();
    expect(event?.content).toEqual({ kind: "text", text: "first message!" });
    expect(event?.authorName).toBe("Alice");
    expect(event?.chatKind).toBe("group");
    expect(event?.authorId).toBe("111@s.whatsapp.net");

    // A distribution-only stanza carries nothing user-visible and stays skipped.
    expect(
      mapIncomingMessage(
        {
          key: {
            remoteJid: "123456789@g.us",
            id: "F2",
            fromMe: false,
            participant: "111@s.whatsapp.net",
          },
          message: {
            senderKeyDistributionMessage: { groupId: "123456789@g.us" },
          },
        },
        context,
      ),
    ).toBeNull();
    expect(
      mapIncomingMessage(
        {
          key: {
            remoteJid: "123456789@g.us",
            id: "F3",
            fromMe: false,
            participant: "111@s.whatsapp.net",
          },
          message: {
            fastRatchetKeySenderKeyDistributionMessage: { groupId: "123456789@g.us" },
          },
        },
        context,
      ),
    ).toBeNull();
  });

  it("normalizes unknown content kinds", () => {
    const { context } = harness();
    const event = mapIncomingMessage(
      {
        key: { remoteJid: "111@s.whatsapp.net", id: "U1", fromMe: false },
        message: { someFutureMessageType: { payload: 1 } },
      } as unknown as WAMessage,
      context,
    );
    expect(event?.content).toEqual({ kind: "unknown", description: "someFutureMessageType" });
  });

  it("rejects malformed messages", () => {
    const { context } = harness();
    expect(
      mapIncomingMessage({ message: { conversation: "hi" } } as unknown as WAMessage, context),
    ).toBeNull();
    expect(
      mapIncomingMessage({ key: { remoteJid: "111@s.whatsapp.net" }, message: {} }, context),
    ).toBeNull();
    expect(
      mapIncomingMessage(
        { key: { id: "M", fromMe: false }, message: { conversation: "hi" } },
        context,
      ),
    ).toBeNull();
    expect(
      mapIncomingMessage({ key: { remoteJid: "111@s.whatsapp.net", id: "M" } }, context),
    ).toBeNull();
    expect(
      mapIncomingMessage(
        { key: { remoteJid: "", id: "M", fromMe: false }, message: { conversation: "hi" } },
        context,
      ),
    ).toBeNull();
  });

  it("accepts Long-like timestamps and defaults missing ones", () => {
    const { context } = harness();
    const longLike = mapIncomingMessage(
      {
        key: { remoteJid: "111@s.whatsapp.net", id: "T1", fromMe: false },
        message: { conversation: "hi" },
        messageTimestamp: { toNumber: () => TIMESTAMP } as unknown as number,
      },
      context,
    );
    expect(longLike?.timestamp).toEqual(new Date(TIMESTAMP * 1000));

    const start = Date.now();
    const noTimestamp = mapIncomingMessage(
      {
        key: { remoteJid: "111@s.whatsapp.net", id: "T2", fromMe: false },
        message: { conversation: "hi" },
      },
      context,
    );
    expect(noTimestamp?.timestamp.getTime()).toBeGreaterThanOrEqual(start - 1000);
  });
});

describe("providerDate", () => {
  it("converts seconds to dates", () => {
    expect(providerDate(TIMESTAMP)).toEqual(new Date(TIMESTAMP * 1000));
    expect(providerDate(null).getTime()).toBeGreaterThan(0);
    expect(providerDate(0).getTime()).toBeGreaterThan(0);
    expect(providerDate("not a number").getTime()).toBeGreaterThan(0);
  });
});

describe("mapMessageUpdates", () => {
  it("maps revocation stubs to delete events", () => {
    const { context } = harness();
    const updates: WAMessageUpdate[] = [
      {
        key: { remoteJid: "111@s.whatsapp.net", id: "MSG1", fromMe: false },
        update: { messageStubType: WAMessageStubType.REVOKE },
      },
    ];
    const events = mapMessageUpdates(updates, context);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "delete",
      chatId: "111@s.whatsapp.net",
      messageId: "MSG1",
      content: undefined,
    });
  });

  it("maps message:null updates to delete events", () => {
    const { context } = harness();
    const events = mapMessageUpdates(
      [
        {
          key: { remoteJid: "111@s.whatsapp.net", id: "MSG2", fromMe: true },
          update: { message: null },
        },
      ],
      context,
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe("delete");
    expect(events[0]?.authorId).toBe(SELF_ID);
  });

  it("maps edited messages to edit events", () => {
    const { context } = harness();
    const events = mapMessageUpdates(
      [
        {
          key: { remoteJid: "111@s.whatsapp.net", id: "MSG3", fromMe: false },
          update: { message: { editedMessage: { message: { conversation: "new text" } } } },
        },
      ],
      context,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "edit",
      messageId: "MSG3",
      content: { kind: "text", text: "new text" },
    });
  });

  it("ignores status-only updates", () => {
    const { context } = harness();
    const events = mapMessageUpdates(
      [{ key: { remoteJid: "111@s.whatsapp.net", id: "MSG4" }, update: { status: 3 } }],
      context,
    );
    expect(events).toEqual([]);
  });

  it("ignores updates without usable keys", () => {
    const { context } = harness();
    expect(mapMessageUpdates([{ key: {}, update: { status: 1 } }], context)).toEqual([]);
  });
});

describe("mapMessagesDelete", () => {
  it("maps key lists to delete events", () => {
    const { context } = harness();
    const event: ProviderMessagesDelete = {
      keys: [{ remoteJid: "111@s.whatsapp.net", id: "D1", fromMe: false }],
    };
    const events = mapMessagesDelete(event, context);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: "delete", messageId: "D1" });
  });

  it("ignores chat-wide delete-all payloads", () => {
    const { context } = harness();
    expect(mapMessagesDelete({ jid: "111@s.whatsapp.net", all: true }, context)).toEqual([]);
  });
});

describe("mapReaction", () => {
  it("maps added reactions with reactor identity", () => {
    const { context } = harness();
    const event = mapReaction(
      {
        key: { remoteJid: "111@s.whatsapp.net", id: "MSG1", fromMe: false },
        reaction: {
          key: {
            remoteJid: "111@s.whatsapp.net",
            id: "MSG1",
            fromMe: false,
            participant: "222@s.whatsapp.net",
          },
          text: "👍",
          senderTimestampMs: 1_700_000_000_000,
        },
      },
      context,
    );
    expect(event).toMatchObject({
      id: "reaction:111@s.whatsapp.net:MSG1:222@s.whatsapp.net",
      chatId: "111@s.whatsapp.net",
      messageId: "MSG1",
      reactorId: "222@s.whatsapp.net",
      emoji: "👍",
    });
    expect(event?.timestamp).toEqual(new Date(1_700_000_000_000));
  });

  it("maps own reactions to the logged-in user", () => {
    const { context } = harness();
    const event = mapReaction(
      {
        key: { remoteJid: "111@s.whatsapp.net", id: "MSG1", fromMe: false },
        reaction: { key: { remoteJid: "111@s.whatsapp.net", id: "MSG1", fromMe: true }, text: "❤" },
      },
      context,
    );
    expect(event?.reactorId).toBe(SELF_ID);
    expect(event?.emoji).toBe("❤");
  });

  it("maps removed reactions to null emoji", () => {
    const { context } = harness();
    const event = mapReaction(
      {
        key: { remoteJid: "111@s.whatsapp.net", id: "MSG1", fromMe: false },
        reaction: { key: null, text: "" },
      },
      context,
    );
    expect(event?.emoji).toBeNull();
    expect(event?.reactorId).toBe(SELF_ID);
  });

  it("rejects unusable reaction keys", () => {
    const { context } = harness();
    expect(mapReaction({ key: { id: "MSG1" }, reaction: { text: "👍" } }, context)).toBeNull();
  });
});

describe("mapGroupParticipants", () => {
  function providerEvent(
    overrides: Partial<ProviderGroupParticipantsEvent> = {},
  ): ProviderGroupParticipantsEvent {
    return {
      id: "123456789@g.us",
      author: "111@s.whatsapp.net",
      participants: [{ id: "222@s.whatsapp.net" }] as ProviderGroupParticipant[],
      action: "add",
      ...overrides,
    };
  }

  it("maps membership actions", () => {
    const { context } = harness();
    for (const action of ["add", "remove", "promote", "demote"] as const) {
      const event = mapGroupParticipants(providerEvent({ action }), context);
      expect(event?.action, action).toBe(action);
      expect(event?.groupId).toBe("123456789@g.us");
      expect(event?.participantIds).toEqual(["222@s.whatsapp.net"]);
      expect(event?.actorId).toBe("111@s.whatsapp.net");
    }
  });

  it("maps unknown provider actions to other", () => {
    const { context } = harness();
    const event = mapGroupParticipants(
      providerEvent({ action: "modify" as ParticipantAction }),
      context,
    );
    expect(event?.action).toBe("other");
  });

  it("normalizes participant and actor jids", () => {
    const { context } = harness();
    const event = mapGroupParticipants(
      providerEvent({
        author: null,
        participants: [{ id: "333:21@s.whatsapp.net" }] as ProviderGroupParticipant[],
      }),
      context,
    );
    expect(event?.participantIds).toEqual(["333@s.whatsapp.net"]);
    expect(event?.actorId).toBeUndefined();
  });

  it("drops events without participants or a group id", () => {
    const { context } = harness();
    expect(mapGroupParticipants(providerEvent({ participants: [] }), context)).toBeNull();
    expect(mapGroupParticipants(providerEvent({ id: "" }), context)).toBeNull();
  });
});

describe("mapGroupUpdates", () => {
  it("maps subject, description and settings changes", () => {
    const { context } = harness();
    const events = mapGroupUpdates(
      [
        {
          id: "123456789@g.us",
          subject: "New subject",
          desc: "New desc",
          announce: true,
          restrict: true,
        },
      ],
      context,
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.changes).toEqual({
      name: "New subject",
      description: "New desc",
      announceOnly: true,
      locked: true,
    });
    expect(events[0]?.groupId).toBe("123456789@g.us");
  });

  it("normalizes cleared descriptions", () => {
    const { context } = harness();
    const events = mapGroupUpdates(
      [{ id: "123456789@g.us", desc: null }] as unknown as Partial<ProviderGroupMetadata>[],
      context,
    );
    expect(events[0]?.changes.description).toBe("");
  });

  it("skips empty and unusable patches", () => {
    const { context } = harness();
    expect(mapGroupUpdates([{ id: "123456789@g.us" }], context)).toEqual([]);
    expect(mapGroupUpdates([{}], context)).toEqual([]);
    expect(mapGroupUpdates([{ subject: "no id" }], context)).toEqual([]);
  });
});

describe("mapGroupMetadata", () => {
  it("maps full metadata with roles and timestamps", () => {
    const metadata: ProviderGroupMetadata = {
      id: "123456789@g.us",
      subject: "Test Group",
      desc: "Description",
      owner: "111@s.whatsapp.net",
      creation: TIMESTAMP,
      announce: true,
      restrict: true,
      participants: [
        { id: "111@s.whatsapp.net", admin: "superadmin", name: "Owner" },
        { id: "222:3@s.whatsapp.net", admin: "admin" },
        { id: "333@s.whatsapp.net" },
      ] as ProviderGroupParticipant[],
    };
    const mapped = mapGroupMetadata(metadata);
    expect(mapped).toEqual({
      id: "123456789@g.us",
      name: "Test Group",
      description: "Description",
      ownerId: "111@s.whatsapp.net",
      createdAt: new Date(TIMESTAMP * 1000),
      participants: [
        { id: "111@s.whatsapp.net", role: "superadmin", name: "Owner" },
        { id: "222@s.whatsapp.net", role: "admin", name: undefined },
        { id: "333@s.whatsapp.net", role: "member", name: undefined },
      ],
      announceOnly: true,
      locked: true,
    });
  });

  it("applies defaults for sparse metadata", () => {
    const mapped = mapGroupMetadata({
      id: "123456789@g.us",
      subject: "Sparse",
    } as unknown as ProviderGroupMetadata);
    expect(mapped).toEqual({
      id: "123456789@g.us",
      name: "Sparse",
      description: undefined,
      ownerId: undefined,
      createdAt: undefined,
      participants: [],
      announceOnly: false,
      locked: false,
    });
  });

  it("maps participant usernames and drops empty ones", () => {
    const mapped = mapGroupMetadata({
      id: "123456789@g.us",
      subject: "Handles",
      participants: [
        { id: "111@s.whatsapp.net", admin: "admin", username: "gustavo" },
        { id: "222@s.whatsapp.net", admin: null, username: "" },
        { id: "333@s.whatsapp.net", admin: null },
      ] as ProviderGroupParticipant[],
    } as unknown as ProviderGroupMetadata);
    expect(mapped.participants.map((participant) => participant.username)).toEqual([
      "gustavo",
      undefined,
      undefined,
    ]);
  });
});

describe("id pair capture", () => {
  it("captures participant and chat pairs from incoming messages", () => {
    const { context, cached } = harness();
    const message: WAMessage = {
      key: {
        remoteJid: "987654321012345@lid",
        remoteJidAlt: "5511999999999@s.whatsapp.net",
        id: "MSG1",
        fromMe: false,
        participant: "111222333444555@lid",
        participantAlt: "5511888888888@s.whatsapp.net",
      },
      message: { conversation: "hi" },
      messageTimestamp: TIMESTAMP,
    };
    const event = mapIncomingMessage(message, context);
    expect(event?.idPairs).toEqual([
      { id: "111222333444555@lid", altId: "5511888888888@s.whatsapp.net" },
      { id: "987654321012345@lid", altId: "5511999999999@s.whatsapp.net" },
    ]);
    expect(cached.has("987654321012345@lid:MSG1")).toBe(true);
  });

  it("omits idPairs when the key carries a single scheme", () => {
    const { context } = harness();
    const message: WAMessage = {
      key: { remoteJid: "111@s.whatsapp.net", id: "MSG2", fromMe: false },
      message: { conversation: "hi" },
      messageTimestamp: TIMESTAMP,
    };
    expect(mapIncomingMessage(message, context)?.idPairs).toBeUndefined();
  });

  it("captures pairs from reaction keys", () => {
    const { context } = harness();
    const event = mapReaction(
      {
        key: { remoteJid: "123456789@g.us", id: "MSG3", fromMe: false },
        reaction: {
          key: {
            remoteJid: "123456789@g.us",
            id: "MSG3",
            fromMe: false,
            participant: "5511999999999@s.whatsapp.net",
            participantAlt: "987654321012345@lid",
          } as WAMessageKey,
          text: "👍",
          senderTimestampMs: 1_700_000_000_000,
        },
      },
      context,
    );
    expect(event?.idPairs).toContainEqual({
      id: "5511999999999@s.whatsapp.net",
      altId: "987654321012345@lid",
    });
  });

  it("captures pairs from message update keys", () => {
    const { context } = harness();
    const events = mapMessageUpdates(
      [
        {
          key: {
            remoteJid: "123456789@g.us",
            id: "MSG4",
            fromMe: false,
            participant: "5511999999999@s.whatsapp.net",
            participantAlt: "987654321012345@lid",
          },
          update: { messageStubType: WAMessageStubType.REVOKE },
        },
      ],
      context,
    );
    expect(events[0]?.idPairs).toContainEqual({
      id: "5511999999999@s.whatsapp.net",
      altId: "987654321012345@lid",
    });
  });

  it("captures actor and participant pairs from membership events", () => {
    const { context } = harness();
    const event = mapGroupParticipants(
      {
        id: "123456789@g.us",
        author: "5511999999999@lid",
        authorPn: "5511999999999@s.whatsapp.net",
        participants: [
          { id: "987654321012345@lid", phoneNumber: "5511888888888@s.whatsapp.net" },
          { id: "5511777777777@s.whatsapp.net", lid: "111222333444555@lid" },
          { id: "5511666666666@s.whatsapp.net" },
        ] as ProviderGroupParticipant[],
        action: "add",
      },
      context,
    );
    expect(event?.idPairs).toEqual([
      { id: "987654321012345@lid", altId: "5511888888888@s.whatsapp.net" },
      { id: "5511777777777@s.whatsapp.net", altId: "111222333444555@lid" },
      { id: "5511999999999@lid", altId: "5511999999999@s.whatsapp.net" },
    ]);
  });

  it("captures participant alt ids from group metadata", () => {
    const mapped = mapGroupMetadata({
      id: "123456789@g.us",
      subject: "Paired",
      participants: [
        { id: "987654321012345@lid", phoneNumber: "5511999999999@s.whatsapp.net" },
        { id: "5511888888888@s.whatsapp.net", lid: "111222333444555@lid" },
        { id: "5511777777777@s.whatsapp.net" },
      ] as ProviderGroupParticipant[],
    } as unknown as ProviderGroupMetadata);
    expect(mapped.participants.map((participant) => participant.altId)).toEqual([
      "5511999999999@s.whatsapp.net",
      "111222333444555@lid",
      undefined,
    ]);
  });
});

describe("WAMessageKey typing sanity", () => {
  it("accepts partial provider keys in fixtures", () => {
    const key: WAMessageKey = { remoteJid: "111@s.whatsapp.net", id: "X" };
    expect(key.fromMe).toBeUndefined();
  });
});
