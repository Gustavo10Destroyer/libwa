import type { WhatsAppBackend } from "../backend/Backend.js";
import type { UserId } from "../core/ids.js";
import type { EntityFactory } from "../entities/EntityFactory.js";
import { phoneFromId } from "../entities/User.js";
import { rethrowAsBackendError } from "../errors/index.js";

/**
 * Phone-number ↔ linked-id resolution for users.
 *
 * WhatsApp addresses an account either by phone number (`<digits>@s.whatsapp.net`)
 * or by linked id (`<digits>@lid`, an opaque id that hides the number in groups
 * and other shared surfaces) — https://baileys.wiki/concepts/jids. Which form
 * arrives depends on the chat's addressing mode, so a handler that only sees
 * linked ids cannot read phone numbers off the id itself.
 *
 * This service resolves between the two forms: id pairs reported alongside
 * messages, group metadata and membership events answer instantly, and the
 * backend capability (`getPhoneNumberForLid` / `getLidForPhoneNumber`) is
 * consulted only when no pair is known yet. Backends without the capability
 * resolve `undefined`.
 *
 * ```ts
 * client.on("interactionCreate", async (i) => {
 *   if (!i.isMessage()) return;
 *   const phone = await i.client.users.resolvePhone(i.author.id);
 *   const text = phone === undefined ? "hello!" : `hello @${phone}`;
 *   await i.reply(text, { mentions: [i.author.id] });
 * });
 * ```
 */
export class UserService {
  readonly #backend: WhatsAppBackend;
  readonly #entities: EntityFactory;

  constructor(backend: WhatsAppBackend, entities: EntityFactory) {
    this.#backend = backend;
    this.#entities = entities;
  }

  /**
   * Phone digits (international, no `+`) for an id — from the id itself when
   * it is a phone-number JID, or from an id pair seen earlier. No I/O;
   * `undefined` when not yet known.
   */
  phone(id: UserId): string | undefined {
    return this.#entities.phoneFor(id);
  }

  /**
   * The same account's id in the other addressing scheme (linked id ↔
   * phone-number JID), from pairs seen earlier. No I/O; `undefined` when
   * unknown — use {@link UserService.resolvePhone} / {@link UserService.resolveLid}
   * to consult the provider.
   */
  altId(id: UserId): UserId | undefined {
    return this.#entities.altIdFor(id);
  }

  /**
   * Resolves an id to phone digits, asking the provider when no pair is
   * known yet. Phone-number ids answer with their own digits without I/O;
   * unresolvable ids, unknown ids from other schemes, and backends without
   * the capability resolve `undefined`.
   */
  async resolvePhone(id: UserId): Promise<string | undefined> {
    const known = this.phone(id);
    if (known !== undefined) return known;
    if (!id.endsWith("@lid") || this.#backend.getPhoneNumberForLid === undefined) return undefined;
    try {
      const digits = await this.#backend.getPhoneNumberForLid(id);
      if (digits === null) return undefined;
      this.#entities.recordIdPairs([{ id: `${digits}@s.whatsapp.net`, altId: id }]);
      return digits;
    } catch (error) {
      rethrowAsBackendError(`Resolve phone number for ${id}`, error);
    }
  }

  /**
   * Resolves an id to its linked id (`<digits>@lid`), asking the provider
   * when no pair is known yet. Linked ids answer with themselves; ids in
   * other schemes, unresolvable numbers and backends without the capability
   * resolve `undefined`.
   */
  async resolveLid(id: UserId): Promise<UserId | undefined> {
    if (id.endsWith("@lid")) return id;
    const digits = phoneFromId(id);
    if (digits === undefined) return undefined;
    const known = this.#entities.altIdFor(id);
    if (known !== undefined) return known;
    if (this.#backend.getLidForPhoneNumber === undefined) return undefined;
    try {
      const lid = await this.#backend.getLidForPhoneNumber(digits);
      if (lid === null) return undefined;
      this.#entities.recordIdPairs([{ id, altId: lid }]);
      return lid;
    } catch (error) {
      rethrowAsBackendError(`Resolve linked id for ${id}`, error);
    }
  }
}
