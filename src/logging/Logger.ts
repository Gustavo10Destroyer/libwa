/**
 * Minimal pluggable logging contract.
 *
 * The library never logs to stdout by default; a {@link Logger} must be
 * provided through `ClientOptions.logger` to observe internal activity.
 */
export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/** A logger that discards everything. Used as the default. */
export const nullLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/**
 * Creates a simple logger that prints to the console with an optional prefix.
 *
 * Useful for development; production bots should inject their own logger
 * (pino, winston, ...) by implementing {@link Logger}.
 */
export function createConsoleLogger(prefix = "libwa"): Logger {
  const format = (level: string, args: unknown[]): unknown[] => [`${prefix} ${level}:`, ...args];
  return {
    debug: (...args) => console.debug(...format("debug", args)),
    info: (...args) => console.info(...format("info", args)),
    warn: (...args) => console.warn(...format("warn", args)),
    error: (...args) => console.error(...format("error", args)),
  };
}
