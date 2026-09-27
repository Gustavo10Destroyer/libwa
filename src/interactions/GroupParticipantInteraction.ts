import type { Client } from "../Client.js";
import type { Group, GroupParticipantAction } from "../entities/Group.js";
import type { User } from "../entities/User.js";
import { Interaction } from "./Interaction.js";
import { InteractionType } from "./InteractionType.js";

export interface GroupParticipantInit {
  readonly id: string;
  readonly group: Group;
  readonly action: GroupParticipantAction;
  readonly users: readonly User[];
  readonly actor: User | undefined;
  readonly timestamp: Date;
  readonly isFromMe: boolean;
}

/**
 * An interaction produced when group participants are added, removed,
 * promoted or demoted.
 */
export class GroupParticipantInteraction extends Interaction {
  override readonly type = InteractionType.GroupParticipant;

  /** The group the change happened in. */
  readonly group: Group;
  /** What happened to the participants. */
  readonly action: GroupParticipantAction;
  /** Affected users. */
  readonly users: readonly User[];

  constructor(client: Client, init: GroupParticipantInit) {
    super(client, {
      id: init.id,
      timestamp: init.timestamp,
      chat: init.group,
      author: init.actor,
      isFromMe: init.isFromMe,
    });
    this.group = init.group;
    this.action = init.action;
    this.users = init.users;
  }

  /** True when users were added to the group. */
  get isAdd(): boolean {
    return this.action === "add";
  }

  /** True when users were removed from the group. */
  get isRemove(): boolean {
    return this.action === "remove";
  }

  /** True when users were promoted to admin. */
  get isPromote(): boolean {
    return this.action === "promote";
  }

  /** True when users were demoted from admin. */
  get isDemote(): boolean {
    return this.action === "demote";
  }
}
