import type { UserId } from "../core/ids.js";

/**
 * Extracts the phone number from a user id when the id uses the standard
 * WhatsApp user JID format (`<digits>@s.whatsapp.net` / legacy `@c.us`).
 *
 * This is a WhatsApp-protocol helper, not a provider detail: ids in other
 * formats (groups, linked ids, other backends) simply yield `undefined`.
 */
export function phoneFromId(id: string): string | undefined {
  const match = /^(\d{5,})@(?:s\.whatsapp\.net|c\.us)$/.exec(id);
  return match?.[1];
}

export interface UserInit {
  readonly id: UserId;
  /** Display name known at construction time (e.g. push name). */
  readonly name?: string | undefined;
  /** Whether this user is the logged-in account. */
  readonly isMe?: boolean;
}

/**
 * A WhatsApp user.
 *
 * Users are value objects: they carry identity plus whatever display
 * information the provider supplied, and never expose raw provider payloads.
 */
export class User {
  readonly id: UserId;
  readonly name: string | undefined;
  readonly isMe: boolean;

  constructor(init: UserInit) {
    this.id = init.id;
    this.name = init.name;
    this.isMe = init.isMe ?? false;
  }

  /** Phone number when derivable from the id, otherwise `undefined`. */
  get phone(): string | undefined {
    return phoneFromId(this.id);
  }

  /** Best human-readable label: name, then phone, then id. */
  get displayName(): string {
    return this.name ?? this.phone ?? this.id;
  }

  equals(other: User | UserId): boolean {
    return this.id === (typeof other === "string" ? other : other.id);
  }

  toString(): string {
    return this.displayName;
  }
}
