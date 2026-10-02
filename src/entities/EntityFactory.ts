import type { Client } from "../Client.js";
import type { BackendSentMessage } from "../backend/Backend.js";
import type {
  BackendIdPair,
  BackendMessageEvent,
  BackendMessageReference,
  BackendSelf,
} from "../backend/events.js";
import { LruMap } from "../core/LruMap.js";
import type { MessageContent } from "../core/content.js";
import type { ChatId, UserId } from "../core/ids.js";
import { Chat, Group } from "./Chat.js";
import type {
  ChatKind,
  GroupMetadata,
  GroupParticipant,
  GroupParticipantAction,
  GroupRole,
  GroupUpdateChanges,
} from "./Chat.js";
import { Message, type MessageReference } from "./Message.js";
import { User, phoneFromId } from "./User.js";

/** Conversations kept alive at once; older ones are evicted least-recently-used first. */
const MAX_CHATS = 512;
/** Group metadata records kept alive at once (each holds a full participant list). */
export const MAX_GROUP_METADATA = 512;
/** LID ↔ phone-number id pairs kept alive at once, per direction. */
const MAX_ID_PAIRS = 4096;
/** Remembered push names kept alive at once. */
const MAX_NAMES = 4096;

export interface ChatRef {
  readonly id: ChatId;
  readonly kind: ChatKind;
  readonly name?: string | undefined;
}

/** Mutable counterpart of {@link GroupUpdateChanges}, used while diffing. */
interface MutableGroupChanges {
  name?: string | undefined;
  description?: string | undefined;
  announceOnly?: boolean | undefined;
  locked?: boolean | undefined;
}

/**
 * Builds and caches entity instances (users, chats, groups, messages) from
 * normalized backend data.
 *
 * Chats and groups are cached per id so that identity is stable across
 * interactions (`interaction.chat === interaction.message.chat`). Users are
 * cheap value objects and are re-created on demand.
 *
 * Every cache here is bounded and least-recently-used: the process sees a new
 * distinct user/group eventually, and a cache that never evicts would keep the
 * first account's identities alive across a {@link EntityFactory.reset}.
 */
export class EntityFactory {
  readonly #client: Client;
  /** Metadata records are dropped together with their group, and vice versa. */
  readonly #groupMetadata: LruMap<GroupMetadata>;
  readonly #chats: LruMap<Chat>;
  readonly #lidToPn: LruMap<UserId>;
  readonly #pnToLid: LruMap<UserId>;
  readonly #names: LruMap<string>;
  /** Bumped by every local group write, so an in-flight fetch can be discarded. */
  readonly #revisions = new LruMap<number>(MAX_GROUP_METADATA);
  #me: User | null = null;

