import type {
  BackendSendMessage,
  BackendSentMessage,
  OutboundContent,
  WhatsAppBackend,
} from "../backend/Backend.js";
import type { Attachment, MessageContent } from "../core/content.js";
import type { ChatId } from "../core/ids.js";
import { Chat } from "../entities/Chat.js";
import type { EntityFactory } from "../entities/EntityFactory.js";
import { Message } from "../entities/Message.js";
import type { User } from "../entities/User.js";
import {
  UnsupportedOperationError,
  ValidationError,
  rethrowAsBackendError,
} from "../errors/index.js";
import { normalizeReplyContent } from "./payload.js";
import type { ReplyContent, SendOptions } from "./types.js";

/** A send target: an existing chat, a user, or a raw chat id. */
export type SendTarget = Chat | User | ChatId;

/**
 * High-level messaging service.
 *
 * Owns the outgoing path: validates {@link ReplyContent}, resolves the target
 * chat, delegates to the active backend and converts the confirmation back
 * into a domain {@link Message}. This is the only place that knows how to
 * turn user-facing payloads into backend requests.
 */
export class MessageService {
  readonly #backend: WhatsAppBackend;
  readonly #entities: EntityFactory;

  constructor(backend: WhatsAppBackend, entities: EntityFactory) {
    this.#backend = backend;
    this.#entities = entities;
  }

  /** Sends a message and returns the resulting domain message. */
  async send(target: SendTarget, content: ReplyContent, options?: SendOptions): Promise<Message> {
    const normalized = normalizeReplyContent(content, options);
    const { chatId, chat } = this.#resolveTarget(target);
    const quote = options?.quote;
    const request: BackendSendMessage = {
      chatId,
      content: normalized.content,
      replyToMessageId: options?.quote?.id ?? options?.replyToMessageId,
      mentionUserIds: normalized.mentions,
    };

    let sent: BackendSentMessage;
    try {
      sent = await this.#backend.sendMessage(request);
    } catch (error) {
      throw rethrowAsBackendError("Failed to send message", error);
    }

    const resolved =
      sent.chatKind === chat.kind
        ? chat
        : this.#entities.chat({ id: sent.chatId, kind: sent.chatKind });
    const reference =
      quote === undefined
        ? undefined
        : {
            messageId: quote.id,
            chat: quote.chat,
            author: quote.author,
            content: quote.content,
          };
    const messageContent = this.#toMessageContent(normalized.content, sent);
    return this.#entities.sentMessage(
      { ...sent, chatKind: resolved.kind },
      messageContent,
      normalized.mentions,
      reference,
    );
  }

  /** Adds (or removes, with `null`) the bot's reaction on a message. */
  react(message: Message, emoji: string | null): Promise<void> {
    return this.reactTo(message.chat, message.id, emoji);
  }

  /** Adds (or removes, with `null`) the bot's reaction on a message id. */
  async reactTo(chat: Chat | ChatId, messageId: string, emoji: string | null): Promise<void> {
    if (emoji !== null && emoji.length === 0) {
      throw new ValidationError("Reaction emoji cannot be empty.", {
        code: "ERR_EMPTY_REACTION",
      });
    }
    if (!this.#backend.react) {
      throw new UnsupportedOperationError(
        `Backend "${this.#backend.id}" does not support reactions.`,
      );
    }
    try {
      await this.#backend.react({
        chatId: chat instanceof Chat ? chat.id : chat,
        messageId,
        emoji,
      });
    } catch (error) {
      throw rethrowAsBackendError("Failed to react to message", error);
    }
  }

  /** Edits a message previously sent by the bot and returns the updated message. */
  async edit(message: Message, text: string): Promise<Message> {
    if (text.length === 0) {
      throw new ValidationError("Edited text cannot be empty.", {
        code: "ERR_EMPTY_MESSAGE",
      });
    }
    if (!this.#backend.editMessage) {
      throw new UnsupportedOperationError(
        `Backend "${this.#backend.id}" does not support editing messages.`,
      );
    }
    try {
      await this.#backend.editMessage({
        chatId: message.chat.id,
        messageId: message.id,
        text,
      });
    } catch (error) {
      throw rethrowAsBackendError("Failed to edit message", error);
    }
    return new Message({
      id: message.id,
      chat: message.chat,
      author: message.author,
      content: { kind: "text", text },
      timestamp: message.timestamp,
      isFromMe: message.isFromMe,
      isForwarded: message.isForwarded,
      mentions: message.mentions,
      reference: message.reference,
    });
  }

  /** Deletes a message (own message, or any message when the bot is admin). */
  async delete(message: Message): Promise<void> {
    if (!this.#backend.deleteMessage) {
      throw new UnsupportedOperationError(
        `Backend "${this.#backend.id}" does not support deleting messages.`,
      );
    }
    try {
      await this.#backend.deleteMessage({ chatId: message.chat.id, messageId: message.id });
    } catch (error) {
      throw rethrowAsBackendError("Failed to delete message", error);
    }
  }

  #resolveTarget(target: SendTarget): { chatId: ChatId; chat: Chat } {
    if (target instanceof Chat) {
      return { chatId: target.id, chat: target };
    }
    if (typeof target !== "string") {
      // A user target: direct chats use the user id as chat id.
      return { chatId: target.id, chat: this.#entities.chat({ id: target.id, kind: "direct" }) };
    }
    const known = this.#entities.knownChat(target);
    if (known !== undefined) {
      return { chatId: target, chat: known };
    }
    return { chatId: target, chat: this.#entities.chat({ id: target, kind: "unknown" }) };
  }

  /**
   * Converts an outbound payload back into the domain content union so the
   * returned {@link Message} looks like any other message. Media downloads
   * go through the backend using the id the provider assigned on send.
   */
  #toMessageContent(content: OutboundContent, sent: BackendSentMessage): MessageContent {
    switch (content.kind) {
      case "text":
        return { kind: "text", text: content.text };
      case "location":
        return {
          kind: "location",
          latitude: content.latitude,
          longitude: content.longitude,
          address: content.address,
          name: content.name,
        };
      case "image":
        return {
          kind: "image",
          caption: content.caption ?? "",
          attachment: this.#sentAttachment(content, sent),
        };
      case "video":
        return {
          kind: "video",
          caption: content.caption ?? "",
          attachment: this.#sentAttachment(content, sent),
        };
      case "document":
        return {
          kind: "document",
          caption: content.caption ?? "",
          attachment: this.#sentAttachment(content, sent),
        };
      case "audio":
        return { kind: "audio", attachment: this.#sentAttachment(content, sent) };
      case "sticker":
        return { kind: "sticker", attachment: this.#sentAttachment(content, sent) };
    }
  }

  #sentAttachment(
    content: Extract<
      OutboundContent,
      { kind: "image" | "video" | "audio" | "document" | "sticker" }
    >,
    sent: BackendSentMessage,
  ): Attachment {
    return {
      kind: content.kind,
      mimeType: content.mimetype ?? "application/octet-stream",
      size: undefined,
      fileName: content.fileName,
      durationSeconds: content.durationSeconds,
      isVoiceNote: content.voice,
      isAnimated: content.animated,
      download: async () => {
        try {
          return await this.#backend.downloadMedia({
            chatId: sent.chatId,
            messageId: sent.id,
          });
        } catch (error) {
          throw rethrowAsBackendError("Failed to download media", error);
        }
      },
    };
  }
}
