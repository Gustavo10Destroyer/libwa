import type { WhatsAppBackend } from "../backend/Backend.js";
import type { ChatId, UserId } from "../core/ids.js";
import type { EntityFactory } from "../entities/EntityFactory.js";
import type { Group } from "../entities/Group.js";
import {
  UnsupportedOperationError,
  ValidationError,
  rethrowAsBackendError,
} from "../errors/index.js";

/** A group reference: a {@link Group} entity or a raw chat id. */
export type GroupTarget = Group | ChatId;

/**
 * Minimum interval between provider metadata round-trips for one group.
 *
 * Dispatch serves cached metadata inside this window and only (re)fetches
 * when it elapsed, so no group is queried more than once per minute.
 */
export const GROUP_METADATA_TTL_MS = 60_000;

interface UserLike {
  readonly id: UserId;
}

/**
 * Group management service (`client.groups`).
 *
 * Fetches metadata and performs member/setting operations through the active
 * backend. Capabilities the backend does not implement surface as
 * {@link UnsupportedOperationError} instead of failing mysteriously.
 *
 * Metadata reads come in two flavors: {@link GroupService.fetch} is the
 * explicit one — always a provider round-trip — while
 * {@link GroupService.ensure} is the cache-aware one dispatch uses, fetching
 * only when nothing was fetched for {@link GROUP_METADATA_TTL_MS}.
 */
export class GroupService {
  readonly #backend: WhatsAppBackend;
  readonly #entities: EntityFactory;
  /** When each group's last provider metadata attempt started (success or failure). */
  readonly #attemptedAt = new Map<ChatId, number>();
  /** In-flight provider metadata fetches, keyed by group — shared by concurrent callers. */
  readonly #inflight = new Map<ChatId, Promise<Group>>();

  constructor(backend: WhatsAppBackend, entities: EntityFactory) {
    this.#backend = backend;
    this.#entities = entities;
  }

  /**
   * Fetches full group metadata from the provider and returns a synchronized
   * {@link Group}.
   *
   * The target may be a {@link Group} entity, a full group JID
   * (`<id>@g.us`), or a bare group id (`120363…`, legacy `123456789-160…`) —
   * bare ids get the `@g.us` suffix appended. Every call performs a provider
   * round-trip (this method deliberately bypasses the cache used by
   * {@link GroupService.ensure}) and applies the fresh metadata to the
   * cached group instance, so handlers see current members and settings
   * afterwards.
   *
   * Provider failures surface as library errors: `NotFoundError`
   * (`ERR_NOT_FOUND`) for unknown groups, `PermissionError`
   * (`ERR_PERMISSION`) when the bot cannot see the group, and `BackendError`
   * (`ERR_BACKEND`) for everything else.
   */
  async fetch(target: GroupTarget): Promise<Group> {
    const chatId = this.#chatId(target);
    this.#attemptedAt.set(chatId, Date.now());
    try {
      const metadata = await this.#backend.getGroupMetadata(chatId);
      return this.#entities.applyGroupMetadata(metadata);
    } catch (error) {
      throw rethrowAsBackendError(`Failed to fetch group ${chatId}`, error);
    }
  }

  /**
   * Returns group metadata that was fetched within the last
   * {@link GROUP_METADATA_TTL_MS}, fetching it only when needed.
   *
   * - No provider round-trip for a group fetched within the TTL — the
   *   cached metadata answers (membership events and metadata updates keep
   *   it current in between).
   * - A group never fetched, or last fetched longer ago, is fetched once;
   *   concurrent callers share that single in-flight request.
   * - A failed attempt is not retried for the TTL either: the next calls
   *   serve whatever is cached (stale metadata, or none) without touching
   *   the provider, so a broken connection cannot turn into a request per
   *   event.
   *
   * This is what the client runs before dispatching group interactions, so
   * `interaction.member` resolves without a refetch per event. Provider
   * failures surface here exactly as in {@link GroupService.fetch} on the
   * attempt that performed them.
   */
  async ensure(target: GroupTarget): Promise<Group> {
    const chatId = this.#chatId(target);
    const pending = this.#inflight.get(chatId);
    if (pending !== undefined) {
      return pending;
    }
    const attemptedAt = this.#attemptedAt.get(chatId);
    if (attemptedAt !== undefined && Date.now() - attemptedAt < GROUP_METADATA_TTL_MS) {
      return this.#entities.group(chatId);
    }
    const request = this.fetch(chatId).finally(() => {
      this.#inflight.delete(chatId);
    });
    this.#inflight.set(chatId, request);
    return request;
  }

