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

interface UserLike {
  readonly id: UserId;
}

/**
 * Group management service (`client.groups`).
 *
 * Fetches metadata and performs member/setting operations through the active
 * backend. Capabilities the backend does not implement surface as
 * {@link UnsupportedOperationError} instead of failing mysteriously.
 */
export class GroupService {
  readonly #backend: WhatsAppBackend;
  readonly #entities: EntityFactory;

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
   * round-trip (nothing is served from cache) and applies the fresh metadata
   * to the cached group instance, so handlers see current members and
   * settings afterwards.
   *
   * Provider failures surface as library errors: `NotFoundError`
   * (`ERR_NOT_FOUND`) for unknown groups, `PermissionError`
   * (`ERR_PERMISSION`) when the bot cannot see the group, and `BackendError`
   * (`ERR_BACKEND`) for everything else.
   */
  async fetch(target: GroupTarget): Promise<Group> {
    const chatId = this.#chatId(target);
    try {
      const metadata = await this.#backend.getGroupMetadata(chatId);
      return this.#entities.applyGroupMetadata(metadata);
    } catch (error) {
      throw rethrowAsBackendError(`Failed to fetch group ${chatId}`, error);
    }
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
