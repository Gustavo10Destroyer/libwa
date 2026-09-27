import { describe, expect, it, vi } from "vitest";
import type { CommandDefinition } from "../src/commands/CommandDefinition.js";
import { CommandRegistry } from "../src/commands/CommandRegistry.js";
import { ValidationError } from "../src/errors/index.js";

function definition(overrides: Partial<CommandDefinition> = {}): CommandDefinition {
  return {
    name: "ping",
    execute: () => undefined,
    ...overrides,
  };
}

describe("CommandRegistry registration", () => {
  it("registers and resolves commands case-insensitively", () => {
    const registry = new CommandRegistry();
    const command = definition({ name: "Ping" });
    registry.register(command);
    expect(registry.get("ping")).toBe(command);
    expect(registry.get("PING")).toBe(command);
    expect(registry.resolve("ping")).toBe(command);
    expect(registry.has("ping")).toBe(true);
    expect(registry.size).toBe(1);
    expect(registry.list()).toEqual([command]);
  });

  it("resolves aliases to their canonical command", () => {
    const registry = new CommandRegistry();
    const command = definition({ name: "ping", aliases: ["pong"] });
    registry.register(command);
    expect(registry.resolve("pong")).toBe(command);
    expect(registry.resolve("PONG")).toBe(command);
    expect(registry.get("pong")).toBeUndefined();
  });

  it("registers batches with registerAll", () => {
    const registry = new CommandRegistry();
    registry.registerAll([definition({ name: "a" }), definition({ name: "b" })]);
    expect(registry.size).toBe(2);
  });

  it("rejects invalid names", () => {
    const registry = new CommandRegistry();
    expect(() => registry.register(definition({ name: "has space" }))).toThrow(ValidationError);
    expect(() => registry.register(definition({ name: "-leading" }))).toThrow(
      /Invalid command name/,
    );
    expect(() => registry.register(definition({ name: "x".repeat(33) }))).toThrow(ValidationError);
  });

  it("rejects duplicate names and conflicting aliases", () => {
    const registry = new CommandRegistry();
    registry.register(definition({ name: "ping" }));
    expect(() => registry.register(definition({ name: "ping" }))).toThrow(/already registered/);
    expect(() => registry.register(definition({ name: "other", aliases: ["ping"] }))).toThrow(
      /conflicts/,
    );
    registry.register(definition({ name: "second", aliases: ["alias"] }));
    expect(() => registry.register(definition({ name: "third", aliases: ["ALIAS"] }))).toThrow(
      /conflicts/,
    );
  });

  it("unregisters commands and their aliases", () => {
    const registry = new CommandRegistry();
    registry.register(definition({ name: "ping", aliases: ["pong"] }));
    expect(registry.unregister("pong")).toBe(true);
    expect(registry.has("ping")).toBe(false);
    expect(registry.unregister("ping")).toBe(false);
    expect(registry.size).toBe(0);
  });

  it("clears everything", () => {
    const registry = new CommandRegistry();
    registry.registerAll([definition({ name: "a" }), definition({ name: "b" })]);
    registry.clear();
    expect(registry.size).toBe(0);
    expect(registry.list()).toEqual([]);
  });
});

describe("CommandRegistry.parse", () => {
  const prefixes = ["!", "/"];

  it("returns null for non-commands", () => {
    const registry = new CommandRegistry();
    expect(registry.parse("hello", prefixes)).toBeNull();
    expect(registry.parse("!", prefixes)).toBeNull();
    expect(registry.parse("   ", prefixes)).toBeNull();
  });

  it("parses name, args and rawArgs", () => {
    const registry = new CommandRegistry();
    const parsed = registry.parse("!Ping one  two", prefixes);
    expect(parsed).not.toBeNull();
    expect(parsed?.prefix).toBe("!");
    expect(parsed?.name).toBe("ping");
    expect(parsed?.args).toEqual(["one", "two"]);
    expect(parsed?.rawArgs).toBe("one  two");
    expect(parsed?.command).toBeUndefined();
  });

  it("attaches the registered definition", () => {
    const registry = new CommandRegistry();
    const command = definition({ name: "echo" });
    registry.register(command);
    const parsed = registry.parse("!echo hi", prefixes);
    expect(parsed?.command).toBe(command);
  });

  it("supports alternative prefixes", () => {
    const registry = new CommandRegistry();
    const parsed = registry.parse("/start now", prefixes);
    expect(parsed?.prefix).toBe("/");
    expect(parsed?.name).toBe("start");
    expect(parsed?.args).toEqual(["now"]);
    expect(parsed?.rawArgs).toBe("now");
  });

  it("rejects invalid command-looking tokens", () => {
    const registry = new CommandRegistry();
    expect(registry.parse("!-bad", prefixes)).toBeNull();
    expect(registry.parse("!!", prefixes)).toBeNull();
  });
});

describe("CommandRegistry execute wiring", () => {
  it("keeps definition functions untouched", () => {
    const execute = vi.fn();
    const registry = new CommandRegistry();
    const command = definition({ name: "run", execute });
    registry.register(command);
    registry.resolve("run")?.execute({} as unknown as never);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