  constructor(client: Client) {
    this.#client = client;
    this.#chats = new LruMap<Chat>(MAX_CHATS, (id, chat) => {
      if (chat.isGroup()) this.#groupMetadata.delete(id);
    });
    this.#groupMetadata = new LruMap<GroupMetadata>(MAX_GROUP_METADATA, (id) => {
      this.#chats.delete(id);
      this.#revisions.delete(id);
    });
    // Id pairs are only useful in both directions: dropping one side would
    // make `altIdFor` asymmetric.
    this.#lidToPn = new LruMap<UserId>(MAX_ID_PAIRS, (_lid, pn) => {
      this.#pnToLid.delete(pn);
    });
    this.#pnToLid = new LruMap<UserId>(MAX_ID_PAIRS, (pn, lid) => {
      this.#lidToPn.delete(lid);
    });
    this.#names = new LruMap<string>(MAX_NAMES);
  }

  /** The logged-in user, once the connection reported it. */
  get me(): User | null {
    return this.#me;
  }

  /**
   * Drops every cached identity, name, id pair and group record.
   *
   * Called on logout and destroy: the caches describe the *logged-in account*,
   * and a `logout()` followed by a `login()` as somebody else must not serve
   * the previous account's chats, members or push names.
   */
  reset(): void {
    this.#me = null;
    this.#chats.clear();
    this.#groupMetadata.clear();
    this.#revisions.clear();
    this.#lidToPn.clear();
    this.#pnToLid.clear();
    this.#names.clear();
  }

  /** Records the logged-in account (called on connection open). */
  setSelf(self: BackendSelf): User {
    this.rememberName(self.id, self.name);
    this.#me = new User({
      id: self.id,
      name: self.name || this.#names.get(self.id),
      isMe: true,
      phone: this.phoneFor(self.id),
    });
    return this.#me;
  }

  /**
   * Records LID ↔ phone-number id pairs reported by the provider so linked
   * ids can later be resolved to phone numbers (and vice versa). Pairs whose
   * ends use the same addressing scheme, or where the phone-number end does
   * not parse as one, are ignored.
   */
  recordIdPairs(pairs: readonly BackendIdPair[] | undefined): void {
    if (pairs === undefined) return;
    for (const pair of pairs) {
      const { id, altId } = pair;
      const idIsLid = id.endsWith("@lid");
      if (idIsLid === altId.endsWith("@lid")) continue;
      const pn = idIsLid ? altId : id;
      const lid = idIsLid ? id : altId;
      if (phoneFromId(pn) === undefined) continue;
      this.#lidToPn.set(lid, pn);
      this.#pnToLid.set(pn, lid);
      // A push name seen under one scheme applies to both.
      const remembered = this.#names.get(lid) ?? this.#names.get(pn);
      if (remembered !== undefined) {
        this.#names.set(lid, remembered);
        this.#names.set(pn, remembered);
      }
      // The same conversation may already be cached under *both* schemes if
      // the pair only arrived now. Keep one instance so `chat()` identity
      // survives; lookups by the dropped id resolve through the pair.
      const lidChat = this.#chats.get(lid);
      const pnChat = this.#chats.get(pn);
      if (lidChat !== undefined && pnChat !== undefined && lidChat !== pnChat) {
        this.#chats.delete(pn);
      }
    }
  }

  /**
   * Remembers a display name (push name) seen for an id so later events that
   * carry only the id — mentions, reactions, group members, membership
   * changes — still know it. The name is stored under both addressing
   * schemes once the pair is known (and re-stored when the pair arrives).
   * Empty or absent names never overwrite a known one.
   */
  rememberName(id: UserId, name: string | undefined): void {
    if (name === undefined || name === "") return;
    this.#names.set(id, name);
    const twin = this.altIdFor(id);
    if (twin !== undefined) this.#names.set(twin, name);
  }

  /**
   * Phone digits for an id — from the id itself when it is a phone-number
   * JID, otherwise from a previously recorded pair. `undefined` when unknown.
   */
  phoneFor(id: UserId): string | undefined {
    const direct = phoneFromId(id);
    if (direct !== undefined) return direct;
    const pnId = this.#lidToPn.get(id);
    return pnId === undefined ? undefined : phoneFromId(pnId);
  }

  /** The same account's id in the other addressing scheme, when a pair is known. */
  altIdFor(id: UserId): UserId | undefined {
    return this.#lidToPn.get(id) ?? this.#pnToLid.get(id);
  }

  /**
   * Whether `id` is the logged-in account — under *either* addressing scheme.
   *
   * In LID-addressed groups the bot's own promote/demote and its own message
   * edits arrive carrying the linked id, so a strict comparison against
   * `me.id` would report the bot as somebody else.
   */
  isSelf(id: UserId): boolean {
    const me = this.#me;
    if (me === null) return false;
    return id === me.id || this.altIdFor(id) === me.id || this.altIdFor(me.id) === id;
  }

  /**
   * Creates a user value (never cached; `isMe` is resolved automatically).
   * When no name is given, the last push name seen for the id is used —
   * so mentions, reactions and group members carry names learned from
   * earlier messages.
   */
  user(id: UserId, name?: string | undefined): User {
    this.rememberName(id, name);
    return new User({
      id,
      name: name || this.#names.get(id),
      isMe: this.isSelf(id),
      phone: this.phoneFor(id),
    });
  }

  /** Resolves the logged-in user, or a placeholder before the first connection. */
  selfUser(): User {
    return this.#me ?? new User({ id: "", name: undefined, isMe: true });
  }

  /** Cached chat for an id, following a known LID ↔ phone-number alias. */
  #lookupChat(id: ChatId): Chat | undefined {
    const direct = this.#chats.get(id);
    if (direct !== undefined) return direct;
    const alt = this.altIdFor(id);
    return alt === undefined ? undefined : this.#chats.get(alt);
  }

  /**
   * Resolves (and caches) a chat.
   *
   * Only an upgrade replaces the cached entry: `unknown` is the placeholder
   * kind used by quoted references and unknown targets, and swapping a live
   * `direct`/`group` chat for it — or for any other kind — would orphan every
   * reference already handed out while still feeding them no further events.
   * Better knowledge upgrades in place; a known alias resolves to the same
   * instance rather than a second one.
   */
  chat(ref: ChatRef): Chat {
    if (ref.kind === "group") {
      return this.group(ref.id, ref.name);
    }
    const existing = this.#lookupChat(ref.id);
    if (existing !== undefined) {
      const upgrade = existing.kind === "unknown" && ref.kind !== "unknown";
      if (!upgrade) {
        // An empty name is "no information", never a new label — references
        // from quoted messages carry `""` and must not wipe a known one.
        if (ref.name !== undefined && ref.name !== "" && ref.name !== existing.name) {
          existing.updateName(ref.name);
        }
        return existing;
      }
      this.#chats.delete(existing.id);
    }
    const chat = new Chat({
      client: this.#client,
      id: ref.id,
      kind: ref.kind,
      name: ref.name,
    });
    this.#chats.set(ref.id, chat);
    return chat;
  }

  /** Returns the cached chat for an id (following known id aliases) without creating one. */
  knownChat(id: ChatId): Chat | undefined {
    return this.#lookupChat(id);
  }

  /** Resolves (and caches) a group chat, applying known metadata. */
  group(id: ChatId, name?: string | undefined): Group {
    const existing = this.#chats.get(id);
    if (existing?.isGroup()) {
      if (name !== undefined && name !== "" && name !== existing.name) {
        existing.updateName(name);
      }
      return existing;
    }
    const group = new Group({
      client: this.#client,
      id,
      name,
      metadata: this.#groupMetadata.get(id),
      entities: this,
    });
    this.#chats.set(id, group);
    return group;
  }

  /**
   * Stores group metadata in the cache (recording participant id pairs).
   *
   * This is the cache half of {@link EntityFactory.applyGroupMetadata}; it is
   * also what `Group.applyMetadata` calls so a metadata write through the
   * group instance and one through the factory cannot drift apart.
   *
   * A metadata *fetch* must not bump the revision — see
   * {@link EntityFactory.groupRevision}.
   */
  storeGroupMetadata(metadata: GroupMetadata): void {
    if (this.#groupMetadata.get(metadata.id) === metadata) return;
    for (const participant of metadata.participants) {
      if (participant.altId !== undefined) {
        this.recordIdPairs([{ id: participant.id, altId: participant.altId }]);
      }
    }
    this.#groupMetadata.set(metadata.id, metadata);
  }

  /** Stores fresh group metadata and returns the synchronized group instance. */
  applyGroupMetadata(metadata: GroupMetadata): Group {
    this.storeGroupMetadata(metadata);
    const group = this.group(metadata.id, metadata.name);
    group.applyMetadata(metadata);
    return group;
  }

  /** Previously stored group metadata, when available. */
  groupMetadata(id: ChatId): GroupMetadata | undefined {
    return this.#groupMetadata.get(id);
  }

  /**
   * Version of a group's cached metadata, bumped by every *local* write
   * (group update events, membership changes, a rename or description set).
   *
   * A metadata fetch reads it before the round-trip and re-checks it after:
   * a rename landing while the request was in flight was applied to a
   * snapshot taken before the rename, so the snapshot must be dropped rather
   * than revert the newer local state. Fetches themselves do not bump it —
   * otherwise two overlapping fetches would discard each other.
   */
  groupRevision(id: ChatId): number {
    return this.#revisions.get(id) ?? 0;
  }

  #bumpRevision(id: ChatId): void {
    this.#revisions.set(id, this.groupRevision(id) + 1);
  }

  /**
   * Keeps only the fields of `changes` that differ from the cached metadata
   * (all present fields when nothing is cached yet).
   *
   * Providers push complete group snapshots on a dirty-bit resync, so "every
   * present field" is not "every changed field". Diffing here — against the
   * cache the handler will read next — is what stops a snapshot from being
   * reported as a burst of changes the bot already knew about.
   *
   * Diffed *before* any metadata refresh: a refresh may fetch the
   * post-change snapshot and mask the very change being reported.
   */
  diffGroupChanges(groupId: ChatId, changes: GroupUpdateChanges): GroupUpdateChanges {
    const known = this.#groupMetadata.get(groupId);
    if (known === undefined) return { ...changes };
    const diff: MutableGroupChanges = {};
    if ("name" in changes && changes.name !== undefined && changes.name !== known.name) {
      diff.name = changes.name;
    }
    if ("description" in changes && changes.description !== known.description) {
      diff.description = changes.description;
    }
    if (
      "announceOnly" in changes &&
      changes.announceOnly !== undefined &&
      changes.announceOnly !== known.announceOnly
    ) {
      diff.announceOnly = changes.announceOnly;
    }
    if ("locked" in changes && changes.locked !== undefined && changes.locked !== known.locked) {
      diff.locked = changes.locked;
    }
    return diff;
  }

  /**
   * Applies a partial group change (name/description/settings) to cached state.
   *
   * Presence of a key decides whether the field is written, so a cleared
   * description (`description: undefined`) is applied instead of skipped.
   */
  applyGroupChanges(groupId: ChatId, changes: GroupUpdateChanges): Group {
    const group = this.group(groupId);
    const known = this.#groupMetadata.get(groupId);
    if (known !== undefined) {
      const merged: GroupMetadata = {
        ...known,
        ...("name" in changes && changes.name !== undefined ? { name: changes.name } : {}),
        ...("description" in changes ? { description: changes.description } : {}),
        ...("announceOnly" in changes && changes.announceOnly !== undefined
          ? { announceOnly: changes.announceOnly }
          : {}),
        ...("locked" in changes && changes.locked !== undefined ? { locked: changes.locked } : {}),
      };
      this.#groupMetadata.set(groupId, merged);
      this.#bumpRevision(groupId);
      // Keep the instance metadata in sync: `Group.name`/`description` prefer
      // metadata over the chat field, so a stale copy would shadow the change.
      group.applyMetadata(merged);
    } else if (changes.name !== undefined) {
      group.updateName(changes.name);
    }
    return group;
  }

  /**
   * Applies a membership change (add/remove/promote/demote) to cached group
   * metadata, so participant events keep the cache current without a
   * provider round-trip.
   *
   * Matching respects recorded LID ↔ phone-number id pairs, adds are
   * idempotent (an id already present is left alone), and added participants
   * start as plain members — a later `promote` event upgrades them. Actions
   * that cannot be mapped (`"other"`) and groups without cached metadata
   * leave everything untouched; the next `groups.ensure()` past the TTL
   * picks the state up from the provider instead.
   *
   * Caveat: add-idempotency is conditional on recorded pairs. When the
   * provider delivers an id this library has never seen paired with its
   * counterpart, a member already present under the other scheme cannot be
   * matched and is appended again — the duplicate is repaired by the next
   * metadata fetch. Both addressing schemes are unknown only until the first
   * pair arrives.
   */
  applyGroupParticipants(
    groupId: ChatId,
    action: GroupParticipantAction,
    participantIds: readonly UserId[],
  ): Group {
    const group = this.group(groupId);
    const known = this.#groupMetadata.get(groupId);
    if (known === undefined || participantIds.length === 0) {
      return group;
    }
    /** Whether a participant record is the account `id`, under either addressing scheme. */
    const sameAccount = (participant: GroupParticipant, id: UserId): boolean => {
      const alt = this.altIdFor(id);
      return (
        participant.id === id ||
        (alt !== undefined && participant.id === alt) ||
        participant.altId === id ||
        (participant.altId !== undefined && alt !== undefined && participant.altId === alt)
      );
    };
    const isTarget = (participant: GroupParticipant): boolean =>
      participantIds.some((id) => sameAccount(participant, id));
    let promoteTo: GroupRole | undefined;
    if (action === "promote") promoteTo = "admin";
    else if (action === "demote") promoteTo = "member";

    let participants: readonly GroupParticipant[];
    if (action === "add") {
      const missing = participantIds.filter(
        (id) => !known.participants.some((participant) => sameAccount(participant, id)),
      );
      if (missing.length === 0) {
        return group;
      }
      const added: GroupParticipant[] = missing.map((id) => ({
        id,
        altId: this.altIdFor(id),
        role: "member",
        name: undefined,
      }));
      participants = [...known.participants, ...added];
    } else if (action === "remove") {
      const kept = known.participants.filter((participant) => !isTarget(participant));
      if (kept.length === known.participants.length) {
        return group;
      }
      participants = kept;
    } else if (promoteTo !== undefined) {
      let changed = false;
      participants = known.participants.map((participant) => {
        if (!isTarget(participant)) return participant;
        const unchanged =
          participant.role === promoteTo ||
          (promoteTo === "admin" && participant.role === "superadmin");
        if (unchanged) return participant;
        changed = true;
        return { ...participant, role: promoteTo };
      });
      if (!changed) {
        return group;
      }
    } else {
      return group;
    }

    const merged: GroupMetadata = { ...known, participants };
    this.#groupMetadata.set(groupId, merged);
    this.#bumpRevision(groupId);
    group.applyMetadata(merged);
    return group;
  }

  /** Builds the domain message for a received message event. */
  message(event: BackendMessageEvent): Message {
    const chat = this.chat({ id: event.chatId, kind: event.chatKind });
    const reference =
      event.reference === undefined ? undefined : this.reference(event.reference, chat);
    return new Message({
      id: event.id,
      chat,
      author: this.user(event.authorId, event.authorName),
      content: event.content,
      timestamp: event.timestamp,
      isFromMe: event.isFromMe,
      isForwarded: event.isForwarded,
      mentions: event.mentions.map((id) => this.user(id)),
      reference,
    });
  }

  /** Builds the domain message returned after sending. */
  sentMessage(
    sent: BackendSentMessage,
    content: MessageContent,
    mentions: readonly UserId[],
    reference: MessageReference | undefined,
  ): Message {
    const chat = this.chat({ id: sent.chatId, kind: sent.chatKind });
    return new Message({
      id: sent.id,
      chat,
      author: this.selfUser(),
      content,
      timestamp: sent.timestamp,
      isFromMe: true,
      isForwarded: false,
      mentions: mentions.map((id) => this.user(id)),
      reference,
    });
  }

  /** Builds a message reference (quoted message). */
  reference(ref: BackendMessageReference, containingChat: Chat): MessageReference {
    const chat =
      ref.chatId === containingChat.id
        ? containingChat
        : this.chat({ id: ref.chatId, kind: "unknown" });
    return {
      messageId: ref.messageId,
      chat,
      author: ref.authorId === undefined ? undefined : this.user(ref.authorId),
      content: ref.content,
    };
  }
}
