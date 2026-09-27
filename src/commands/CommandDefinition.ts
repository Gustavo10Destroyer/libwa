import type { CommandInteraction } from "../interactions/CommandInteraction.js";

/**
 * Definition of a bot command.
 *
 * Commands are plain data + an `execute` function; they are registered on
 * `client.commands` and executed when a message matches the configured
 * prefix. The command system sits entirely on top of the interaction
 * abstraction — nothing here knows about any provider.
 */
export interface CommandDefinition {
  /** Command name without the prefix (e.g. `ping` for `!ping`). */
  readonly name: string;
  /** Short description (useful for help commands). */
  readonly description?: string;
  /** Alternative names that trigger the same command. */
  readonly aliases?: readonly string[];
  /** Grouping label for help listings (e.g. `moderation`). */
  readonly category?: string;
  /** When true, the command only works inside groups. */
  readonly groupOnly?: boolean;
  /** When true, the command only works in direct chats. */
  readonly dmOnly?: boolean;
  /** Runs when the command is invoked. */
  execute(interaction: CommandInteraction): void | Promise<void>;
}
