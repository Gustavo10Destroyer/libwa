import { ValidationError } from "../errors/index.js";
import type { CommandDefinition } from "./CommandDefinition.js";

/** Result of parsing a message text as a command. */
export interface ParsedCommand {
  /** The prefix that matched. */
  readonly prefix: string;
  /** Normalized (lowercased) command name. */
  readonly name: string;
  /** Whitespace-separated arguments after the name. */
  readonly args: readonly string[];
  /** Raw argument string after the name (empty when there are none). */
  readonly rawArgs: string;
  /** Registered definition for the name/alias, when one exists. */
  readonly command: CommandDefinition | undefined;
}

const COMMAND_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/**
 * Registry of bot commands.
 *
 * Holds definitions, validates them on registration and parses incoming text
 * against the configured prefixes. Exposed as `client.commands`.
 */
export class CommandRegistry {
  readonly #commands = new Map<string, CommandDefinition>();
  readonly #aliases = new Map<string, string>();

  /** Registers a command. Throws {@link ValidationError} on invalid/duplicate names. */
  register(definition: CommandDefinition): this {
    const name = definition.name.toLowerCase();
    if (!COMMAND_NAME_PATTERN.test(name)) {
      throw new ValidationError(
        `Invalid command name "${definition.name}": use 1-32 chars from [a-z0-9_-], starting with a letter or digit.`,
        { code: "ERR_INVALID_COMMAND_NAME" },
      );
    }
    if (this.#commands.has(name)) {
      throw new ValidationError(`Command "${name}" is already registered.`, {
        code: "ERR_DUPLICATE_COMMAND",
      });
    }
    this.#commands.set(name, definition);
    for (const alias of definition.aliases ?? []) {
      const key = alias.toLowerCase();
      if (!COMMAND_NAME_PATTERN.test(key)) {
        throw new ValidationError(`Invalid alias "${alias}" for command "${name}".`, {
          code: "ERR_INVALID_COMMAND_NAME",
        });
      }
      if (this.#commands.has(key) || this.#aliases.has(key)) {
        throw new ValidationError(`Alias "${alias}" conflicts with an existing command.`, {
          code: "ERR_DUPLICATE_COMMAND",
        });
      }
      this.#aliases.set(key, name);
    }
    return this;
  }

  /** Registers several commands at once. */
  registerAll(definitions: Iterable<CommandDefinition>): this {
    for (const definition of definitions) {
      this.register(definition);
    }
    return this;
  }

  /** Removes a command (by name or alias). Returns whether one was removed. */
  unregister(name: string): boolean {
    const key = name.toLowerCase();
    const canonical = this.#aliases.get(key) ?? key;
    const removed = this.#commands.delete(canonical);
    for (const [alias, target] of this.#aliases) {
      if (target === canonical) {
        this.#aliases.delete(alias);
      }
    }
    return removed;
  }

  /** Looks up a command by its canonical name. */
  get(name: string): CommandDefinition | undefined {
    return this.#commands.get(name.toLowerCase());
  }

  /** Resolves a name or alias to its command definition. */
  resolve(name: string): CommandDefinition | undefined {
    const key = name.toLowerCase();
    const canonical = this.#aliases.get(key) ?? key;
    return this.#commands.get(canonical);
  }

  /** Whether a command (or alias) with this name exists. */
  has(name: string): boolean {
    return this.resolve(name) !== undefined;
  }

  /** All registered commands in registration order. */
  list(): readonly CommandDefinition[] {
    return [...this.#commands.values()];
  }

  /** Number of registered commands. */
  get size(): number {
    return this.#commands.size;
  }

  /** Removes every command. */
  clear(): void {
    this.#commands.clear();
    this.#aliases.clear();
  }

  /**
   * Parses message text against the given prefixes.
   *
   * Returns `null` when the text is not a command; otherwise returns the
   * parsed name/args and the registered definition (when there is one).
   * Matching is always case-insensitive for command names.
   */
  parse(text: string, prefixes: readonly string[]): ParsedCommand | null {
    const prefix = prefixes.find((candidate) => text.startsWith(candidate));
    if (prefix === undefined) {
      return null;
    }
    const body = text.slice(prefix.length).trim();
    if (body.length === 0) {
      return null;
    }
    const separator = body.search(/\s/);
    const rawName = separator === -1 ? body : body.slice(0, separator);
    const name = rawName.toLowerCase();
    if (!COMMAND_NAME_PATTERN.test(name)) {
      return null;
    }
    const rawArgs = separator === -1 ? "" : body.slice(separator).trim();
    const args = rawArgs.length === 0 ? [] : rawArgs.split(/\s+/);
    return {
      prefix,
      name,
      args,
      rawArgs,
      command: this.resolve(name),
    };
  }
}
