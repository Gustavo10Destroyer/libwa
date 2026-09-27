import type { proto } from "@whiskeysockets/baileys";
import { WAMessageStubType, jidNormalizedUser } from "@whiskeysockets/baileys";
import type {
  ParticipantAction,
  GroupMetadata as ProviderGroupMetadata,
  GroupParticipant as ProviderGroupParticipant,
  WAMessage,
  WAMessageKey,
  WAMessageUpdate,
} from "@whiskeysockets/baileys";
import type { Attachment, ContactCard, MediaKind, MessageContent } from "../../core/content.js";
import type { ChatId, UserId } from "../../core/ids.js";
import type {
  ChatKind,
  GroupMetadata as DomainGroupMetadata,
  GroupParticipant as DomainGroupParticipant,
  GroupParticipantAction,
  GroupRole,
  GroupUpdateChanges,
} from "../../entities/Chat.js";
import type {
  BackendGroupParticipantsEvent,
  BackendGroupUpdateEvent,
  BackendMessageEvent,
  BackendMessageReference,
  BackendMessageUpdateEvent,
  BackendReactionEvent,
} from "../events.js";

/**
 * Baileys → domain mapping.
 *
 * This module is the only place where provider payload structures are
 * interpreted. Every function takes a {@link MapperContext} for the two
 * capabilities the mapping cannot provide itself (self identity and raw
 * message caching used by media downloads) and returns domain events or
 * `null` when a payload does not warrant an event.
 */

export interface MapperContext {
  /** Id of the logged-in user, once known. */
  readonly selfId: string | undefined;
  /** Caches a raw provider message so it can be quoted/downloaded later. */
  cacheRaw(chatId: ChatId, messageId: string, message: WAMessage): void;
  /** Builds a lazy media downloader for a (cached) message. */
  createDownloader(chatId: ChatId, messageId: string): () => Promise<Uint8Array>;
}

/** Payload of the provider's `messages.delete` event. */
export type ProviderMessagesDelete =
  | { readonly keys: readonly WAMessageKey[] }
  | { readonly jid: string; readonly all: true };

/** Payload of the provider's `group-participants.update` event. */
export interface ProviderGroupParticipantsEvent {
  readonly id: string;
  readonly author: string | null | undefined;
  readonly participants: readonly ProviderGroupParticipant[];
  readonly action: ParticipantAction;
}

/** Maps a provider chat id onto the library's chat classification. */
export function mapChatKind(jid: ChatId): ChatKind {
  if (jid.endsWith("@g.us")) return "group";
  if (jid.endsWith("@newsletter")) return "newsletter";
  if (jid.endsWith("@broadcast")) return "broadcast";
  if (jid.endsWith("@s.whatsapp.net") || jid.endsWith("@lid") || jid.endsWith("@c.us")) {
    return "direct";
  }
  return "unknown";
}

/** Normalizes a provider jid (strips device suffixes). */
function normalizeJid(jid: string): string {
  return jidNormalizedUser(jid);
}

/** True when the value is a non-empty string. */
function present(value: string | null | undefined): value is string {
  return value !== null && value !== undefined && value !== "";
}

