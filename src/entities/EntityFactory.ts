import type { Client } from "../Client.js";
import type { BackendSentMessage } from "../backend/Backend.js";
import type {
  BackendIdPair,
  BackendMessageEvent,
  BackendMessageReference,
  BackendSelf,
} from "../backend/events.js";
import type { MessageContent } from "../core/content.js";
import type { ChatId, UserId } from "../core/ids.js";
import { Chat, Group } from "./Chat.js";
import type { ChatKind, GroupMetadata, GroupUpdateChanges } from "./Chat.js";
import { Message, type MessageReference } from "./Message.js";
import { User, phoneFromId } from "./User.js";

export interface ChatRef {
  readonly id: ChatId;
  readonly kind: ChatKind;
  readonly name?: string | undefined;
}

/**
 * Builds and caches entity instances (users, chats, groups, messages) from
 * normalized backend data.
 *
 * Chats and groups are cached per id so that identity is stable across
 * interactions (`interaction.chat === interaction.message.chat`). Users are
 * cheap value objects and are re-created on demand.
 */
export class EntityFactory {
  readonly #client: Client;
  readonly #chats = new Map<ChatId, Chat>();
  readonly #groupMetadata = new Map<ChatId, GroupMetadata>();
  readonly #lidToPn = new Map<UserId, UserId>();
  readonly #pnToLid = new Map<UserId, UserId>();
  #me: User | null = null;

  constructor(client: Client) {
    this.#client = client;
  }

  /** The logged-in user, once the connection reported it. */
  get me(): User | null {
    return this.#me;
  }

  /** Records the logged-in account (called on connection open). */
  setSelf(self: BackendSelf): User {
    this.#me = new User({
      id: self.id,
      name: self.name,
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
    }
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

  /** Creates a user value (never cached; `isMe` is resolved automatically). */
  user(id: UserId, name?: string | undefined): User {
    return new User({
      id,
      name,
      isMe: id === this.#me?.id,
      phone: this.phoneFor(id),
    });
  }

  /** Resolves the logged-in user, or a placeholder before the first connection. */
  selfUser(): User {
    return this.#me ?? new User({ id: "", name: undefined, isMe: true });
  }

  /** Resolves (and caches) a chat, upgrading `unknown` kinds when better data arrives. */
  chat(ref: ChatRef): Chat {
    if (ref.kind === "group") {
      return this.group(ref.id, ref.name);
    }
    const existing = this.#chats.get(ref.id);
    if (existing !== undefined) {
      if (existing.kind === ref.kind) {
        if (ref.name !== undefined && ref.name !== existing.name) {
          existing.updateName(ref.name);
        }
        return existing;
      }
      // Provider knowledge improved (e.g. `unknown` → `direct`): replace the cache.
      this.#chats.delete(ref.id);
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

  /** Returns the cached chat for an id without creating one. */
  knownChat(id: ChatId): Chat | undefined {
    return this.#chats.get(id);
  }

  /** Resolves (and caches) a group chat, applying known metadata. */
  group(id: ChatId, name?: string | undefined): Group {
    const existing = this.#chats.get(id);
    if (existing?.isGroup()) {
      if (name !== undefined && name !== existing.name) {
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

  /** Stores fresh group metadata and returns the synchronized group instance. */
  applyGroupMetadata(metadata: GroupMetadata): Group {
    for (const participant of metadata.participants) {
      if (participant.altId !== undefined) {
        this.recordIdPairs([{ id: participant.id, altId: participant.altId }]);
      }
    }
    this.#groupMetadata.set(metadata.id, metadata);
    const group = this.group(metadata.id, metadata.name);
    group.applyMetadata(metadata);
    return group;
  }

  /** Previously stored group metadata, when available. */
  groupMetadata(id: ChatId): GroupMetadata | undefined {
    return this.#groupMetadata.get(id);
  }

  /** Applies a partial group change (name/description/settings) to cached state. */
  applyGroupChanges(groupId: ChatId, changes: GroupUpdateChanges): Group {
    const group = this.group(groupId);
    const known = this.#groupMetadata.get(groupId);
    if (known !== undefined) {
      const merged: GroupMetadata = {
        ...known,
        ...(changes.name !== undefined ? { name: changes.name } : {}),
        ...(changes.description !== undefined ? { description: changes.description } : {}),
        ...(changes.announceOnly !== undefined ? { announceOnly: changes.announceOnly } : {}),
        ...(changes.locked !== undefined ? { locked: changes.locked } : {}),
      };
      this.#groupMetadata.set(groupId, merged);
      // Keep the instance metadata in sync: `Group.name`/`description` prefer
      // metadata over the chat field, so a stale copy would shadow the change.
      group.applyMetadata(merged);
    } else if (changes.name !== undefined) {
      group.updateName(changes.name);
    }
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
