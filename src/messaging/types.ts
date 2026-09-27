import type { UserId } from "../core/ids.js";
import type { Message } from "../entities/Message.js";
import type { User } from "../entities/User.js";

/**
 * High-level outgoing message types.
 *
 * Users describe WHAT to send (`ReplyContent`); the library validates and
 * normalizes it into the backend's outbound representation. Media is plain
 * bytes — no provider structures anywhere.
 */

/** Raw media bytes, optionally with an explicit MIME type. */
export type MediaSource = Uint8Array | { data: Uint8Array; mimetype?: string };

/** Structured message payload. Exactly one body (text / media / location) is required. */
export interface MessagePayload {
  /** Text body of the message. */
  text?: string;
  /** Image attachment. */
  image?: MediaSource;
  /** Video attachment. */
  video?: MediaSource;
  /** Audio attachment. */
  audio?: MediaSource & { voice?: boolean };
  /** Document attachment. */
  document?: MediaSource & { fileName?: string };
  /** Sticker attachment. */
  sticker?: MediaSource;
  /** Caption for image/video/document payloads. */
  caption?: string;
  /** Location body. */
  location?: {
    latitude: number;
    longitude: number;
    address?: string;
    name?: string;
  };
  /** Users to mention (@) in this message. */
  mentions?: readonly (User | UserId)[];
}

/** Everything accepted by reply/send APIs: a plain string or a structured payload. */
export type ReplyContent = string | MessagePayload;

/** Options accepted when sending a message. */
export interface SendOptions {
  /** Quote an explicit message (takes precedence over `replyToMessageId`). */
  quote?: Message;
  /**
   * Quote a message by id alone. Used when only the id is known (e.g.
   * replying to the message a reaction/button targeted).
   */
  replyToMessageId?: string;
  /** Additional users to mention beyond those listed in the payload. */
  mentions?: readonly (User | UserId)[];
}
