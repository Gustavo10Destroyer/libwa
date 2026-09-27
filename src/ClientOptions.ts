import type { SessionStore } from "./auth/SessionStore.js";
import type { WhatsAppBackend } from "./backend/Backend.js";
import { ValidationError } from "./errors/index.js";
import type { CommandParsingOptions } from "./interactions/InteractionFactory.js";
import { nullLogger } from "./logging/Logger.js";
import type { Logger } from "./logging/Logger.js";

/**
 * Options for the command system.
 *
 * Omit `commands` to use defaults (`!` prefix), or pass `false` to disable
 * command parsing entirely (every message stays a plain `MessageInteraction`).
 */
export interface CommandOptions {
  /** One or more command prefixes. Defaults to `"!"`. */
  prefix?: string | readonly string[];
  /** Ignore commands sent by the logged-in account itself. Defaults to `false`. */
  ignoreSelf?: boolean;
}

/** Automatic reconnection policy for recoverable disconnects. */
export interface ReconnectOptions {
  /** Maximum reconnection attempts before giving up. Defaults to `5`. */
  attempts?: number;
  /** Delay before the first retry, in milliseconds. Defaults to `1000`. */
  initialDelayMs?: number;
  /** Upper bound for the backoff delay, in milliseconds. Defaults to `30000`. */
  maxDelayMs?: number;
  /** Exponential backoff factor. Defaults to `2`. */
  factor?: number;
}

/** Options accepted by the client constructor. */
export interface ClientOptions {
  /**
   * Backend to use. Defaults to the bundled Baileys backend. Pass an
   * instance (or a factory) to use/test another provider.
   */
  backend?: WhatsAppBackend | (() => WhatsAppBackend);
  /** Session persistence. Defaults to a filesystem store in `.libwa/`. */
  sessionStore?: SessionStore;
  /** Session slot id when multiple accounts share one store. Defaults to `"default"`. */
  sessionId?: string;
  /** Logger for internal diagnostics. Defaults to a silent logger. */
  logger?: Logger;
  /** Command parsing configuration, or `false` to disable it. */
  commands?: CommandOptions | false;
  /** Reconnection policy, or `false` to disable automatic reconnection. */
  reconnect?: ReconnectOptions | false;
  /** Phone number (international, digits only) for pairing-code login. */
  auth?: {
    pairingPhoneNumber?: string;
  };
}

/** Fully resolved options with all defaults applied. */
export interface ResolvedClientOptions {
  readonly backend: WhatsAppBackend | (() => WhatsAppBackend) | undefined;
  readonly sessionStore: SessionStore | undefined;
  readonly sessionId: string;
  readonly logger: Logger;
  readonly commandOptions: CommandParsingOptions | null;
  readonly reconnect:
    | {
        readonly attempts: number;
        readonly initialDelayMs: number;
        readonly maxDelayMs: number;
        readonly factor: number;
      }
    | false;
  readonly pairingPhoneNumber: string | undefined;
}

const DEFAULT_RECONNECT: Required<ReconnectOptions> = {
  attempts: 5,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  factor: 2,
};

/** Applies defaults to raw {@link ClientOptions} (internal). */
export function resolveClientOptions(options: ClientOptions): ResolvedClientOptions {
  const commandOptions =
    options.commands === false
      ? null
      : {
          prefixes: normalizePrefixes(options.commands?.prefix ?? "!"),
          ignoreSelf: options.commands?.ignoreSelf ?? false,
        };

  const reconnect =
    options.reconnect === false
      ? false
      : {
          attempts: options.reconnect?.attempts ?? DEFAULT_RECONNECT.attempts,
          initialDelayMs: options.reconnect?.initialDelayMs ?? DEFAULT_RECONNECT.initialDelayMs,
          maxDelayMs: options.reconnect?.maxDelayMs ?? DEFAULT_RECONNECT.maxDelayMs,
          factor: options.reconnect?.factor ?? DEFAULT_RECONNECT.factor,
        };

  return {
    backend: options.backend,
    sessionStore: options.sessionStore,
    sessionId: options.sessionId ?? "default",
    logger: options.logger ?? nullLogger,
    commandOptions,
    reconnect,
    pairingPhoneNumber: options.auth?.pairingPhoneNumber,
  };
}

function normalizePrefixes(prefix: string | readonly string[]): readonly string[] {
  const list = typeof prefix === "string" ? [prefix] : [...prefix];
  if (list.length === 0 || list.some((value) => value.length === 0)) {
    throw new ValidationError("Command prefix must be a non-empty string or a non-empty list.", {
      code: "ERR_INVALID_PREFIX",
    });
  }
  return list;
}
