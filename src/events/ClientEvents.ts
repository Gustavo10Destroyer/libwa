import type { Client } from "../Client.js";
import type { DisconnectReason } from "../core/DisconnectReason.js";
import type { Interaction } from "../interactions/Interaction.js";

/**
 * Events emitted by the client.
 *
 * This is a closed, provider-independent set: raw backend/provider events are
 * never surfaced. Listener arguments are fully inferred from the event name.
 */
export type ClientEvents = {
  /** The connection opened for the first time (or re-opened after a drop). */
  ready: [client: Client];
  /** An interaction passed the middleware pipeline and is ready to be handled. */
  interactionCreate: [interaction: Interaction];
  /** An error occurred in the library, middleware, commands or listeners. */
  error: [error: Error];
  /** The connection closed and will not be retried (fatal reason or retries exhausted). */
  disconnect: [reason: DisconnectReason];
  /** A reconnection attempt has been scheduled. */
  reconnecting: [attempt: number, delayMs: number];
  /**
   * A QR code is available for scanning. Emitted whenever the provider supplies
   * one — including while a pairing-code flow is already in progress.
   */
  qr: [qr: string];
  /** A pairing code is available for phone-number login. */
  pairingCode: [code: string];
};
