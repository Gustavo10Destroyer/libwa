/**
 * Identifier types used across the library.
 *
 * Identifiers are plain strings at runtime so they can be logged, stored and
 * compared easily. Backends are responsible for producing them; the core only
 * passes them around. {@link User.phone} is derived from an id by a
 * protocol-level WhatsApp helper, never by user code.
 */

/** Identifier of a chat (direct chat, group, broadcast list, newsletter, ...). */
export type ChatId = string;

/** Identifier of a user (the same value a chat uses when the chat is a direct chat). */
export type UserId = string;

/** An unsubscribe function returned when registering event listeners. */
export type Unsubscribe = () => void;
