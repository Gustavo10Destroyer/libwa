/**
 * Discriminator for the kind of interaction that occurred.
 *
 * Every interaction exposes one of these as `interaction.type`, and the
 * `is*()` type guards on {@link Interaction} narrow on the same values
 * (plus the class hierarchy for messages vs. commands).
 */
export enum InteractionType {
  /** A message was received (including media, locations, contacts, ...). */
  Message = "message",
  /** A message matched the configured command prefix. */
  Command = "command",
  /** A reaction was added to or removed from a message. */
  Reaction = "reaction",
  /** A message was edited or deleted. */
  MessageUpdate = "messageUpdate",
  /** Group participants were added, removed, promoted or demoted. */
  GroupParticipant = "groupParticipant",
  /** Group metadata (name, description, settings) changed. */
  GroupUpdate = "groupUpdate",
  /** A legacy interactive button was tapped. */
  Button = "button",
  /** A legacy interactive list row was selected. */
  List = "list",
}
