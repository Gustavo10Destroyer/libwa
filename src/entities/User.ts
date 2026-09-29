import type { UserId } from "../core/ids.js";

/**
 * Extracts the phone number from a user id when the id uses the standard
 * WhatsApp user JID format (`<digits>@s.whatsapp.net` / legacy `@c.us`),
 * returning the digits (international format, no `+`).
 *
 * This is a WhatsApp-protocol helper, not a provider detail: ids in other
 * formats (groups, linked ids, other backends) simply yield `undefined`.
 * Most notably a linked id (`<digits>@lid`) has no phone number in itself —
 * WhatsApp's dual identity model (phone-number JID vs linked id) is explained
 * at https://baileys.wiki/concepts/jids. Use `client.users.phone(id)` (or
 * `client.users.resolvePhone(id)`) when the id may be a linked id.
 */
export function phoneFromId(id: string): string | undefined {
  const match = /^(\d{5,})@(?:s\.whatsapp\.net|c\.us)$/.exec(id);
  return match?.[1];
}

export interface UserInit {
  /**
   * WhatsApp user id: either a phone-number JID (`<digits>@s.whatsapp.net`)
   * or a linked id (`<digits>@lid`) — both identify the same account
   * (https://baileys.wiki/concepts/jids).
   */
  readonly id: UserId;
  /**
   * Display name known at construction time — the sender's push name or
   * WhatsApp profile name as reported by the provider. Never a contact-list
   * name: the library does not sync your address book.
   */
  readonly name?: string | undefined;
  /**
   * Phone digits when already known ahead of construction (used for linked
   * ids whose pair has been resolved). Falls back to deriving them from `id`.
   */
  readonly phone?: string | undefined;
  /** Whether this user is the logged-in account. */
  readonly isMe?: boolean;
}

/**
 * A WhatsApp user.
 *
 * Users are value objects: they carry identity plus whatever display
 * information the provider supplied, and never expose raw provider payloads.
 * They are re-created per event — compare with {@link User.equals}.
 */
export class User {
  /**
   * WhatsApp user id: a phone-number JID (`<digits>@s.whatsapp.net`, legacy
   * `<digits>@c.us`) or a linked id (`<digits>@lid`). See
   * https://baileys.wiki/concepts/jids for how the two schemes relate.
   */
  readonly id: UserId;
  /**
   * Provider-reported display name (push name or WhatsApp profile name) at
   * construction time, otherwise `undefined`.
   */
  readonly name: string | undefined;
  /** Whether this is the logged-in account. */
  readonly isMe: boolean;

  readonly #phone: string | undefined;

  constructor(init: UserInit) {
    this.id = init.id;
    this.name = init.name;
    this.isMe = init.isMe ?? false;
    this.#phone = init.phone ?? phoneFromId(init.id);
  }

  /**
   * Phone number as digits (international format, no `+`), or `undefined`.
   *
   * Derived from {@link User.id} when it is a phone-number JID. For a linked
   * id (`…@lid`) it is populated only when the id pair has been resolved —
   * see `client.users.phone(id)` (known pairs, no I/O) and
   * `client.users.resolvePhone(id)` (asks the provider).
   */
  get phone(): string | undefined {
    return this.#phone;
  }

  /**
   * Best human-readable label, in `name → phone → id` order.
   *
   * A linked id without a resolved phone number and without a known name
   * shows the raw `…@lid` id.
   */
  get displayName(): string {
    return this.name ?? this.phone ?? this.id;
  }

  /** Whether `other` is the same account. Compares ids only. */
  equals(other: User | UserId): boolean {
    return this.id === (typeof other === "string" ? other : other.id);
  }

  toString(): string {
    return this.displayName;
  }
}
