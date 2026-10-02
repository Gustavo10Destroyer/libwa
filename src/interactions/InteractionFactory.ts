import type { Client } from "../Client.js";
import type {
  BackendGroupParticipantsEvent,
  BackendGroupUpdateEvent,
  BackendMessageEvent,
  BackendMessageUpdateEvent,
  BackendReactionEvent,
} from "../backend/events.js";
import type { CommandRegistry } from "../commands/CommandRegistry.js";
import type { EntityFactory } from "../entities/EntityFactory.js";
import { ButtonInteraction } from "./ButtonInteraction.js";
import { CommandInteraction } from "./CommandInteraction.js";
import { GroupParticipantInteraction } from "./GroupParticipantInteraction.js";
import { GroupUpdateInteraction } from "./GroupUpdateInteraction.js";
import type { Interaction } from "./Interaction.js";
import { ListInteraction } from "./ListInteraction.js";
import { MessageInteraction } from "./MessageInteraction.js";
import { MessageUpdateInteraction } from "./MessageUpdateInteraction.js";
import { ReactionInteraction } from "./ReactionInteraction.js";

/** Resolved command-parsing configuration (`null` disables parsing). */
export interface CommandParsingOptions {
  readonly prefixes: readonly string[];
  readonly ignoreSelf: boolean;
}

/**
 * Turns normalized backend events into public interactions.
 *
 * This is the single place where backend payloads become user-facing objects:
 * known LID ↔ phone-number id pairs are recorded first, message content is
 * inspected, command prefixes are parsed, and the right concrete interaction
 * class is instantiated. The client only ever dispatches the returned
 * {@link Interaction}.
 */
export class InteractionFactory {
  readonly #client: Client;
  readonly #entities: EntityFactory;
  readonly #commands: CommandRegistry;
  readonly #commandOptions: CommandParsingOptions | null;

  constructor(
    client: Client,
    entities: EntityFactory,
    commands: CommandRegistry,
    commandOptions: CommandParsingOptions | null,
  ) {
    this.#client = client;
    this.#entities = entities;
    this.#commands = commands;
    this.#commandOptions = commandOptions;
  }

  /** Creates a message/command/button/list interaction from a message event. */
  fromMessage(event: BackendMessageEvent): Interaction {
    this.#entities.recordIdPairs(event.idPairs);
    const message = this.#entities.message(event);
    const content = message.content;

    if (content.kind === "buttonReply") {
      return new ButtonInteraction(this.#client, {
        id: event.id,
        chat: message.chat,
        author: message.author,
        timestamp: event.timestamp,
        messageId: event.id,
        buttonId: content.buttonId,
        title: content.title,
        displayText: content.displayText,
        variant: content.variant,
        reference: message.reference,
        isFromMe: event.isFromMe,
      });
    }
    if (content.kind === "listReply") {
      return new ListInteraction(this.#client, {
        id: event.id,
        chat: message.chat,
        author: message.author,
        timestamp: event.timestamp,
        messageId: event.id,
        rowId: content.rowId,
        title: content.title,
        description: content.description,
        reference: message.reference,
        isFromMe: event.isFromMe,
      });
    }

    if (
      this.#commandOptions !== null &&
      content.kind === "text" &&
      !(this.#commandOptions.ignoreSelf && event.isFromMe)
    ) {
      const parsed = this.#commands.parse(content.text, this.#commandOptions.prefixes);
      if (parsed !== null) {
        return new CommandInteraction(this.#client, message, {
          name: parsed.name,
          args: parsed.args,
          rawArgs: parsed.rawArgs,
          command: parsed.command,
        });
      }
    }

    return new MessageInteraction(this.#client, message);
  }

  /** Creates a reaction interaction. */
  fromReaction(event: BackendReactionEvent): ReactionInteraction {
    this.#entities.recordIdPairs(event.idPairs);
    const author = this.#entities.user(event.reactorId);
    return new ReactionInteraction(this.#client, {
      id: event.id,
      chat: this.#entities.chat({ id: event.chatId, kind: event.chatKind }),
      author,
      timestamp: event.timestamp,
      messageId: event.messageId,
      emoji: event.emoji,
      isFromMe: author.isMe,
    });
  }

  /** Creates a message edit/delete interaction. */
  fromMessageUpdate(event: BackendMessageUpdateEvent): MessageUpdateInteraction {
    this.#entities.recordIdPairs(event.idPairs);
    const chat = this.#entities.chat({ id: event.chatId, kind: event.chatKind });
    const author = event.authorId === undefined ? undefined : this.#entities.user(event.authorId);
    return new MessageUpdateInteraction(this.#client, {
      id: `${event.chatId}:${event.messageId}:${event.action}:${event.timestamp.getTime()}`,
      chat,
      author,
      timestamp: event.timestamp,
      messageId: event.messageId,
      action: event.action,
      content: event.content,
    });
  }

  /** Creates a group participant change interaction, applying it to cached metadata. */
  fromGroupParticipants(event: BackendGroupParticipantsEvent): GroupParticipantInteraction {
    this.#entities.recordIdPairs(event.idPairs);
    const actor = event.actorId === undefined ? undefined : this.#entities.user(event.actorId);
    return new GroupParticipantInteraction(this.#client, {
      id: event.id,
      group: this.#entities.applyGroupParticipants(
        event.groupId,
        event.action,
        event.participantIds,
      ),
      action: event.action,
      users: event.participantIds.map((id) => this.#entities.user(id)),
      actor,
      timestamp: event.timestamp,
      isFromMe: actor?.isMe ?? false,
    });
  }

  /** Creates a group metadata change interaction. */
  fromGroupUpdate(event: BackendGroupUpdateEvent): GroupUpdateInteraction {
    return new GroupUpdateInteraction(this.#client, {
      id: event.id,
      group: this.#entities.applyGroupChanges(event.groupId, event.changes),
      changes: event.changes,
      timestamp: event.timestamp,
    });
  }
}
