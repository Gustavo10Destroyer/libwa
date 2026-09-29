/**
 * libwa — interaction-driven WhatsApp bot library.
 *
 * The public API surface: consumers import everything from the package root
 * (`import { Client } from "libwa"`). Provider internals (Baileys) never
 * appear in this surface; the default backend is created behind the
 * {@link WhatsAppBackend} contract.
 */

// --- client -------------------------------------------------------------------

export { Client, type ClientState } from "./Client.js";
export type { ClientEvents } from "./events/ClientEvents.js";
export type {
  ClientOptions,
  CommandOptions,
  ReconnectOptions,
  ResolvedClientOptions,
} from "./ClientOptions.js";

// --- errors -------------------------------------------------------------------

export {
  AuthenticationError,
  BackendError,
  ConnectionError,
  MessageError,
  NotFoundError,
  PermissionError,
  UnsupportedOperationError,
  ValidationError,
  WhatsAppError,
  rethrowAsBackendError,
  toError,
  type WhatsAppErrorOptions,
} from "./errors/index.js";

// --- core types ----------------------------------------------------------------

export { DisconnectReason, FATAL_DISCONNECT_REASONS } from "./core/DisconnectReason.js";
export type { ChatId, Unsubscribe, UserId } from "./core/ids.js";
export {
  contentAttachments,
  contentText,
  type Attachment,
  type AudioContent,
  type ButtonReplyContent,
  type ContactCard,
  type ContactContent,
  type DocumentContent,
  type ImageContent,
  type ListReplyContent,
  type LocationContent,
  type MediaInfo,
  type MediaKind,
  type MediaMessageContent,
  type MessageContent,
  type PollContent,
  type StickerContent,
  type TextContent,
  type UnknownContent,
  type VideoContent,
} from "./core/content.js";

// --- entities ------------------------------------------------------------------

export { Chat, Group } from "./entities/Chat.js";
export type {
  ChatKind,
  GroupMember,
  GroupMetadata,
  GroupParticipant,
  GroupParticipantAction,
  GroupRole,
  GroupUpdateChanges,
} from "./entities/Chat.js";
export { Message } from "./entities/Message.js";
export type { MessageReference } from "./entities/Message.js";
export { User, phoneFromId } from "./entities/User.js";

// --- interactions ---------------------------------------------------------------

export { Interaction } from "./interactions/Interaction.js";
export { InteractionType } from "./interactions/InteractionType.js";
export { MessageInteraction } from "./interactions/MessageInteraction.js";
export { CommandInteraction } from "./interactions/CommandInteraction.js";
export { ReactionInteraction } from "./interactions/ReactionInteraction.js";
export { MessageUpdateInteraction } from "./interactions/MessageUpdateInteraction.js";
export { GroupParticipantInteraction } from "./interactions/GroupParticipantInteraction.js";
export { GroupUpdateInteraction } from "./interactions/GroupUpdateInteraction.js";
export { ButtonInteraction } from "./interactions/ButtonInteraction.js";
export { ListInteraction } from "./interactions/ListInteraction.js";
export type { CommandParsingOptions } from "./interactions/InteractionFactory.js";

// --- commands --------------------------------------------------------------------

export { CommandRegistry } from "./commands/CommandRegistry.js";
export type { ParsedCommand } from "./commands/CommandRegistry.js";
export type { CommandDefinition } from "./commands/CommandDefinition.js";

// --- messaging -------------------------------------------------------------------

export { MessageService, type SendTarget } from "./messaging/MessageService.js";
export { GroupService, type GroupTarget } from "./groups/GroupService.js";
export { UserService, type AccountType } from "./users/UserService.js";
export type {
  MediaSource,
  MessagePayload,
  ReplyContent,
  SendOptions,
} from "./messaging/types.js";

// --- middleware -------------------------------------------------------------------

export type { Middleware } from "./middleware/compose.js";

// --- logging -----------------------------------------------------------------------

export { createConsoleLogger, nullLogger, type Logger } from "./logging/Logger.js";

// --- sessions ---------------------------------------------------------------------

export type { Session, SessionStore } from "./auth/SessionStore.js";
export { FileSessionStore, type FileSessionStoreOptions } from "./auth/FileSessionStore.js";
export { MemorySessionStore } from "./auth/MemorySessionStore.js";

// --- backend contract ---------------------------------------------------------------

export type {
  BackendBusinessProfile,
  BackendConnectOptions,
  BackendDeleteMessageRequest,
  BackendEditMessageRequest,
  BackendGroupDescriptionRequest,
  BackendGroupNameRequest,
  BackendGroupParticipantsRequest,
  BackendMediaDownload,
  BackendReactRequest,
  BackendSendMessage,
  BackendSentMessage,
  BackendUserLookup,
  OutboundContent,
  ProfilePictureType,
  WhatsAppBackend,
} from "./backend/Backend.js";
export type {
  BackendConnectionUpdate,
  BackendEventMap,
  BackendEventName,
  BackendEventListener,
  BackendGroupParticipantsEvent,
  BackendGroupUpdateEvent,
  BackendIdPair,
  BackendMessageEvent,
  BackendMessageReference,
  BackendMessageUpdateEvent,
  BackendReactionEvent,
  BackendSelf,
} from "./backend/events.js";
export { createDefaultBackend } from "./backend/createDefaultBackend.js";
export { createBaileysBackend, type BaileysBackendOptions } from "./backend/baileys/index.js";
