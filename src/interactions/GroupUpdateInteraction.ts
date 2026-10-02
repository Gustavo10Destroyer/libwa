import type { Client } from "../Client.js";
import type { Group, GroupUpdateChanges } from "../entities/Group.js";
import { Interaction } from "./Interaction.js";
import { InteractionType } from "./InteractionType.js";

export type { GroupUpdateChanges };

export interface GroupUpdateInit {
  readonly id: string;
  readonly group: Group;
  readonly changes: GroupUpdateChanges;
  readonly timestamp: Date;
}

/**
 * An interaction produced when group metadata changes (name, description,
 * announcement mode, ...).
 */
export class GroupUpdateInteraction extends Interaction {
  override readonly type = InteractionType.GroupUpdate;

  /** The group that changed (cached metadata, kept current by the event itself). */
  override readonly group: Group;
  /** What changed. */
  readonly changes: GroupUpdateChanges;

  constructor(client: Client, init: GroupUpdateInit) {
    super(client, {
      id: init.id,
      timestamp: init.timestamp,
      chat: init.group,
      author: undefined,
      isFromMe: false,
    });
    this.group = init.group;
    this.changes = init.changes;
  }

  /** True when the group name changed. */
  get hasNameChange(): boolean {
    return this.changes.name !== undefined;
  }

  /** True when the group description changed. */
  get hasDescriptionChange(): boolean {
    return this.changes.description !== undefined;
  }
}
