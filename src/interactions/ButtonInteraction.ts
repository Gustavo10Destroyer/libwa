import type { Client } from "../Client.js";
import type { Chat } from "../entities/Chat.js";
import type { MessageReference } from "../entities/Message.js";
import type { User } from "../entities/User.js";
import { Interaction } from "./Interaction.js";
import { InteractionType } from "./InteractionType.js";

export interface ButtonInit {
  readonly id: string;
  readonly chat: Chat;
  readonly author: User;
  readonly timestamp: Date;
  /** Id of the response message. */
  readonly messageId: string;
  /** Provider-defined id of the selected button. */
  readonly buttonId: string;
  /** Title of the prompt/button list. */
  readonly title: string;
  /** Text displayed on the selected button. */
  readonly displayText: string;
  /** Whether the prompt was a template or a plain button message. */
  readonly variant: "template" | "plain";
  /** The button prompt message, when quoted by the provider. */
  readonly reference: MessageReference | undefined;
  readonly isFromMe: boolean;
}

/**
 * An interaction produced when a user taps a legacy interactive button.
 *
 * Replies quote the original button prompt when the provider reported it.
 */
export class ButtonInteraction extends Interaction {
  override readonly type = InteractionType.Button;

  /** Id of the response message. */
  readonly messageId: string;
  /** Provider-defined id of the selected button. */
  readonly buttonId: string;
  /** Title of the prompt/button list. */
  readonly title: string;
  /** Text displayed on the selected button. */
  readonly displayText: string;
  /** Whether the prompt was a template or a plain button message. */
  readonly variant: "template" | "plain";
  /** The button prompt message, when quoted by the provider. */
  readonly reference: MessageReference | undefined;

  constructor(client: Client, init: ButtonInit) {
    super(client, {
      id: init.id,
      timestamp: init.timestamp,
      chat: init.chat,
      author: init.author,
      isFromMe: init.isFromMe,
      replyToMessageId: init.reference?.messageId ?? init.messageId,
    });
    this.messageId = init.messageId;
    this.buttonId = init.buttonId;
    this.title = init.title;
    this.displayText = init.displayText;
    this.variant = init.variant;
    this.reference = init.reference;
  }
}
