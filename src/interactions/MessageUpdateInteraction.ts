import type { Client } from "../Client.js";
import type { MessageContent } from "../core/content.js";
import type { Chat } from "../entities/Chat.js";
import type { User } from "../entities/User.js";
import { Interaction } from "./Interaction.js";
import { InteractionType } from "./InteractionType.js";

export interface MessageUpdateInit {
  readonly id: string;
  readonly chat: Chat;
  readonly author: User | undefined;
  readonly timestamp: Date;
  readonly messageId: string;
  readonly action: "edit" | "delete";
  /** New content for edits; `undefined` for deletions. */
  readonly content: MessageContent | undefined;
}

/**
 * An interaction produced when a message is edited or deleted.
 *
 * Useful for moderation/logging handlers: `action` tells you what happened,
 * `content` carries the new text for edits.
 */
export class MessageUpdateInteraction extends Interaction {
  override readonly type = InteractionType.MessageUpdate;

  /** Id of the message that was edited/deleted. */
  readonly messageId: string;
  /** What happened to the message. */
  readonly action: "edit" | "delete";
  /** New content for edits; `undefined` for deletions. */
  readonly content: MessageContent | undefined;

  constructor(client: Client, init: MessageUpdateInit) {
    super(client, {
      id: init.id,
      timestamp: init.timestamp,
      chat: init.chat,
      author: init.author,
      isFromMe: init.author?.isMe ?? false,
      replyToMessageId: init.action === "edit" ? init.messageId : undefined,
    });
    this.messageId = init.messageId;
    this.action = init.action;
    this.content = init.content;
  }

  /** True when a message was edited. */
  get isEdit(): boolean {
    return this.action === "edit";
  }

  /** True when a message was deleted. */
  get isDelete(): boolean {
    return this.action === "delete";
  }
}
