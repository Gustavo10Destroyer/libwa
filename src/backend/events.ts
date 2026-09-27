import type { DisconnectReason } from "../core/DisconnectReason.js";
import type { MessageContent } from "../core/content.js";
import type { ChatId, UserId } from "../core/ids.js";
import type { ChatKind, GroupParticipantAction, GroupUpdateChanges } from "../entities/Chat.js";

/**
 * Normalized events emitted by a {@link WhatsAppBackend}.
 *
 * Backend adapters translate their provider's raw events into these payloads;
 * the core then turns them into public interactions. Nothing in this module
 * may reference a specific provider — all types are library domain types.
 */

/** A quoted (replied-to) message, as far as the provider knows it. */
export interface BackendMessageReference {
  readonly messageId: string;
  readonly chatId: ChatId;
  readonly authorId: UserId | undefined;
  /** Content of the quoted message when the provider delivered it inline. */
  readonly content: MessageContent | undefined;
}

/** A normalized incoming or outgoing message. */
export interface BackendMessageEvent {
  /** Provider message id (unique within its chat). */
  readonly id: string;
  readonly chatId: ChatId;
  readonly chatKind: ChatKind;
  /** Author of the message. Equals the logged-in user for own messages. */
  readonly authorId: UserId;
  /** Display name supplied by the provider (e.g. push name), when known. */
  readonly authorName: string | undefined;
  readonly timestamp: Date;
  readonly content: MessageContent;
  readonly isFromMe: boolean;
  readonly isForwarded: boolean;
  /** Users mentioned in the message, when the provider reports them. */
  readonly mentions: readonly UserId[];
  readonly reference: BackendMessageReference | undefined;
}

/** A message was edited or deleted. */
export interface BackendMessageUpdateEvent {
  readonly action: "edit" | "delete";
  readonly chatId: ChatId;
  readonly chatKind: ChatKind;
  readonly messageId: string;
  readonly authorId: UserId | undefined;
  readonly timestamp: Date;
  /** New content for edits; `undefined` for deletions. */
  readonly content: MessageContent | undefined;
}

/** Someone reacted to (or removed a reaction from) a message. */
export interface BackendReactionEvent {
  /** Unique id of this reaction event. */
  readonly id: string;
  readonly chatId: ChatId;
  readonly chatKind: ChatKind;
  /** The message that was reacted to. */
  readonly messageId: string;
  /** The user who reacted (or removed their reaction). */
  readonly reactorId: UserId;
  readonly timestamp: Date;
  /** Emoji that was added, or `null` when the reaction was removed. */
  readonly emoji: string | null;
}

/** Membership/administrative changes inside a group. */
export interface BackendGroupParticipantsEvent {
  readonly id: string;
  readonly groupId: ChatId;
  readonly action: GroupParticipantAction;
  readonly participantIds: readonly UserId[];
  /** Who performed the action, when the provider reports an actor. */
  readonly actorId: UserId | undefined;
  readonly timestamp: Date;
}

/** Group metadata changes (name, description, settings). */
export interface BackendGroupUpdateEvent {
  readonly id: string;
  readonly groupId: ChatId;
  readonly timestamp: Date;
  readonly changes: GroupUpdateChanges;
}

/** Identity of the logged-in account. */
export interface BackendSelf {
  readonly id: UserId;
  readonly name: string | undefined;
}

/** Normalized connection lifecycle update. */
export interface BackendConnectionUpdate {
  readonly status: "connecting" | "open" | "close";
  /** QR code payload while waiting for a scan (only on `connecting`). */
  readonly qr: string | undefined;
  /** Present once the connection is open. */
  readonly me: BackendSelf | undefined;
  /** Present on `close`. */
  readonly reason: DisconnectReason | undefined;
  /** Provider detail preserved for logs/debugging. */
  readonly detail: string | undefined;
  /** Pairing code requested by the backend (only when configured to). */
  readonly pairingCode: string | undefined;
}

/**
 * The complete set of normalized events a backend may emit.
 *
 * The core subscribes to these and never subscribes to provider events.
 */
export interface BackendEventMap {
  /** A message was received. */
  message: [event: BackendMessageEvent];
  /** A message was edited or deleted. */
  messageUpdate: [event: BackendMessageUpdateEvent];
  /** A reaction was added or removed. */
  reaction: [event: BackendReactionEvent];
  /** Group participants were added/removed/promoted/demoted. */
  groupParticipants: [event: BackendGroupParticipantsEvent];
  /** Group metadata changed. */
  groupUpdate: [event: BackendGroupUpdateEvent];
  /** Connection lifecycle changed. */
  connection: [event: BackendConnectionUpdate];
}

export type BackendEventName = keyof BackendEventMap;

export type BackendEventListener<Name extends BackendEventName> = (
  ...args: BackendEventMap[Name]
) => void;
