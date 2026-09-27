/**
 * Why a WhatsApp connection was closed.
 *
 * This is a library-level enum: backends translate their provider-specific
 * disconnect codes into these values, and applications switch on them without
 * knowing anything about the underlying provider.
 */
export enum DisconnectReason {
  /** The session is no longer valid and a new login (QR/pairing) is required. */
  LoggedOut = "loggedOut",
  /** The stored session is corrupt or inconsistent with the server state. */
  BadSession = "badSession",
  /** Another device (or this account elsewhere) took over the connection. */
  ConnectionReplaced = "connectionReplaced",
  /** The account is not allowed to connect (banned/forbidden). */
  Forbidden = "forbidden",
  /** The backend refused the connection because of rate limiting. */
  RateLimited = "rateLimited",
  /** The server asked the client to restart the connection. */
  RestartRequired = "restartRequired",
  /** The connection was closed by the remote side. */
  ConnectionClosed = "connectionClosed",
  /** The connection dropped due to network loss. */
  ConnectionLost = "connectionLost",
  /** The connection timed out. */
  TimedOut = "timedOut",
  /** The WhatsApp service is temporarily unavailable. */
  ServiceUnavailable = "serviceUnavailable",
  /** The device could not reach the network at all. */
  NetworkError = "networkError",
  /** The disconnect could not be classified. */
  Unknown = "unknown",
}

/**
 * Disconnect reasons for which the client must NOT retry automatically.
 *
 * Retrying these in a loop would either never succeed (logged out) or annoy
 * the user (connection replaced), so the client surfaces them immediately.
 */
export const FATAL_DISCONNECT_REASONS: ReadonlySet<DisconnectReason> = new Set([
  DisconnectReason.LoggedOut,
  DisconnectReason.BadSession,
  DisconnectReason.ConnectionReplaced,
  DisconnectReason.Forbidden,
]);
