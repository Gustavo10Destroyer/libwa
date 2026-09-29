import type {
  BackendConnectOptions,
  BackendDeleteMessageRequest,
  BackendEditMessageRequest,
  BackendGroupDescriptionRequest,
  BackendGroupNameRequest,
  BackendGroupParticipantsRequest,
  BackendMediaDownload,
  BackendReactRequest,
  BackendSendMessage,
  BackendSentMessage,
  WhatsAppBackend,
} from "../../src/backend/Backend.js";
import type {
  BackendConnectionUpdate,
  BackendEventListener,
  BackendEventMap,
  BackendEventName,
} from "../../src/backend/events.js";
import { DisconnectReason } from "../../src/core/DisconnectReason.js";
import type { ChatId } from "../../src/core/ids.js";
import type { Unsubscribe } from "../../src/core/ids.js";
import type { GroupMetadata } from "../../src/entities/Chat.js";
import { TypedEventEmitter } from "../../src/events/TypedEventEmitter.js";

const SELF_ID = "5511888888888@s.whatsapp.net";

function chatKindOf(chatId: ChatId): BackendSentMessage["chatKind"] {
  if (chatId.endsWith("@g.us")) return "group";
  if (chatId.endsWith("@s.whatsapp.net") || chatId.endsWith("@lid")) return "direct";
  if (chatId.endsWith("@broadcast")) return "broadcast";
  if (chatId.endsWith("@newsletter")) return "newsletter";
  return "unknown";
}

export function groupMetadataFixture(id: ChatId = "123456789@g.us"): GroupMetadata {
  return {
    id,
    name: "Test Group",
    description: "A group for tests",
    ownerId: "111@s.whatsapp.net",
    createdAt: new Date(1_700_000_000_000),
    participants: [
      { id: "111@s.whatsapp.net", role: "admin", name: "Owner" },
      { id: "222@s.whatsapp.net", role: "member", name: undefined },
    ],
    announceOnly: false,
    locked: false,
  };
}

/**
 * In-memory backend used by core tests.
 *
 * Implements only the mandatory contract: tests that need optional
 * capabilities (react/edit/delete/group ops/pairing/logout) use
 * {@link CapableMockBackend}.
 */
export class MockBackend implements WhatsAppBackend {
  readonly id = "mock";
  readonly connectCalls: BackendConnectOptions[] = [];
  readonly sent: BackendSendMessage[] = [];

  connectError: unknown;
  sendError: unknown;
  metadataError: unknown;
  /** Overrides the metadata returned by `getGroupMetadata` (default: fixture). */
  metadataFixture: GroupMetadata | undefined;
  media: Uint8Array = new Uint8Array([1, 2, 3]);
  /** Group ids passed to `getGroupMetadata`, in call order. */
  readonly metadataCalls: ChatId[] = [];

  connected = false;

  readonly #events = new TypedEventEmitter<BackendEventMap>();
  #sentCount = 0;

  async connect(options: BackendConnectOptions): Promise<void> {
    this.connectCalls.push(options);
    if (this.connectError !== undefined) {
      throw this.connectError;
    }
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async sendMessage(request: BackendSendMessage): Promise<BackendSentMessage> {
    if (this.sendError !== undefined) {
      throw this.sendError;
    }
    this.sent.push(request);
    this.#sentCount += 1;
    return {
      id: `sent-${this.#sentCount}`,
      chatId: request.chatId,
      chatKind: chatKindOf(request.chatId),
      timestamp: new Date(1_700_000_000_000 + this.#sentCount),
    };
  }

  async downloadMedia(_request: BackendMediaDownload): Promise<Uint8Array> {
    return this.media;
  }

  async getGroupMetadata(chatId: ChatId): Promise<GroupMetadata> {
    this.metadataCalls.push(chatId);
    if (this.metadataError !== undefined) {
      throw this.metadataError;
    }
    return this.metadataFixture ?? groupMetadataFixture(chatId);
  }

  on<Name extends BackendEventName>(
    event: Name,
    listener: BackendEventListener<Name>,
  ): Unsubscribe {
    return this.#events.on(event, listener);
  }

  // --- test drivers -----------------------------------------------------------

  emit<Name extends BackendEventName>(event: Name, ...args: BackendEventMap[Name]): void {
    this.#events.emit(event, ...args);
  }

  connection(update: Partial<BackendConnectionUpdate>): void {
    this.emit("connection", {
      status: update.status ?? "connecting",
      qr: update.qr,
      me: update.me,
      reason: update.reason,
      detail: update.detail,
      pairingCode: update.pairingCode,
    });
  }

  open(self: { id: string; name: string | undefined } = { id: SELF_ID, name: "Bot" }): void {
    this.connection({ status: "open", me: self });
  }

  close(reason: DisconnectReason = DisconnectReason.ConnectionLost, detail?: string): void {
    this.connection({ status: "close", reason, detail });
  }

  showQr(code: string): void {
    this.connection({ status: "connecting", qr: code });
  }
}

/** A backend that also implements every optional capability. */
export class CapableMockBackend extends MockBackend {
  readonly reactCalls: BackendReactRequest[] = [];
  readonly editCalls: BackendEditMessageRequest[] = [];
  readonly deleteCalls: BackendDeleteMessageRequest[] = [];
  readonly participantCalls: BackendGroupParticipantsRequest[] = [];
  readonly renameCalls: BackendGroupNameRequest[] = [];
  readonly descriptionCalls: BackendGroupDescriptionRequest[] = [];
  readonly pairingRequests: string[] = [];

  logoutCalled = false;

  reactError: unknown;

  async react(request: BackendReactRequest): Promise<void> {
    if (this.reactError !== undefined) {
      throw this.reactError;
    }
    this.reactCalls.push(request);
  }

  async editMessage(request: BackendEditMessageRequest): Promise<void> {
    this.editCalls.push(request);
  }

  async deleteMessage(request: BackendDeleteMessageRequest): Promise<void> {
    this.deleteCalls.push(request);
  }

  async updateGroupParticipants(request: BackendGroupParticipantsRequest): Promise<void> {
    this.participantCalls.push(request);
  }

  async updateGroupName(request: BackendGroupNameRequest): Promise<void> {
    this.renameCalls.push(request);
  }

  async updateGroupDescription(request: BackendGroupDescriptionRequest): Promise<void> {
    this.descriptionCalls.push(request);
  }

  async requestPairingCode(phoneNumber: string): Promise<string> {
    this.pairingRequests.push(phoneNumber);
    return "ABCD-EFGH";
  }

  async logout(): Promise<void> {
    this.logoutCalled = true;
  }

  // --- identity resolution ------------------------------------------------------

  /** Lids passed to `getPhoneNumberForLid`, in call order. */
  readonly lidLookups: string[] = [];
  /** Phone digits passed to `getLidForPhoneNumber`, in call order. */
  readonly phoneLookups: string[] = [];
  /** What `getPhoneNumberForLid` resolves (default: unresolvable). */
  phoneForLidResult: string | null = null;
  /** What `getLidForPhoneNumber` resolves (default: unresolvable). */
  lidForPhoneResult: string | null = null;
  /** When set, both identity lookups throw it. */
  identityError: unknown;

  async getPhoneNumberForLid(lid: string): Promise<string | null> {
    if (this.identityError !== undefined) {
      throw this.identityError;
    }
    this.lidLookups.push(lid);
    return this.phoneForLidResult;
  }

  async getLidForPhoneNumber(phone: string): Promise<string | null> {
    if (this.identityError !== undefined) {
      throw this.identityError;
    }
    this.phoneLookups.push(phone);
    return this.lidForPhoneResult;
  }
}
