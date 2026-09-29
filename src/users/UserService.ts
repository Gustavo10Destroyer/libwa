import type {
  BackendBusinessProfile,
  BackendUserLookup,
  ProfilePictureType,
  WhatsAppBackend,
} from "../backend/Backend.js";
import type { UserId } from "../core/ids.js";
import type { EntityFactory } from "../entities/EntityFactory.js";
import { type User, phoneFromId } from "../entities/User.js";
import {
  UnsupportedOperationError,
  ValidationError,
  rethrowAsBackendError,
} from "../errors/index.js";

/** Account classification reported by {@link UserService.accountType}. */
export type AccountType = "standard" | "business";

/** A validated `fetch` input: canonical id plus phone digits when known. */
type FetchTarget =
  | { readonly kind: "phone"; readonly id: UserId; readonly phone: string }
  | { readonly kind: "lid"; readonly id: UserId; readonly phone: string | undefined };

/**
 * Validates and canonicalizes a {@link UserService.fetch} input.
 *
 * Accepts a phone-number JID (`<digits>@s.whatsapp.net`, legacy `@c.us`, and
 * device suffixes like `<digits>:12@…`), a linked id (`<digits>@lid`), or bare
 * phone digits with an optional leading `+`. Everything else throws
 * `ERR_INVALID_USER_ID` so that malformed input is never mistaken for a
 * non-existent account.
 */
