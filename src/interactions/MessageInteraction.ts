import type { Client } from "../Client.js";
import type {
  Attachment,
  AudioContent,
  ContactContent,
  DocumentContent,
  ImageContent,
  LocationContent,
  MediaMessageContent,
  MessageContent,
  PollContent,
  StickerContent,
  TextContent,
  VideoContent,
} from "../core/content.js";
import { contentAttachments, contentText } from "../core/content.js";
import type { Message, MessageReference } from "../entities/Message.js";
import type { User } from "../entities/User.js";
import { Interaction } from "./Interaction.js";
import { InteractionType } from "./InteractionType.js";

/**
 * An interaction caused by an incoming message.
 *
 * Carries the full normalized {@link Message} plus convenience accessors
 * (`content`, `text`, `attachments`) so handlers never touch provider
 * structures. Generic over the content type: guards like {@link isText}
 * narrow both `this` and `this.content` at compile time.
 */
export class MessageInteraction<C extends MessageContent = MessageContent> extends Interaction {
  override readonly type: InteractionType = InteractionType.Message;

  /** The underlying domain message. */
  readonly message: Message;

  /** Message author (always known for messages). */
  override readonly author: User;

  constructor(client: Client, message: Message) {
    super(client, {
      id: message.id,
      timestamp: message.timestamp,
      chat: message.chat,
      author: message.author,
      isFromMe: message.isFromMe,
      replyToMessageId: message.id,
    });
    this.message = message;
    this.author = message.author;
  }

  /** Normalized content of the message. */
  get content(): C {
    return this.message.content as C;
  }

  /** Plain text (`text`, caption or `""`) — the most common field handlers read. */
  get text(): string {
    return contentText(this.message.content);
  }

  /** Media attachments of this message (0 or 1 items). */
  get attachments(): readonly Attachment[] {
    return contentAttachments(this.message.content);
  }

  /** Quoted message, when this message replies to another one. */
  get reference(): MessageReference | undefined {
    return this.message.reference;
  }

  /** Whether the message was forwarded. */
  get isForwarded(): boolean {
    return this.message.isForwarded;
  }

  /** Users mentioned in this message. */
  get mentions(): readonly User[] {
    return this.message.mentions;
  }

  /** True when this message quotes another message. */
  get isReply(): boolean {
    return this.message.isReply;
  }

  /** Adds (or removes, with `null`) the bot's reaction on this message. */
  react(emoji: string | null): Promise<void> {
    return this.client.messages.react(this.message, emoji);
  }

  /** Deletes this message (own message, or any when the bot is admin). */
  delete(): Promise<void> {
    return this.client.messages.delete(this.message);
  }

  /** Edits this message when it was sent by the bot. */
  edit(text: string): Promise<Message> {
    return this.client.messages.edit(this.message, text);
  }

  /** True when the message body is plain text. Narrows `content` to `TextContent`. */
  isText(): this is MessageInteraction<TextContent> {
    return this.content.kind === "text";
  }

  /** True for images. Narrows `content` to `ImageContent`. */
  isImage(): this is MessageInteraction<ImageContent> {
    return this.content.kind === "image";
  }

  /** True for videos. Narrows `content` to `VideoContent`. */
  isVideo(): this is MessageInteraction<VideoContent> {
    return this.content.kind === "video";
  }

  /** True for audio/voice notes. Narrows `content` to `AudioContent`. */
  isAudio(): this is MessageInteraction<AudioContent> {
    return this.content.kind === "audio";
  }

  /** True for documents. Narrows `content` to `DocumentContent`. */
  isDocument(): this is MessageInteraction<DocumentContent> {
    return this.content.kind === "document";
  }

  /** True for stickers. Narrows `content` to `StickerContent`. */
  isSticker(): this is MessageInteraction<StickerContent> {
    return this.content.kind === "sticker";
  }

  /** True for locations. Narrows `content` to `LocationContent`. */
  isLocation(): this is MessageInteraction<LocationContent> {
    return this.content.kind === "location";
  }

  /** True for contact cards. Narrows `content` to `ContactContent`. */
  isContact(): this is MessageInteraction<ContactContent> {
    return this.content.kind === "contact";
  }

  /** True for polls. Narrows `content` to `PollContent`. */
  isPoll(): this is MessageInteraction<PollContent> {
    return this.content.kind === "poll";
  }

  /** True for any media message (image, video, audio, document, sticker). */
  isMedia(): this is MessageInteraction<MediaMessageContent> {
    return "attachment" in this.content;
  }
}
