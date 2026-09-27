import { contentAttachments, contentText } from "../core/content.js";
import type { Attachment, MessageContent } from "../core/content.js";
import type { ReplyContent } from "../messaging/types.js";
import type { Chat } from "./Chat.js";
import type { User } from "./User.js";

/** A quoted (replied-to) message as known when the referencing message arrived. */
export interface MessageReference {
  readonly messageId: string;
  readonly chat: Chat;
  readonly author: User | undefined;
  /** Content of the quoted message when the provider delivered it inline. */
  readonly content: MessageContent | undefined;
}

export interface MessageInit {
  readonly id: string;
  readonly chat: Chat;
  readonly author: User;
  readonly content: MessageContent;
  readonly timestamp: Date;
  readonly isFromMe: boolean;
  readonly isForwarded?: boolean;
  readonly mentions?: readonly User[];
  readonly reference?: MessageReference | undefined;
}

/**
 * A WhatsApp message — sent or received.
 *
 * Messages are immutable value objects: all content access goes through the
 * normalized {@link MessageContent} union, while actions (`reply`, `react`,
 * `delete`) delegate to the client's services so that no provider knowledge
 * is ever required.
 */
export class Message {
  readonly id: string;
  readonly chat: Chat;
  readonly author: User;
  readonly content: MessageContent;
  readonly timestamp: Date;
  readonly isFromMe: boolean;
  readonly isForwarded: boolean;
  readonly mentions: readonly User[];
  readonly reference: MessageReference | undefined;

  constructor(init: MessageInit) {
    this.id = init.id;
    this.chat = init.chat;
    this.author = init.author;
    this.content = init.content;
    this.timestamp = init.timestamp;
    this.isFromMe = init.isFromMe;
    this.isForwarded = init.isForwarded ?? false;
    this.mentions = init.mentions ?? [];
    this.reference = init.reference;
  }

  /** Plain text of this message (`text` or caption, `""` when there is none). */
  get text(): string {
    return contentText(this.content);
  }

  /** Media attachments of this message (0 or 1 items). */
  get attachments(): readonly Attachment[] {
    return contentAttachments(this.content);
  }

  /** True when this message quotes another message. */
  get isReply(): boolean {
    return this.reference !== undefined;
  }

  /** Replies to this message in the same chat. */
  reply(content: ReplyContent): Promise<Message> {
    return this.chat.client.messages.send(this.chat, content, { quote: this });
  }

  /** Adds (or removes, with `null`) the bot's reaction on this message. */
  react(emoji: string | null): Promise<void> {
    return this.chat.client.messages.react(this, emoji);
  }

  /** Deletes this message (own message, or any message when the bot is a group admin). */
  delete(): Promise<void> {
    return this.chat.client.messages.delete(this);
  }

  toString(): string {
    return `Message(${this.id} @ ${this.chat.displayName})`;
  }
}