  /** Adds users to a group (requires admin rights). */
  addMembers(group: GroupTarget, users: readonly (UserLike | UserId)[]): Promise<void> {
    return this.#participants(group, users, "add");
  }

  /** Removes users from a group (requires admin rights). */
  removeMembers(group: GroupTarget, users: readonly (UserLike | UserId)[]): Promise<void> {
    return this.#participants(group, users, "remove");
  }

  /** Promotes members to admins. */
  promote(group: GroupTarget, users: readonly (UserLike | UserId)[]): Promise<void> {
    return this.#participants(group, users, "promote");
  }

  /** Demotes admins to regular members. */
  demote(group: GroupTarget, users: readonly (UserLike | UserId)[]): Promise<void> {
    return this.#participants(group, users, "demote");
  }

  /** Renames a group. */
  async rename(group: GroupTarget, name: string): Promise<void> {
    if (name.length === 0) {
      throw new ValidationError("Group name cannot be empty.", {
        code: "ERR_EMPTY_GROUP_NAME",
      });
    }
    if (!this.#backend.updateGroupName) {
      throw new UnsupportedOperationError(
        `Backend "${this.#backend.id}" does not support renaming groups.`,
      );
    }
    const chatId = this.#chatId(group);
    try {
      await this.#backend.updateGroupName({ chatId, name });
    } catch (error) {
      throw rethrowAsBackendError(`Failed to rename group ${chatId}`, error);
    }
    const known = this.#entities.groupMetadata(chatId);
    if (known !== undefined) {
      this.#entities.applyGroupMetadata({ ...known, name });
    }
  }

  /** Updates (or clears, passing `undefined`) a group description. */
  async setDescription(group: GroupTarget, description: string | undefined): Promise<void> {
    if (!this.#backend.updateGroupDescription) {
      throw new UnsupportedOperationError(
        `Backend "${this.#backend.id}" does not support updating group descriptions.`,
      );
    }
    const chatId = this.#chatId(group);
    try {
      await this.#backend.updateGroupDescription({ chatId, description });
    } catch (error) {
      throw rethrowAsBackendError(`Failed to update description of group ${chatId}`, error);
    }
    const known = this.#entities.groupMetadata(chatId);
    if (known !== undefined) {
      this.#entities.applyGroupMetadata({ ...known, description });
    }
  }

  async #participants(
    group: GroupTarget,
    users: readonly (UserLike | UserId)[],
    action: "add" | "remove" | "promote" | "demote",
  ): Promise<void> {
    if (!this.#backend.updateGroupParticipants) {
      throw new UnsupportedOperationError(
        `Backend "${this.#backend.id}" does not support changing group participants.`,
      );
    }
    const userIds = users.map((user) => (typeof user === "string" ? user : user.id));
    if (userIds.length === 0) {
      throw new ValidationError("At least one user is required.", {
        code: "ERR_EMPTY_USER_LIST",
      });
    }
    const chatId = this.#chatId(group);
    try {
      await this.#backend.updateGroupParticipants({ chatId, userIds, action });
    } catch (error) {
      throw rethrowAsBackendError(`Failed to ${action} group participants`, error);
    }
  }

  /**
   * Resolves a {@link GroupTarget} to the group chat id.
   *
   * Accepts a {@link Group} entity, a full group JID (`<id>@g.us`), or a bare
   * group id (`120363…`, legacy `123456789-160…`) — bare ids get the
   * `@g.us` suffix appended. Anything else passes through unchanged and
   * fails at the provider.
   */
  #chatId(target: GroupTarget): ChatId {
    const id = typeof target === "string" ? target : target.id;
    if (!id.includes("@") && /^\d+(-\d+)?$/.test(id)) {
      return `${id}@g.us`;
    }
    return id;
  }
}
