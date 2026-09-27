import { DisconnectReason as BaileysDisconnectReason } from "@whiskeysockets/baileys";
import { DisconnectReason } from "../../core/DisconnectReason.js";

/**
 * Provider disconnect translation.
 *
 * Baileys surfaces disconnects as Boom-style errors whose status code carries
 * a provider disconnect reason; this module maps those codes onto the
 * library's {@link DisconnectReason} enum so applications never branch on
 * provider numbers.
 */

export interface MappedDisconnect {
  readonly reason: DisconnectReason;
  readonly detail: string | undefined;
}

/** 408 is shared by Baileys' connectionLost/timedOut; both are mapped to lost. */
const BY_REASON_CODE: ReadonlyMap<number, DisconnectReason> = new Map<number, DisconnectReason>([
  [BaileysDisconnectReason.connectionClosed, DisconnectReason.ConnectionClosed],
  [BaileysDisconnectReason.connectionLost, DisconnectReason.ConnectionLost],
  [BaileysDisconnectReason.connectionReplaced, DisconnectReason.ConnectionReplaced],
  [BaileysDisconnectReason.loggedOut, DisconnectReason.LoggedOut],
  [BaileysDisconnectReason.badSession, DisconnectReason.BadSession],
  [BaileysDisconnectReason.restartRequired, DisconnectReason.RestartRequired],
  [BaileysDisconnectReason.multideviceMismatch, DisconnectReason.BadSession],
  [BaileysDisconnectReason.forbidden, DisconnectReason.Forbidden],
  [BaileysDisconnectReason.unavailableService, DisconnectReason.ServiceUnavailable],
  [429, DisconnectReason.RateLimited],
]);

const NETWORK_ERRNO_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
]);

/** Translates a provider disconnect error into a library disconnect reason. */
export function mapDisconnectError(error: unknown): MappedDisconnect {
  const detail = describe(error);

  const code = extractStatusCode(error);
  if (code !== undefined) {
    const mapped = BY_REASON_CODE.get(code);
    if (mapped !== undefined) {
      return { reason: mapped, detail };
    }
  }

  const errno = extractErrno(error);
  if (errno !== undefined && NETWORK_ERRNO_CODES.has(errno)) {
    return { reason: DisconnectReason.NetworkError, detail };
  }

  return { reason: DisconnectReason.Unknown, detail };
}

/** Extracts a Boom-style status code from a provider error, when present. */
export function providerStatusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const output = (error as { output?: unknown }).output;
  if (typeof output === "object" && output !== null) {
    const fromOutput = (output as { statusCode?: unknown }).statusCode;
    if (typeof fromOutput === "number") {
      return fromOutput;
    }
  }
  const direct = (error as { statusCode?: unknown }).statusCode;
  return typeof direct === "number" ? direct : undefined;
}

function extractStatusCode(error: unknown): number | undefined {
  return providerStatusCode(error);
}

function extractErrno(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function describe(error: unknown): string | undefined {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return undefined;
}
