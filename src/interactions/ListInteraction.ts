import type { Client } from "../Client.js";
import type { Chat } from "../entities/Chat.js";
import type { MessageReference } from "../entities/Message.js";
import type { User } from "../entities/User.js";
import { Interaction } from "./Interaction.js";
import { InteractionType } from "./InteractionType.js";

export interface ListInit {
  readonly id: string;
  readonly chat: Chat;
  readonly author: User;
  readonly timestamp: Date;
  /** Id of the response message. */
  readonly messageId: string;
  /** Provider-defined id of the selected row. */
  readonly rowId: string;
  /** Title of the selected row. */
  readonly title: string;
  /** Description of the selected row when provided. */
  readonly description: string | undefined;
  /** The list prompt message, when quoted by the provider. */
  readonly reference: MessageReference | undefined;
  readonly isFromMe: boolean;
}

/**
 * An interaction produced when a user selects a row from a legacy
 * interactive list.
 */
export class ListInteraction extends Interaction {
  override readonly type = InteractionType.List;

  /** Id of the response message. */
  readonly messageId: string;
  /** Provider-defined id of the selected row. */
  readonly rowId: string;
  /** Title of the selected row. */
  readonly title: string;
  /** Description of the selected row when provided. */
  readonly description: string | undefined;
  /** The list prompt message, when quoted by the provider. */
  readonly reference: MessageReference | undefined;

  constructor(client: Client, init: ListInit) {
    super(client, {
      id: init.id,
      timestamp: init.timestamp,
      chat: init.chat,
      author: init.author,
      isFromMe: init.isFromMe,
      replyToMessageId: init.reference?.messageId ?? init.messageId,
    });
    this.messageId = init.messageId;
    this.rowId = init.rowId;
    this.title = init.title;
    this.description = init.description;
    this.reference = init.reference;
  }
}
