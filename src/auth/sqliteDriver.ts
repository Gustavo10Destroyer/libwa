import { createRequire } from "node:module";
import { ValidationError } from "../errors/index.js";

/**
 * The slice of the SQLite driver this library actually uses.
 *
 * Deliberately tiny and structurally typed: the native binding is loaded at
 * runtime, so its declarations never reach the published type surface. The
 * store is written against this contract, which is what keeps swapping the
 * driver a change to `src/auth/` and nothing a consumer can see.
 */
export interface SqliteStatement {
  get(...params: readonly unknown[]): unknown;
  run(...params: readonly unknown[]): unknown;
}

export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
}

export interface SqliteDriver {
  new (filename: string): SqliteDatabase;
}

let cachedDriver: SqliteDriver | undefined;

/**
 * Narrows a required module to a driver constructor.
 *
 * The shape check exists because CommonJS `require()` and an interop-wrapped
 * module disagree about where the export lives, and a wrong guess surfaces as
 * `x is not a constructor` long after the real cause.
 */
export function resolveDriver(exported: unknown): SqliteDriver {
  if (typeof exported !== "function") {
    throw driverError(new TypeError("better-sqlite3 does not export a Database constructor"));
  }
  return exported as SqliteDriver;
}

function driverError(cause: unknown): ValidationError {
  return new ValidationError(
    'SqliteSessionStore needs the "better-sqlite3" driver that ships with libwa, but it could not be loaded. ' +
      "Reinstall libwa without --ignore-scripts so the native binding is built.",
    { code: "ERR_SESSION_STORE", cause },
  );
}

/**
 * Loads and memoizes the driver.
 *
 * The binding is native, so it is required lazily: a build that cannot load
 * it still imports `libwa` and still runs every other feature. Only
 * constructing a `SqliteSessionStore` fails, with an actionable error instead
 * of a load crash at import time.
 */
export function loadDriver(): SqliteDriver {
  if (cachedDriver !== undefined) {
    return cachedDriver;
  }
  const require = createRequire(import.meta.url);
  let exported: unknown;
  try {
    exported = require("better-sqlite3");
  } catch (error) {
    throw driverError(error);
  }
  const driver = resolveDriver(exported);
  cachedDriver = driver;
  return driver;
}
