import type { Client } from "../Client.js";
import type { ChatId, UserId } from "../core/ids.js";
import { ValidationError } from "../errors/index.js";
import type { ReplyContent } from "../messaging/types.js";
import type { Message } from "./Message.js";
import { User } from "./User.js";

/** High-level classification of a chat. */
export type ChatKind = "direct" | "group" | "broadcast" | "newsletter" | "unknown";

export interface ChatInit {
  readonly client: Client;
  readonly id: ChatId;
  readonly kind: ChatKind;
  readonly name?: string | undefined;
}

/**
 * A WhatsApp conversation: a direct chat, broadcast list, newsletter, ...
 *
 * `Chat` is the entry point for chat-level actions (`send`) and narrows to
 * {@link Group} via {@link Chat.isGroup} — mirroring how the rest of the
 * library uses type guards for discovery. Instances are created by the
 * library's entity factory; programmatic construction of a group as a plain
 * `Chat` is rejected to keep narrowing sound.
 */
export class Chat {
  readonly client: Client;
  readonly id: ChatId;
  readonly kind: ChatKind;
  #name: string | undefined;

  constructor(init: ChatInit) {
    if (init.kind === "group" && new.target === Chat) {
      throw new ValidationError("Group chats must be constructed as Group instances.", {
        code: "ERR_ENTITY_CONSTRUCTION",
      });
    }
    this.client = init.client;
    this.id = init.id;
    this.kind = init.kind;
    this.#name = init.name;
  }

  /** Human-readable chat name when the provider knows it (group subject, ...). */
  get name(): string | undefined {
    return this.#name;
  }

  /** Best human-readable label for this chat. */
  get displayName(): string {
    return this.#name ?? this.id;
  }

  /** True when this chat is a group. Narrows `this` to `Group`. */
  isGroup(): this is Group {
    return this.kind === "group";
  }

  isDirect(): boolean {
    return this.kind === "direct";
  }

  isBroadcast(): boolean {
    return this.kind === "broadcast";
  }

  isNewsletter(): boolean {
    return this.kind === "newsletter";
  }

  /** Sends a message to this chat. */
  send(content: ReplyContent): Promise<Message> {
    return this.client.messages.send(this, content);
  }

  /** Synchronizes the locally known name (used by group updates and metadata fetches). */
  updateName(name: string | undefined): void {
    this.#name = name;
  }

  toString(): string {
    return this.displayName;
  }
}

/** A participant of a group together with their role. */
export interface GroupParticipant {
  readonly id: UserId;
  readonly role: GroupRole;
  readonly name: string | undefined;
}

/** Administrative role of a group participant. */
export type GroupRole = "member" | "admin" | "superadmin";

/** Full, normalized metadata of a group. */
export interface GroupMetadata {
  readonly id: ChatId;
  readonly name: string;
  readonly description: string | undefined;
  readonly ownerId: UserId | undefined;
  readonly createdAt: Date | undefined;
  readonly participants: readonly GroupParticipant[];
  readonly announceOnly: boolean;
  readonly locked: boolean;
}

/** Action applied to group participants. */
export type GroupParticipantAction = "add" | "remove" | "promote" | "demote" | "other";

/** What changed in a group. Only fields present in the change event are defined. */
export interface GroupUpdateChanges {
  readonly name?: string;
  readonly description?: string;
  readonly announceOnly?: boolean;
  readonly locked?: boolean;
}

export interface GroupInit {
  readonly client: Client;
  readonly id: ChatId;
  readonly name?: string | undefined;
  readonly metadata?: GroupMetadata | undefined;
}

/**
 * A WhatsApp group chat.
 *
 * Metadata (name, description, owner, members) is populated whenever the
 * provider supplied it — from a fetch, a group update, or an incoming group
 * event. Use {@link Group.refresh} to force a metadata fetch; member
 * management methods delegate to `client.groups`.
 */
export class Group extends Chat {
  #metadata: GroupMetadata | undefined;

  constructor(init: GroupInit) {
    super({
      client: init.client,
      id: init.id,
      kind: "group",
      name: init.metadata?.name ?? init.name,
    });
    this.#metadata = init.metadata;
  }

  /** Full metadata when known, otherwise `undefined` until fetched. */
  get metadata(): GroupMetadata | undefined {
    return this.#metadata;
  }

  override get name(): string | undefined {
    return this.#metadata?.name ?? super.name;
  }

  /** Group description when known. */
  get description(): string | undefined {
    return this.#metadata?.description;
  }

  /** Group owner when known. */
  get owner(): User | undefined {
    const ownerId = this.#metadata?.ownerId;
    return ownerId === undefined ? undefined : this.#makeUser(ownerId);
  }

  /** Known members (empty until metadata has been fetched). */
  get members(): readonly User[] {
    return (this.#metadata?.participants ?? []).map((p) => this.#makeUser(p.id, p.name));
  }

  /** Number of known members, or `undefined` when metadata is unknown. */
  get memberCount(): number | undefined {
    return this.#metadata?.participants.length;
  }

  /** Whether only admins may send messages, when known. */
  get announceOnly(): boolean | undefined {
    return this.#metadata?.announceOnly;
  }

  /** Merges freshly fetched metadata into this instance. */
  applyMetadata(metadata: GroupMetadata): void {
    this.#metadata = metadata;
    this.updateName(metadata.name);
  }

  /** Fetches fresh metadata from the provider and applies it to this instance. */
  async refresh(): Promise<this> {
    const fetched = await this.client.groups.fetch(this.id);
    if (fetched.metadata !== undefined) {
      this.applyMetadata(fetched.metadata);
    }
    return this;
  }

  /** Adds users to this group (requires admin rights). */
  addMembers(users: readonly (User | UserId)[]): Promise<void> {
    return this.client.groups.addMembers(this, users);
  }

  /** Removes users from this group (requires admin rights). */
  removeMembers(users: readonly (User | UserId)[]): Promise<void> {
    return this.client.groups.removeMembers(this, users);
  }

  /** Promotes members to admins. */
  promote(users: readonly (User | UserId)[]): Promise<void> {
    return this.client.groups.promote(this, users);
  }

  /** Demotes admins to regular members. */
  demote(users: readonly (User | UserId)[]): Promise<void> {
    return this.client.groups.demote(this, users);
  }

  /** Renames the group. */
  rename(name: string): Promise<void> {
    return this.client.groups.rename(this, name);
  }

  /** Updates (or clears, with `undefined`) the group description. */
  setDescription(description: string | undefined): Promise<void> {
    return this.client.groups.setDescription(this, description);
  }

  #makeUser(id: UserId, name?: string | undefined): User {
    return new User({ id, name, isMe: this.client.me?.id === id });
  }
}
