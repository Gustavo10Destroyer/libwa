import type { Client } from "../Client.js";
import type { ChatId, UserId } from "../core/ids.js";
import { ValidationError } from "../errors/index.js";
import type { ReplyContent } from "../messaging/types.js";
import type { EntityFactory } from "./EntityFactory.js";
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
  /** Member id — phone-number JID (`…@s.whatsapp.net`) or linked id (`…@lid`). */
  readonly id: UserId;
  /**
   * The same member's id in the other addressing scheme, when the provider
   * reported it (LID ↔ phone number, see https://baileys.wiki/concepts/jids).
   */
  readonly altId?: UserId | undefined;
  readonly role: GroupRole;
  readonly name: string | undefined;
  /** Provider-reported `@handle` for this participant, when present. */
  readonly username?: string | undefined;
}

/** Administrative role of a group participant. */
export type GroupRole = "member" | "admin" | "superadmin";

/**
 * Membership of a {@link User} inside one specific group.
 *
 * Group-scoped counterpart of {@link User}: roles and tags exist only per
 * group, never globally, so a `GroupMember` always pairs the account-level
 * `user` with the group-level `role` and `tag`.
 */
export interface GroupMember {
  /** The account-level entity for this member (same instance as the interaction author when built from one). */
  readonly user: User;
  /** Role inside this group: `member`, `admin` or `superadmin`. */
  readonly role: GroupRole;
  /** The member's label in this group — the name recorded in group metadata, else their `@handle`. */
  readonly tag: string | undefined;
}

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
  /** Factory used to build members/owner users (resolves known id pairs). */
  readonly entities?: EntityFactory | undefined;
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
  readonly #entities: EntityFactory | undefined;

  constructor(init: GroupInit) {
    super({
      client: init.client,
      id: init.id,
      kind: "group",
      name: init.metadata?.name ?? init.name,
    });
    this.#metadata = init.metadata;
    this.#entities = init.entities;
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

  /** Known members with their group-scoped role/tag (empty until metadata has been fetched). */
  get members(): readonly GroupMember[] {
    return (this.#metadata?.participants ?? []).map((participant) => ({
      user: this.#makeUser(participant.id, participant.name),
      role: participant.role,
      tag: participant.name ?? participant.username ?? undefined,
    }));
  }

  /**
   * Membership of one account in this group — `role`, `tag` and `user` — when
   * metadata is known and the account is a participant. Accepts a `User`
   * entity (kept as-is inside the member) or a raw id in either addressing
   * scheme; ids are matched across schemes through recorded id pairs.
   */
  member(target: User | UserId): GroupMember | undefined {
    const id = typeof target === "string" ? target : target.id;
    const participant = this.#findParticipant(id);
    if (participant === undefined) {
      return undefined;
    }
    return {
      user: typeof target === "string" ? this.#makeUser(participant.id, participant.name) : target,
      role: participant.role,
      tag: participant.name ?? participant.username ?? undefined,
    };
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
    if (this.#entities !== undefined) {
      return this.#entities.user(id, name);
    }
    return new User({ id, name, isMe: this.client.me?.id === id });
  }

  /** Finds a participant record, matching the id against both addressing schemes. */
  #findParticipant(id: UserId): GroupParticipant | undefined {
    const participants = this.#metadata?.participants;
    if (participants === undefined) {
      return undefined;
    }
    const alt = this.#entities?.altIdFor(id);
    return participants.find(
      (participant) =>
        participant.id === id ||
        (alt !== undefined && participant.id === alt) ||
        (participant.altId !== undefined &&
          (participant.altId === id || (alt !== undefined && participant.altId === alt))),
    );
  }
}
