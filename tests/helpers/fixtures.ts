import type {
  BackendGroupParticipantsEvent,
  BackendGroupUpdateEvent,
  BackendMessageEvent,
  BackendMessageReference,
  BackendMessageUpdateEvent,
  BackendReactionEvent,
} from "../../src/backend/events.js";

const NOW = 1_700_000_000_000;

/** A normalized incoming message event with sensible defaults. */
export function messageEvent(overrides: Partial<BackendMessageEvent> = {}): BackendMessageEvent {
  return {
    id: "msg-1",
    chatId: "111@s.whatsapp.net",
    chatKind: "direct",
    authorId: "111@s.whatsapp.net",
    authorName: "Alice",
    timestamp: new Date(NOW),
    content: { kind: "text", text: "hello" },
    isFromMe: false,
    isForwarded: false,
    mentions: [],
    reference: undefined,
    ...overrides,
  };
}

/** A quoted-message reference payload. */
export function referenceFixture(
  overrides: Partial<BackendMessageReference> = {},
): BackendMessageReference {
  return {
    messageId: "quoted-1",
    chatId: "111@s.whatsapp.net",
    authorId: "111@s.whatsapp.net",
    content: { kind: "text", text: "quoted text" },
    ...overrides,
  };
}

export function reactionEvent(overrides: Partial<BackendReactionEvent> = {}): BackendReactionEvent {
  return {
    id: "reaction-1",
    chatId: "111@s.whatsapp.net",
    chatKind: "direct",
    messageId: "msg-1",
    reactorId: "111@s.whatsapp.net",
    timestamp: new Date(NOW),
    emoji: "👍",
    ...overrides,
  };
}

export function messageUpdateEvent(
  overrides: Partial<BackendMessageUpdateEvent> = {},
): BackendMessageUpdateEvent {
  return {
    action: "edit",
    chatId: "111@s.whatsapp.net",
    chatKind: "direct",
    messageId: "msg-1",
    authorId: "111@s.whatsapp.net",
    timestamp: new Date(NOW),
    content: { kind: "text", text: "edited" },
    ...overrides,
  };
}

export function groupParticipantsEvent(
  overrides: Partial<BackendGroupParticipantsEvent> = {},
): BackendGroupParticipantsEvent {
  return {
    id: "group-event-1",
    groupId: "123456789@g.us",
    action: "add",
    participantIds: ["222@s.whatsapp.net"],
    actorId: "111@s.whatsapp.net",
    timestamp: new Date(NOW),
    ...overrides,
  };
}

export function groupUpdateEvent(
  overrides: Partial<BackendGroupUpdateEvent> = {},
): BackendGroupUpdateEvent {
  return {
    id: "group-update-1",
    groupId: "123456789@g.us",
    timestamp: new Date(NOW),
    ...overrides,
    changes: { name: "Renamed Group", ...overrides.changes },
  };
}