/** Converts a nullable/Long-like number into a JS number when possible. */
function numericValue(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  const candidate = value as { toNumber?: unknown };
  if (typeof candidate.toNumber === "function") {
    const result = (value as { toNumber: () => number }).toNumber();
    return Number.isFinite(result) ? result : undefined;
  }
  const parsed = Number(String(value));
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Converts a provider timestamp (seconds) into a date, defaulting to now. */
export function providerDate(value: unknown): Date {
  const seconds = numericValue(value);
  if (seconds !== undefined && seconds > 0) {
    return new Date(seconds * 1000);
  }
  return new Date();
}

/**
 * Unwraps provider content wrappers (ephemeral, view-once, device-sent,
 * edit wrappers) until the inner content message is reached.
 */
function unwrapMessage(message: proto.IMessage | null | undefined): proto.IMessage | undefined {
  let current = message ?? undefined;
  for (let depth = 0; depth < 6 && current !== undefined; depth += 1) {
    const wrapped: proto.IMessage | undefined =
      current.ephemeralMessage?.message ??
      current.viewOnceMessage?.message ??
      current.viewOnceMessageV2?.message ??
      current.viewOnceMessageV2Extension?.message ??
      current.documentWithCaptionMessage?.message ??
      current.deviceSentMessage?.message ??
      current.editedMessage?.message ??
      undefined;
    if (wrapped === undefined) break;
    current = wrapped;
  }
  return current;
}

/** Content keys that never represent user-visible content on their own. */
const NON_CONTENT_KEYS: ReadonlySet<string> = new Set(["messageContextInfo", "botInvokeMessage"]);

interface ContentExtraction {
  readonly content: MessageContent;
  readonly context: proto.IContextInfo | undefined;
}

function contextOf(value: {
  readonly contextInfo?: proto.IContextInfo | null;
}): proto.IContextInfo | undefined {
  return value.contextInfo ?? undefined;
}

interface MediaSourceLike {
  readonly mimetype?: string | null;
  readonly fileLength?: unknown;
  readonly fileName?: string | null;
  readonly seconds?: unknown;
  readonly ptt?: boolean | null;
  readonly isAnimated?: boolean | null;
  readonly gifPlayback?: boolean | null;
}

function mediaAttachment(
  kind: MediaKind,
  source: MediaSourceLike,
  context: MapperContext,
  chatId: ChatId,
  messageId: string,
): Attachment {
  return {
    kind,
    mimeType: source.mimetype ?? "application/octet-stream",
    size: numericValue(source.fileLength),
    fileName: source.fileName ?? undefined,
    durationSeconds: numericValue(source.seconds),
    isVoiceNote: kind === "audio" ? source.ptt === true : false,
    isAnimated:
      kind === "sticker"
        ? source.isAnimated === true
        : kind === "video"
          ? source.gifPlayback === true
          : false,
    download: context.createDownloader(chatId, messageId),
  };
}

function vcardField(vcard: string | undefined, field: "FN" | "TEL"): string | undefined {
  if (vcard === undefined) return undefined;
  const match = new RegExp(`^${field}[^\\n]*:\\s*(.+)$`, "im").exec(vcard);
  const value = match?.[1]?.trim().replace(/^tel:/i, "");
  return present(value) ? value : undefined;
}

function contactCard(contact: proto.Message.IContactMessage): ContactCard {
  const vcard = contact.vcard ?? undefined;
  return {
    name: contact.displayName ?? vcardField(vcard, "FN") ?? "",
    phone: vcardField(vcard, "TEL"),
  };
}

/** Best-effort title of the prompt a button reply answers (from the quote). */
function promptTitle(context: proto.IContextInfo | undefined): string {
  const quoted = context?.quotedMessage;
  if (quoted === undefined || quoted === null) return "";
  const inner = unwrapMessage(quoted);
  if (inner === undefined) return "";
  return inner.buttonsMessage?.contentText ?? inner.listMessage?.title ?? "";
}

function nativeFlowButtonId(response: proto.Message.IInteractiveResponseMessage): {
  readonly buttonId: string;
  readonly displayText: string;
} {
  const flow = response.nativeFlowResponseMessage;
  const displayText = flow?.name ?? "";
  let buttonId = "";
  if (flow?.paramsJson) {
    try {
      const parsed: unknown = JSON.parse(flow.paramsJson);
      if (typeof parsed === "object" && parsed !== null) {
        const id = (parsed as { id?: unknown }).id;
        if (typeof id === "string") buttonId = id;
      }
    } catch {
      // Malformed params: fall back to the flow name below.
    }
  }
  if (!present(buttonId)) buttonId = displayText;
  return { buttonId, displayText };
}

/**
 * Extracts normalized content (and its context info) from an inner provider
 * content message. Returns `null` for payloads that surface through other
 * events instead (protocol/reaction/poll-vote messages).
 */
function extractContent(
  message: proto.IMessage,
  context: MapperContext,
  chatId: ChatId,
  messageId: string,
): ContentExtraction | null {
  if (
    message.protocolMessage != null ||
    message.reactionMessage != null ||
    message.pollUpdateMessage != null ||
    message.senderKeyDistributionMessage != null
  ) {
    return null;
  }

  if (typeof message.conversation === "string") {
    return { content: { kind: "text", text: message.conversation }, context: undefined };
  }

  const extended = message.extendedTextMessage;
  if (extended != null) {
    return { content: { kind: "text", text: extended.text ?? "" }, context: contextOf(extended) };
  }

  const image = message.imageMessage;
  if (image != null) {
    return {
      content: {
        kind: "image",
        caption: image.caption ?? "",
        attachment: mediaAttachment("image", image, context, chatId, messageId),
      },
      context: contextOf(image),
    };
  }

  const video = message.videoMessage;
  if (video != null) {
    return {
      content: {
        kind: "video",
        caption: video.caption ?? "",
        attachment: mediaAttachment("video", video, context, chatId, messageId),
      },
      context: contextOf(video),
    };
  }

  const audio = message.audioMessage;
  if (audio != null) {
    return {
      content: {
        kind: "audio",
        attachment: mediaAttachment("audio", audio, context, chatId, messageId),
      },
      context: contextOf(audio),
    };
  }

  const document = message.documentMessage;
  if (document != null) {
    return {
      content: {
        kind: "document",
        caption: document.caption ?? "",
        attachment: mediaAttachment("document", document, context, chatId, messageId),
      },
      context: contextOf(document),
    };
  }

  const sticker = message.stickerMessage;
  if (sticker != null) {
    return {
      content: {
        kind: "sticker",
        attachment: mediaAttachment("sticker", sticker, context, chatId, messageId),
      },
      context: contextOf(sticker),
    };
  }

  const location = message.locationMessage;
  if (location != null) {
    return {
      content: {
        kind: "location",
        latitude: location.degreesLatitude ?? 0,
        longitude: location.degreesLongitude ?? 0,
        address: location.address ?? undefined,
        name: location.name ?? undefined,
      },
      context: contextOf(location),
    };
  }

  const liveLocation = message.liveLocationMessage;
  if (liveLocation != null) {
    return {
      content: {
        kind: "location",
        latitude: liveLocation.degreesLatitude ?? 0,
        longitude: liveLocation.degreesLongitude ?? 0,
        address: undefined,
        name: undefined,
      },
      context: contextOf(liveLocation),
    };
  }

  const contact = message.contactMessage;
  if (contact != null) {
    return {
      content: { kind: "contact", cards: [contactCard(contact)] },
      context: contextOf(contact),
    };
  }

  const contacts = message.contactsArrayMessage;
  if (contacts != null) {
    return {
      content: {
        kind: "contact",
        cards: (contacts.contacts ?? []).map((entry) => contactCard(entry ?? {})),
      },
      context: contextOf(contacts),
    };
  }

  const poll = message.pollCreationMessage;
  if (poll != null) {
    return {
      content: {
        kind: "poll",
        name: poll.name ?? "",
        options: (poll.options ?? []).map((option) => option?.optionName ?? ""),
        selectableCount: numericValue(poll.selectableOptionsCount) ?? 1,
      },
      context: contextOf(poll),
    };
  }

  const buttons = message.buttonsResponseMessage;
  if (buttons != null) {
    const context = contextOf(buttons);
    return {
      content: {
        kind: "buttonReply",
        buttonId: buttons.selectedButtonId ?? "",
        title: promptTitle(context),
        displayText: buttons.selectedDisplayText ?? buttons.selectedButtonId ?? "",
        variant: "plain",
      },
      context,
    };
  }

  const template = message.templateButtonReplyMessage;
  if (template != null) {
    const context = contextOf(template);
    return {
      content: {
        kind: "buttonReply",
        buttonId: template.selectedId ?? "",
        title: promptTitle(context),
        displayText: template.selectedDisplayText ?? "",
        variant: "template",
      },
      context,
    };
  }

  const interactive = message.interactiveResponseMessage;
  if (interactive != null) {
    const context = contextOf(interactive);
    const { buttonId, displayText } = nativeFlowButtonId(interactive);
    return {
      content: {
        kind: "buttonReply",
        buttonId,
        title: promptTitle(context),
        displayText,
        variant: "plain",
      },
      context,
    };
  }

  const list = message.listResponseMessage;
  if (list != null) {
    return {
      content: {
        kind: "listReply",
        rowId: list.singleSelectReply?.selectedRowId ?? "",
        title: list.title ?? "",
        description: list.description ?? undefined,
      },
      context: contextOf(list),
    };
  }

  for (const [key, value] of Object.entries(message)) {
    if (value === undefined || value === null || NON_CONTENT_KEYS.has(key)) continue;
    return { content: { kind: "unknown", description: key }, context: undefined };
  }

  return null;
}

function resolveAuthorId(key: WAMessageKey, selfId: string | undefined, chatId: ChatId): UserId {
  const participant = key.participant ?? key.participantAlt;
  if (present(participant)) return normalizeJid(participant);
  if (key.fromMe === true) return selfId ?? chatId;
  return chatId;
}

function buildReference(
  context: proto.IContextInfo | null | undefined,
  mapperContext: MapperContext,
  chatId: ChatId,
): BackendMessageReference | undefined {
  if (context == null || !present(context.stanzaId)) return undefined;
  const quotedId = context.stanzaId;
  const participant = context.participant ?? undefined;
  const quotedMessage = context.quotedMessage ?? undefined;
  let content: MessageContent | undefined;
  if (quotedMessage != null) {
    const syntheticKey: WAMessageKey = { remoteJid: chatId, id: quotedId, fromMe: false };
    if (present(participant)) {
      syntheticKey.participant = participant;
    }
    mapperContext.cacheRaw(chatId, quotedId, { key: syntheticKey, message: quotedMessage });
    const inner = unwrapMessage(quotedMessage);
    if (inner !== undefined) {
      content = extractContent(inner, mapperContext, chatId, quotedId)?.content;
    }
  }
  return {
    messageId: quotedId,
    chatId,
    authorId: present(participant) ? normalizeJid(participant) : undefined,
    content,
  };
}

function extractMentions(context: proto.IContextInfo | null | undefined): readonly UserId[] {
  const mentioned = context?.mentionedJid;
  if (mentioned == null) return [];
  const mentions: UserId[] = [];
  for (const jid of mentioned) {
    if (present(jid)) mentions.push(normalizeJid(jid));
  }
  return mentions;
}

/** True when the provider marked the content as forwarded. */
function isForwardedContent(context: proto.IContextInfo | null | undefined): boolean {
  if (context == null) return false;
  return (
    context.isForwarded === true ||
    (context.forwardingScore ?? 0) > 0 ||
    context.forwardedNewsletterMessageInfo != null ||
    context.forwardedAiBotMessageInfo != null
  );
}

/** Maps a provider incoming message onto a normalized message event. */
export function mapIncomingMessage(
  message: WAMessage,
  context: MapperContext,
): BackendMessageEvent | null {
  const key = message.key;
  if (key == null || !present(key.remoteJid) || !present(key.id)) return null;
  const chatId = normalizeJid(key.remoteJid);
  const messageId = key.id;
  context.cacheRaw(chatId, messageId, message);

  const inner = unwrapMessage(message.message);
  if (inner === undefined) return null;
  const extraction = extractContent(inner, context, chatId, messageId);
  if (extraction === null) return null;

  const contextInfo = extraction.context;
  return {
    id: messageId,
    chatId,
    chatKind: mapChatKind(chatId),
    authorId: resolveAuthorId(key, context.selfId, chatId),
    authorName: message.pushName ?? undefined,
    timestamp: providerDate(message.messageTimestamp),
    content: extraction.content,
    isFromMe: key.fromMe === true,
    isForwarded: isForwardedContent(contextInfo),
    mentions: extractMentions(contextInfo),
    reference: buildReference(contextInfo, context, chatId),
  };
}

/** Maps provider message updates (edits, revocations) onto domain events. */
export function mapMessageUpdates(
  updates: readonly WAMessageUpdate[],
  context: MapperContext,
): BackendMessageUpdateEvent[] {
  const events: BackendMessageUpdateEvent[] = [];
  for (const entry of updates) {
    const key = entry.key;
    if (key == null || !present(key.remoteJid) || !present(key.id)) continue;
    const chatId = normalizeJid(key.remoteJid);
    const messageId = key.id;
    const chatKind = mapChatKind(chatId);
    const authorId = resolveAuthorId(key, context.selfId, chatId);
    const providerUpdate = entry.update;

    const revoked =
      providerUpdate.messageStubType === WAMessageStubType.REVOKE ||
      ("message" in providerUpdate &&
        (providerUpdate.message === null || providerUpdate.message === undefined));
    if (revoked) {
      events.push({
        action: "delete",
        chatId,
        chatKind,
        messageId,
        authorId,
        timestamp: new Date(),
        content: undefined,
      });
      continue;
    }

    const editedWrapper = providerUpdate.message?.editedMessage;
    const edited = editedWrapper?.message;
    if (edited != null) {
      const inner = unwrapMessage(edited);
      const extraction =
        inner === undefined ? null : extractContent(inner, context, chatId, messageId);
      if (extraction !== null) {
        events.push({
          action: "edit",
          chatId,
          chatKind,
          messageId,
          authorId,
          timestamp: new Date(),
          content: extraction.content,
        });
      }
    }
  }
  return events;
}

/** Maps the provider's `messages.delete` event onto domain events. */
export function mapMessagesDelete(
  event: ProviderMessagesDelete,
  context: MapperContext,
): BackendMessageUpdateEvent[] {
  if (!("keys" in event)) return [];
  const events: BackendMessageUpdateEvent[] = [];
  for (const key of event.keys) {
    if (key == null || !present(key.remoteJid) || !present(key.id)) continue;
    const chatId = normalizeJid(key.remoteJid);
    events.push({
      action: "delete",
      chatId,
      chatKind: mapChatKind(chatId),
      messageId: key.id,
      authorId: resolveAuthorId(key, context.selfId, chatId),
      timestamp: new Date(),
      content: undefined,
    });
  }
  return events;
}

function resolveReactionReactor(
  reactionKey: WAMessageKey | null | undefined,
  selfId: string | undefined,
  chatId: ChatId,
): UserId {
  if (reactionKey == null) return selfId ?? chatId;
  if (reactionKey.fromMe === true) return selfId ?? chatId;
  const participant = reactionKey.participant ?? reactionKey.participantAlt;
  if (present(participant)) return normalizeJid(participant);
  return present(reactionKey.remoteJid) ? normalizeJid(reactionKey.remoteJid) : chatId;
}

/** Maps a provider reaction entry onto a normalized reaction event. */
export function mapReaction(
  entry: {
    readonly key: WAMessageKey;
    readonly reaction: proto.IReaction;
  },
  context: MapperContext,
): BackendReactionEvent | null {
  const { key, reaction } = entry;
  if (key == null || !present(key.remoteJid) || !present(key.id)) return null;
  const chatId = normalizeJid(key.remoteJid);
  const emoji = present(reaction.text) ? reaction.text : null;
  const reactorId = resolveReactionReactor(reaction.key, context.selfId, chatId);
  const millis = numericValue(reaction.senderTimestampMs);
  return {
    id: `reaction:${chatId}:${key.id}:${reactorId}`,
    chatId,
    chatKind: mapChatKind(chatId),
    messageId: key.id,
    reactorId,
    timestamp: millis !== undefined && millis > 0 ? new Date(millis) : new Date(),
    emoji,
  };
}

/** Maps a provider group-participants event onto a domain event. */
export function mapGroupParticipants(
  event: ProviderGroupParticipantsEvent,
  _context: MapperContext,
): BackendGroupParticipantsEvent | null {
  const groupId = normalizeJid(event.id);
  if (!present(groupId)) return null;
  const participantIds: UserId[] = [];
  for (const participant of event.participants) {
    const id = normalizeJid(participant.id);
    if (present(id)) participantIds.push(id);
  }
  if (participantIds.length === 0) return null;
  const action: GroupParticipantAction =
    event.action === "add" ||
    event.action === "remove" ||
    event.action === "promote" ||
    event.action === "demote"
      ? event.action
      : "other";
  const timestamp = new Date();
  return {
    id: `${groupId}:${event.action}:${timestamp.getTime()}:${participantIds.join(",")}`,
    groupId,
    action,
    participantIds,
    actorId: present(event.author) ? normalizeJid(event.author) : undefined,
    timestamp,
  };
}

interface MutableChanges {
  name?: string;
  description?: string;
  announceOnly?: boolean;
  locked?: boolean;
}

/** Maps provider group metadata patches onto domain update events. */
export function mapGroupUpdates(
  updates: readonly Partial<ProviderGroupMetadata>[],
  _context: MapperContext,
): BackendGroupUpdateEvent[] {
  const events: BackendGroupUpdateEvent[] = [];
  for (const update of updates) {
    if (!present(update.id)) continue;
    const groupId = normalizeJid(update.id);
    const changes: MutableChanges = {};
    if (present(update.subject)) changes.name = update.subject;
    if (update.desc !== undefined) changes.description = update.desc ?? "";
    if (update.announce !== undefined && update.announce !== null) {
      changes.announceOnly = update.announce;
    }
    if (update.restrict !== undefined && update.restrict !== null) {
      changes.locked = update.restrict;
    }
    if (Object.keys(changes).length === 0) continue;
    const timestamp = new Date();
    events.push({
      id: `${groupId}:update:${timestamp.getTime()}`,
      groupId,
      timestamp,
      changes: { ...changes },
    });
  }
  return events;
}

function mapParticipant(participant: ProviderGroupParticipant): DomainGroupParticipant {
  const role: GroupRole =
    participant.admin === "superadmin"
      ? "superadmin"
      : participant.admin === "admin"
        ? "admin"
        : "member";
  return {
    id: normalizeJid(participant.id),
    role,
    name: participant.name ?? participant.notify ?? undefined,
  };
}

/** Maps full provider group metadata onto the domain representation. */
export function mapGroupMetadata(metadata: ProviderGroupMetadata): DomainGroupMetadata {
  return {
    id: normalizeJid(metadata.id),
    name: metadata.subject,
    description: metadata.desc ?? undefined,
    ownerId: present(metadata.owner) ? normalizeJid(metadata.owner) : undefined,
    createdAt:
      numericValue(metadata.creation) !== undefined
        ? new Date((numericValue(metadata.creation) ?? 0) * 1000)
        : undefined,
    participants: (metadata.participants ?? []).map((entry) => mapParticipant(entry ?? {})),
    announceOnly: metadata.announce ?? false,
    locked: metadata.restrict ?? false,
  };
}
