import type { SessionStore } from "../auth/SessionStore.js";
import type { ChatId, Unsubscribe, UserId } from "../core/ids.js";
import type { ChatKind, GroupMetadata, GroupParticipantAction } from "../entities/Chat.js";
import type { Logger } from "../logging/Logger.js";
import type { BackendEventListener, BackendEventMap, BackendEventName } from "./events.js";

/**
 * The backend contract.
 *
 * A backend adapts a concrete WhatsApp provider (Baileys today, others in the
 * future) to the library's normalized domain: it emits {@link BackendEventMap}
 * events, exposes command-style operations (send, react, group management) and
 * owns session serialization. The core depends exclusively on this interface,
 * which is what makes providers swappable without touching application code.
 */

/** Content accepted by {@link WhatsAppBackend.sendMessage}. */
export type OutboundContent =
  | {
      readonly kind: "text";
      readonly text: string;
    }
  | {
      readonly kind: "image" | "video" | "audio" | "document" | "sticker";
      readonly data: Uint8Array;
      readonly mimetype: string | undefined;
      readonly fileName: string | undefined;
      readonly caption: string | undefined;
      readonly voice: boolean;
      readonly durationSeconds: number | undefined;
      readonly animated: boolean;
    }
  | {
      readonly kind: "location";
      readonly latitude: number;
      readonly longitude: number;
      readonly address: string | undefined;
      readonly name: string | undefined;
    };

/** Normalized send request handed to a backend. */
export interface BackendSendMessage {
  readonly chatId: ChatId;
  readonly content: OutboundContent;
  /** Id of the message being replied to, when applicable. */
  readonly replyToMessageId: string | undefined;
  /** Users to @-mention, when the caller asked for mentions. */
  readonly mentionUserIds: readonly UserId[];
}

/** Confirmation returned after a message was accepted by the provider. */
export interface BackendSentMessage {
  readonly id: string;
  readonly chatId: ChatId;
  /** Classification of the target chat as the provider sees it. */
  readonly chatKind: ChatKind;
  readonly timestamp: Date;
}

/** Identifies a downloadable media payload by its message. */
export interface BackendMediaDownload {
  readonly chatId: ChatId;
  readonly messageId: string;
}

export interface BackendReactRequest {
  readonly chatId: ChatId;
  readonly messageId: string;
  /** Emoji to set, or `null` to remove the bot's reaction. */
  readonly emoji: string | null;
}

export interface BackendEditMessageRequest {
  readonly chatId: ChatId;
  readonly messageId: string;
  readonly text: string;
}

export interface BackendDeleteMessageRequest {
  readonly chatId: ChatId;
  readonly messageId: string;
}

export interface BackendGroupParticipantsRequest {
  readonly chatId: ChatId;
  readonly userIds: readonly UserId[];
  readonly action: Exclude<GroupParticipantAction, "other">;
}

export interface BackendGroupNameRequest {
  readonly chatId: ChatId;
  readonly name: string;
}

export interface BackendGroupDescriptionRequest {
  readonly chatId: ChatId;
  readonly description: string | undefined;
}

/** Result of a provider-side user existence lookup (`fetchUser`). */
export interface BackendUserLookup {
  /** Whether the account exists and is registered on WhatsApp. */
  readonly exists: boolean;
  /** Display name reported by the lookup, when the provider supplies one. */
  readonly name?: string | undefined;
  /** Verified (business) name reported by the lookup, when available. */
  readonly verifiedName?: string | undefined;
}

/** Everything a backend needs from the client in order to connect. */
export interface BackendConnectOptions {
  /** Session slot to use (see `ClientOptions.sessionId`). */
  readonly sessionId: string;
  /** Store used to persist the provider session. */
  readonly sessionStore: SessionStore;
  /** Logger for provider-level diagnostics. */
  readonly logger: Logger;
  /** Phone number (international, no `+`) for pairing-code login, if configured. */
  readonly pairingPhoneNumber: string | undefined;
}

/**
 * Provider adapter interface.
 *
 * Capabilities beyond the mandatory set are optional so that a backend can be
 * honest about what its provider supports; the core surfaces missing
 * capabilities as {@link UnsupportedOperationError} instead of failing at the
 * type level.
 */
export interface WhatsAppBackend {
  /** Stable identifier of the backend (e.g. `baileys`). Used in sessions/logs. */
  readonly id: string;

  /** Establishes a connection. May be called again after a disconnect. */
  connect(options: BackendConnectOptions): Promise<void>;
  /** Closes the current connection without clearing the session. */
  disconnect(): Promise<void>;
  /** Whether a connection is currently open. */
  isConnected(): boolean;

  /** Sends a message and returns its provider confirmation. */
  sendMessage(request: BackendSendMessage): Promise<BackendSentMessage>;
  /** Downloads media referenced by a previously received message. */
  downloadMedia(request: BackendMediaDownload): Promise<Uint8Array>;
  /** Fetches full metadata of a group. */
  getGroupMetadata(chatId: ChatId): Promise<GroupMetadata>;

  /** Subscribes to normalized backend events. Returns an unsubscribe function. */
  on<Name extends BackendEventName>(event: Name, listener: BackendEventListener<Name>): Unsubscribe;

  // --- optional capabilities -------------------------------------------------

  /** Adds or removes the bot's reaction on a message. */
  react?(request: BackendReactRequest): Promise<void>;
  /** Edits a message previously sent by the bot. */
  editMessage?(request: BackendEditMessageRequest): Promise<void>;
  /** Deletes a message (own message, or any message when the bot is admin). */
  deleteMessage?(request: BackendDeleteMessageRequest): Promise<void>;
  /** Adds/removes/promotes/demotes group participants. */
  updateGroupParticipants?(request: BackendGroupParticipantsRequest): Promise<void>;
  /** Renames a group. */
  updateGroupName?(request: BackendGroupNameRequest): Promise<void>;
  /** Updates (or clears) a group description. */
  updateGroupDescription?(request: BackendGroupDescriptionRequest): Promise<void>;
  /** Requests a pairing code for phone-number login. */
  requestPairingCode?(phoneNumber: string): Promise<string>;
  /** Invalidates the current session on the provider (remote logout). */
  logout?(): Promise<void>;

  // --- identity resolution ------------------------------------------------------

  /**
   * Resolves a linked id (`<digits>@lid`) to the account's phone-number
   * digits (international, no `+`), or `null` when the provider cannot map
   * it. (JID vs linked id: https://baileys.wiki/concepts/jids)
   */
  getPhoneNumberForLid?(lid: UserId): Promise<string | null>;
  /**
   * Resolves phone-number digits (international, no `+`) to the account's
   * linked id (`<digits>@lid`), or `null` when the provider cannot map it.
   */
  getLidForPhoneNumber?(phone: string): Promise<UserId | null>;
  /**
   * Checks whether an account is registered on WhatsApp.
   *
   * `phone` is the account's phone-number digits (international, no `+`);
   * linked ids must be resolved to digits first (`getPhoneNumberForLid`),
   * since providers key existence checks by phone number.
   * {@link UserService.fetch} performs that composition for callers.
   */
  fetchUser?(phone: string): Promise<BackendUserLookup>;
}
