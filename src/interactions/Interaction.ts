import type { Client } from "../Client.js";
import type { Chat } from "../entities/Chat.js";
import type { Group } from "../entities/Group.js";
import type { Message } from "../entities/Message.js";
import type { User } from "../entities/User.js";
import type { ReplyContent } from "../messaging/types.js";
import type { ButtonInteraction } from "./ButtonInteraction.js";
import type { CommandInteraction } from "./CommandInteraction.js";
import type { GroupParticipantInteraction } from "./GroupParticipantInteraction.js";
import type { GroupUpdateInteraction } from "./GroupUpdateInteraction.js";
import { InteractionType } from "./InteractionType.js";
import type { ListInteraction } from "./ListInteraction.js";
import type { MessageInteraction } from "./MessageInteraction.js";
import type { MessageUpdateInteraction } from "./MessageUpdateInteraction.js";
import type { ReactionInteraction } from "./ReactionInteraction.js";

export interface InteractionInit {
  readonly id: string;
  readonly timestamp: Date;
  readonly chat: Chat;
  readonly author: User | undefined;
  readonly isFromMe: boolean;
  /** Message id to quote when replying, when applicable. */
  readonly replyToMessageId?: string | undefined;
}

/**
 * The central abstraction of the library.
 *
 * An interaction represents something meaningful that happened in WhatsApp —
 * a message, a command, a reaction, a group change — expressed purely in
 * library terms. Concrete subclasses add their own data, while the base class
 * provides identity, chat/author context, replies and type guards.
 *
 * Type guards are backed by the {@link InteractionType} discriminator and by
 * the class hierarchy (`CommandInteraction` is a `MessageInteraction`), so
 * `interaction.isMessage()` and `interaction.isCommand()` behave exactly as
 * TypeScript narrows them.
 */
export abstract class Interaction {
  /** Discriminator of this interaction's kind. */
  abstract readonly type: InteractionType;

  /** Unique identifier of this interaction (message id for messages). */
  readonly id: string;
  /** When the underlying event happened. */
  readonly timestamp: Date;
  /** The client that produced this interaction. */
  readonly client: Client;
  /** The chat this interaction belongs to. */
  readonly chat: Chat;
  /**
   * The group this interaction belongs to, when {@link isFromGroup} is true.
   *
   * For group interactions (participant changes, metadata updates) this is the
   * same instance as {@link chat}, carrying the latest known group data.
   */
  readonly group: Group | undefined;
  /** Who caused this interaction (author, reactor, actor), when known. */
  readonly author: User | undefined;
  /** Whether the logged-in account caused this interaction. */
  readonly isFromMe: boolean;

  readonly #replyToMessageId: string | undefined;

  protected constructor(client: Client, init: InteractionInit) {
    this.id = init.id;
    this.timestamp = init.timestamp;
    this.client = client;
    this.chat = init.chat;
    this.group = init.chat.isGroup() ? init.chat : undefined;
    this.author = init.author;
    this.isFromMe = init.isFromMe;
    this.#replyToMessageId = init.replyToMessageId;
  }

  /** True for message and command interactions. Narrows to `MessageInteraction`. */
  isMessage(): this is MessageInteraction {
    return this.type === InteractionType.Message || this.type === InteractionType.Command;
  }

  /** True when the message matched the configured command prefix. */
  isCommand(): this is CommandInteraction {
    return this.type === InteractionType.Command;
  }

  /** True for reactions. Narrows to `ReactionInteraction`. */
  isReaction(): this is ReactionInteraction {
    return this.type === InteractionType.Reaction;
  }

  /** True for message edits/deletions. Narrows to `MessageUpdateInteraction`. */
  isMessageUpdate(): this is MessageUpdateInteraction {
    return this.type === InteractionType.MessageUpdate;
  }

  /** True for group membership changes. Narrows to `GroupParticipantInteraction`. */
  isGroupParticipantUpdate(): this is GroupParticipantInteraction {
    return this.type === InteractionType.GroupParticipant;
  }

  /** True for group metadata changes. Narrows to `GroupUpdateInteraction`. */
  isGroupUpdate(): this is GroupUpdateInteraction {
    return this.type === InteractionType.GroupUpdate;
  }

  /** True for legacy button taps. Narrows to `ButtonInteraction`. */
  isButton(): this is ButtonInteraction {
    return this.type === InteractionType.Button;
  }

  /** True for legacy list selections. Narrows to `ListInteraction`. */
  isList(): this is ListInteraction {
    return this.type === InteractionType.List;
  }

  /**
   * True when the interaction happened inside a group chat.
   *
   * Narrows `this` so that {@link group} is known to be defined:
   * `if (interaction.isFromGroup()) interaction.group.members` compiles.
   */
  isFromGroup(): this is Interaction & { group: Group } {
    return this.chat.isGroup();
  }

  /** True when the interaction happened in a direct (1:1) chat. */
  isFromDirectChat(): boolean {
    return this.chat.isDirect();
  }

  /**
   * Replies in this interaction's chat, quoting the relevant message when
   * one exists. Accepts a plain string or a structured payload.
   */
  reply(content: ReplyContent): Promise<Message> {
    return this.client.messages.send(
      this.chat,
      content,
      this.#replyToMessageId === undefined
        ? undefined
        : { replyToMessageId: this.#replyToMessageId },
    );
  }
}