function normalizeFetchTarget(raw: string): FetchTarget {
  const input = raw.trim();
  const lidDigits = /^(\d+)(?::\d+)?@lid$/.exec(input)?.[1];
  if (lidDigits !== undefined) {
    return { kind: "lid", id: `${lidDigits}@lid`, phone: undefined };
  }
  const phoneDigits = /^(\d+)(?::\d+)?@(?:s\.whatsapp\.net|c\.us)$/.exec(input)?.[1];
  if (phoneDigits !== undefined) {
    return { kind: "phone", id: `${phoneDigits}@s.whatsapp.net`, phone: phoneDigits };
  }
  if (!input.includes("@")) {
    const digits = input.startsWith("+") ? input.slice(1) : input;
    if (/^\d{5,}$/.test(digits)) {
      return { kind: "phone", id: `${digits}@s.whatsapp.net`, phone: digits };
    }
  }
  throw new ValidationError(
    `Invalid user id "${raw}": expected a phone-number JID (<digits>@s.whatsapp.net), a linked id (<digits>@lid), or bare phone digits.`,
    { code: "ERR_INVALID_USER_ID" },
  );
}
/**
 * Phone-number ↔ linked-id resolution for users (`client.users`).
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
 * resolve `undefined`. {@link UserService.fetch} additionally checks account
 * existence with the provider, and {@link UserService.pictureUrl},
 * {@link UserService.about} and {@link UserService.accountType} enrich a
 * known id with profile data the provider offers (each behind its own
 * optional capability — `User` itself stays a cheap value object).
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

  /**
   * Fetches a user from the provider and reports whether the account exists.
   *
   * ## Accepted input
   *
   * Either addressing scheme works ([JID vs LID](https://baileys.wiki/concepts/jids)):
   *
   * | Input | Example | Canonical id |
   * | --- | --- | --- |
   * | Phone-number JID | `5511999999999@s.whatsapp.net` | as given (legacy `@c.us` and device suffixes `<digits>:12@…` normalized) |
   * | Linked id | `123456789012345@lid` | as given |
   * | Bare phone digits | `5511999999999` (optional `+`) | `5511999999999@s.whatsapp.net` |
   *
   * Anything else — group ids, newsletter jids, empty or mixed strings —
   * throws `ValidationError` (`ERR_INVALID_USER_ID`): malformed input is a
   * caller error, never an "account does not exist" answer.
   *
   * ## Resolution rules
   *
   * - Phone-number inputs are checked with the backend's `fetchUser`
   *   capability directly.
   * - A linked id is first mapped to its phone number (recorded pair, then
   *   the `getPhoneNumberForLid` capability) and checked under those digits;
   *   the pair discovered on the way is recorded for later lookups.
   * - Resolves `undefined` when the provider reports the account does not
   *   exist, or when a linked id's phone number cannot be determined (no
   *   pair known and the provider's mapping answers nothing).
   * - Missing capabilities surface as `UnsupportedOperationError` instead of
   *   a misleading `undefined`: `fetchUser` for every call, plus
   *   `getPhoneNumberForLid` for linked ids with no recorded pair.
   * - Provider failures are rethrown as `BackendError`.
   *
   * The returned {@link User} carries the canonical input id, phone digits
   * from the recorded pair (linked ids), and the best known name: a name
   * reported by the lookup when the provider supplies one, otherwise the
   * last push name seen for that account.
   */
  async fetch(id: string): Promise<User | undefined> {
    const target = normalizeFetchTarget(id);
    if (this.#backend.fetchUser === undefined) {
      throw new UnsupportedOperationError(
        `Backend "${this.#backend.id}" does not support fetching users.`,
      );
    }
    let phone: string;
    if (target.kind === "lid") {
      let resolved = this.phone(target.id);
      if (resolved === undefined) {
        if (this.#backend.getPhoneNumberForLid === undefined) {
          throw new UnsupportedOperationError(
            `Backend "${this.#backend.id}" cannot look up phone numbers for linked ids.`,
          );
        }
        resolved = await this.resolvePhone(target.id);
        if (resolved === undefined) return undefined;
      }
      phone = resolved;
    } else {
      phone = target.phone;
    }
    let lookup: BackendUserLookup;
    try {
      lookup = await this.#backend.fetchUser(phone);
    } catch (error) {
      rethrowAsBackendError(`Fetch user ${target.id}`, error);
    }
    if (!lookup.exists) return undefined;
    return this.#entities.user(target.id, lookup.name ?? lookup.verifiedName);
  }

  /**
   * Profile-picture URL of an account (either id scheme), or `undefined`
   * when the account has no picture or keeps it private.
   *
   * Accepts the same input formats as {@link UserService.fetch} (phone JID,
   * legacy `@c.us`, device suffixes, bare digits, `…@lid`); anything else
   * throws `ValidationError` (`ERR_INVALID_USER_ID`). `type` selects the
   * resolution: `"image"` (default, full size) or `"preview"` (small).
   *
   * The URL comes straight from the provider — fetch it yourself, cache it
   * yourself; the library does not download or store pictures.
   *
   * **Errors:** `UnsupportedOperationError` when the backend lacks the
   * `getProfilePictureUrl` capability; `BackendError` on provider failures
   * (privacy-hidden pictures resolve `undefined` instead).
   */
  async pictureUrl(id: string, type: ProfilePictureType = "image"): Promise<string | undefined> {
    const target = normalizeFetchTarget(id);
    if (this.#backend.getProfilePictureUrl === undefined) {
      throw new UnsupportedOperationError(
        `Backend "${this.#backend.id}" does not support fetching profile pictures.`,
      );
    }
    try {
      return await this.#backend.getProfilePictureUrl(target.id, type);
    } catch (error) {
      rethrowAsBackendError(`Fetch profile picture of ${target.id}`, error);
    }
  }

  /**
   * About/bio text ("status") of an account (either id scheme), or
   * `undefined` when it is unset, hidden by privacy settings, or unknown.
   *
   * Accepts the same input formats as {@link UserService.fetch}; malformed
   * input throws `ValidationError` (`ERR_INVALID_USER_ID`).
   *
   * **Errors:** `UnsupportedOperationError` when the backend lacks the
   * `getAbout` capability; `BackendError` on provider failures (hidden or
   * empty about texts resolve `undefined` instead).
   */
  async about(id: string): Promise<string | undefined> {
    const target = normalizeFetchTarget(id);
    if (this.#backend.getAbout === undefined) {
      throw new UnsupportedOperationError(
        `Backend "${this.#backend.id}" does not support fetching about texts.`,
      );
    }
    try {
      return await this.#backend.getAbout(target.id);
    } catch (error) {
      rethrowAsBackendError(`Fetch about of ${target.id}`, error);
    }
  }

  /**
   * Account classification: `"business"` when the provider reports a
   * business profile for the account, `"standard"` when the probe completes
   * without one.
   *
   * Accepts the same input formats as {@link UserService.fetch}; malformed
   * input throws `ValidationError` (`ERR_INVALID_USER_ID`). Providers have
   * no single "business flag", so this is answered by probing the business
   * profile — one extra network round-trip per call.
   *
   * **Errors:** `UnsupportedOperationError` when the backend lacks the
   * `getBusinessProfile` capability; `BackendError` on provider failures
   * (including linked ids the provider cannot map to a phone number).
   */
  async accountType(id: string): Promise<AccountType> {
    const target = normalizeFetchTarget(id);
    if (this.#backend.getBusinessProfile === undefined) {
      throw new UnsupportedOperationError(
        `Backend "${this.#backend.id}" does not support fetching business profiles.`,
      );
    }
    let profile: BackendBusinessProfile | undefined;
    try {
      profile = await this.#backend.getBusinessProfile(target.id);
    } catch (error) {
      rethrowAsBackendError(`Fetch business profile of ${target.id}`, error);
    }
    return profile === undefined ? "standard" : "business";
  }
}
