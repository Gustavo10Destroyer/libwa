import type { Client } from "../Client.js";
import type { CommandDefinition } from "../commands/CommandDefinition.js";
import type { TextContent } from "../core/content.js";
import type { Message } from "../entities/Message.js";
import { InteractionType } from "./InteractionType.js";
import { MessageInteraction } from "./MessageInteraction.js";

export interface CommandInit {
  readonly name: string;
  readonly args: readonly string[];
  readonly rawArgs: string;
  /** The registered command that matched, when one exists. */
  readonly command: CommandDefinition | undefined;
}

/**
 * An interaction produced when a text message matches the configured command
 * prefix.
 *
 * Commands are messages: `isMessage()` returns `true` and the interaction
 * carries the original {@link Message}. Narrow with `isCommand()` to work with
 * command-specific data (`name`, `args`, ...).
 */
export class CommandInteraction extends MessageInteraction<TextContent> {
  override readonly type = InteractionType.Command;

  /** Normalized (lowercased) command name without the prefix. */
  readonly name: string;
  /** Whitespace-separated arguments after the command name. */
  readonly args: readonly string[];
  /** Raw argument string after the command name (empty when there are none). */
  readonly rawArgs: string;
  /** The registered command that matched, or `undefined` for unknown commands. */
  readonly command: CommandDefinition | undefined;

  constructor(client: Client, message: Message, init: CommandInit) {
    super(client, message);
    this.name = init.name;
    this.args = init.args;
    this.rawArgs = init.rawArgs;
    this.command = init.command;
  }
}
