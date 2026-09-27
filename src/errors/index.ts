/**
 * Error hierarchy of the library.
 *
 * Every error thrown by the library extends {@link WhatsAppError}, carries a
 * stable machine-readable {@link WhatsAppError.code} and may preserve the
 * underlying provider error in `cause` for debugging. Provider-specific error
 * classes never reach application code.
 */

export interface WhatsAppErrorOptions {
  /** Stable, machine-readable error code (e.g. `ERR_MESSAGE_SEND_FAILED`). */
  code?: string;
  /** The underlying error, preserved for debugging only. */
  cause?: unknown;
}

export class WhatsAppError extends Error {
  readonly code: string;

  constructor(message: string, options: WhatsAppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = options.code ?? "ERR_WHATSAPP";
  }
}

/** The connection could not be established, was lost, or the lifecycle was misused. */
export class ConnectionError extends WhatsAppError {
  constructor(message: string, options: WhatsAppErrorOptions = {}) {
    super(message, { code: "ERR_CONNECTION", ...options });
  }
}

/** Authentication failed or the stored session is no longer usable. */
export class AuthenticationError extends WhatsAppError {
  constructor(message: string, options: WhatsAppErrorOptions = {}) {
    super(message, { code: "ERR_AUTHENTICATION", ...options });
  }
}

/** Sending, editing, deleting or downloading a message failed. */
export class MessageError extends WhatsAppError {
  constructor(message: string, options: WhatsAppErrorOptions = {}) {
    super(message, { code: "ERR_MESSAGE", ...options });
  }
}

/** The account is not allowed to perform the requested operation. */
export class PermissionError extends WhatsAppError {
  constructor(message: string, options: WhatsAppErrorOptions = {}) {
    super(message, { code: "ERR_PERMISSION", ...options });
  }
}

/** A chat, user, group, command or message could not be found. */
export class NotFoundError extends WhatsAppError {
  constructor(message: string, options: WhatsAppErrorOptions = {}) {
    super(message, { code: "ERR_NOT_FOUND", ...options });
  }
}

/** The backend failed while performing an operation. */
export class BackendError extends WhatsAppError {
  constructor(message: string, options: WhatsAppErrorOptions = {}) {
    super(message, { code: "ERR_BACKEND", ...options });
  }
}

/** The active backend does not implement the requested capability. */
export class UnsupportedOperationError extends WhatsAppError {
  constructor(message: string, options: WhatsAppErrorOptions = {}) {
    super(message, { code: "ERR_UNSUPPORTED", ...options });
  }
}

/** The library was used incorrectly (invalid argument, invalid state, ...). */
export class ValidationError extends WhatsAppError {
  constructor(message: string, options: WhatsAppErrorOptions = {}) {
    super(message, { code: "ERR_VALIDATION", ...options });
  }
}

/** Normalizes an unknown thrown value into a WhatsAppError-compatible Error. */
export function toError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }
  return new WhatsAppError(String(value), { cause: value });
}

/**
 * Rethrows `error` preserving {@link WhatsAppError}s as-is and wrapping
 * anything else in a {@link BackendError} with the original as `cause`.
 * Used by services so consumers always see library-level errors.
 */
export function rethrowAsBackendError(operation: string, error: unknown): never {
  if (error instanceof WhatsAppError) {
    throw error;
  }
  throw new BackendError(`${operation}: ${errorMessage(error)}`, { cause: error });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
