import type { Client } from "../Client.js";
import type { Chat } from "../entities/Chat.js";
import type { User } from "../entities/User.js";
import { Interaction } from "./Interaction.js";
import { InteractionType } from "./InteractionType.js";

export interface ReactionInit {
  readonly id: string;
  readonly chat: Chat;
  readonly author: User;
  readonly timestamp: Date;
  /** Id of the message that was reacted to. */
  readonly messageId: string;
  /** Emoji that was added, or `null` when the reaction was removed. */
  readonly emoji: string | null;
  readonly isFromMe: boolean;
}

/**
 * An interaction produced when someone reacts to (or removes a reaction from)
 * a message.
 */
export class ReactionInteraction extends Interaction {
  override readonly type = InteractionType.Reaction;

  /** Id of the message that was reacted to. */
  readonly messageId: string;
  /** Emoji that was added, or `null` when the reaction was removed. */
  readonly emoji: string | null;

  constructor(client: Client, init: ReactionInit) {
    super(client, {
      id: init.id,
      timestamp: init.timestamp,
      chat: init.chat,
      author: init.author,
      isFromMe: init.isFromMe,
      replyToMessageId: init.messageId,
    });
    this.messageId = init.messageId;
    this.emoji = init.emoji;
  }

  /** True when the reaction was removed rather than added. */
  get isRemoved(): boolean {
    return this.emoji === null;
  }

  /** Reacts to the same message with `emoji` (or removes the reaction with `null`). */
  react(emoji: string | null): Promise<void> {
    return this.client.messages.reactTo(this.chat, this.messageId, emoji);
  }
}
