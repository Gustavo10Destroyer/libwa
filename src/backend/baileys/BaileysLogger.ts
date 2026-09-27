import type { Logger } from "../../logging/Logger.js";

/**
 * Structural mirror of Baileys' `ILogger`.
 *
 * Baileys does not export its logger type from the package root, so the
 * adapter is typed against this local interface. It is structurally
 * compatible with the provider's logger, which is all the provider needs.
 */
export interface ProviderLogger {
  readonly level: string;
  child(bindings: Record<string, unknown>): ProviderLogger;
  trace(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

type ForwardLevel = "debug" | "info" | "warn" | "error";

/**
 * Adapts a library {@link Logger} to the provider logger shape, preserving
 * bindings accumulated through `child()` calls so provider logs stay
 * attributable.
 */
export function createProviderLogger(
  logger: Logger,
  bindings: Record<string, unknown> = {},
): ProviderLogger {
  const forward = (level: ForwardLevel, obj: unknown, msg: string | undefined): void => {
    const payload = merge(bindings, obj);
    if (msg !== undefined) {
      logger[level](msg, payload);
      return;
    }
    logger[level](payload);
  };
  return {
    level: "info",
    child: (extra) => createProviderLogger(logger, { ...bindings, ...extra }),
    trace: (obj, msg) => forward("debug", obj, msg),
    debug: (obj, msg) => forward("debug", obj, msg),
    info: (obj, msg) => forward("info", obj, msg),
    warn: (obj, msg) => forward("warn", obj, msg),
    error: (obj, msg) => forward("error", obj, msg),
  };
}

function merge(bindings: Record<string, unknown>, obj: unknown): unknown {
  if (typeof obj === "object" && obj !== null && !Array.isArray(obj)) {
    return { ...bindings, ...(obj as Record<string, unknown>) };
  }
  if (Object.keys(bindings).length === 0) {
    return obj;
  }
  return { ...bindings, value: obj };
}
