/**
 * Group entity module.
 *
 * `Group` and its metadata types live alongside `Chat` (they share the chat
 * base class); this module provides a stable import path for group concepts.
 */
export {
  Group,
  type GroupInit,
  type GroupMember,
  type GroupMetadata,
  type GroupParticipant,
  type GroupParticipantAction,
  type GroupRole,
  type GroupUpdateChanges,
} from "./Chat.js";
