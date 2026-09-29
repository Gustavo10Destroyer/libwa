import { downloadMediaMessage, jidNormalizedUser, makeWASocket } from "@whiskeysockets/baileys";
import type {
  AnyMessageContent,
  BaileysEventMap,
  MiscMessageGenerationOptions,
  GroupMetadata as ProviderGroupMetadata,
  WAMessage,
  WAMessageKey,
} from "@whiskeysockets/baileys";
import type { DisconnectReason } from "../../core/DisconnectReason.js";
import type { ChatId, Unsubscribe, UserId } from "../../core/ids.js";
import type { GroupMetadata } from "../../entities/Chat.js";
import { phoneFromId } from "../../entities/User.js";
import {
  ConnectionError,
  MessageError,
  NotFoundError,
  PermissionError,
  WhatsAppError,
  rethrowAsBackendError,
} from "../../errors/index.js";
import { TypedEventEmitter } from "../../events/TypedEventEmitter.js";
import { type Logger, nullLogger } from "../../logging/Logger.js";
import type {
  BackendBusinessProfile,
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
  BackendUserLookup,
  ProfilePictureType,
  WhatsAppBackend,
} from "../Backend.js";
import type {
  BackendEventListener,
  BackendEventMap,
  BackendEventName,
  BackendSelf,
} from "../events.js";
import { type BaileysAuthHandle, createBaileysAuth } from "./BaileysAuth.js";
import { mapDisconnectError, providerStatusCode } from "./BaileysDisconnect.js";
import { createProviderLogger } from "./BaileysLogger.js";
import type { MapperContext } from "./BaileysMapper.js";
import {
  mapChatKind,
  mapGroupMetadata,
  mapGroupParticipants,
  mapGroupUpdates,
  mapIncomingMessage,
  mapMessageUpdates,
  mapMessagesDelete,
  mapReaction,
  providerDate,
} from "./BaileysMapper.js";

/**
 * Baileys backend implementation.
 *
 * The class is intentionally module-private: only {@link createBaileysBackend}
 * is exported, so provider types can never leak into the public declaration
 * surface. Raw messages are cached in a bounded LRU so media downloads, quote
 * replies, edits and deletions can reference the exact provider payload.
 */

type ProviderSocket = ReturnType<typeof makeWASocket>;

type TextSend = Extract<AnyMessageContent, { text: string }>;
type ImageSend = Extract<AnyMessageContent, { image: unknown }>;
type VideoSend = Extract<AnyMessageContent, { video: unknown }>;
type AudioSend = Extract<AnyMessageContent, { audio: unknown }>;
type DocumentSend = Extract<AnyMessageContent, { document: unknown }>;
type StickerSend = Extract<AnyMessageContent, { sticker: unknown }>;
type LocationSend = Extract<AnyMessageContent, { location: unknown }>;

export interface BaileysBackendOptions {
  /** Browser identity used while logging in. */
  readonly browser?: readonly [name: string, version: string, platform: string];
  /** Ask the phone for full chat history on login (default: false). */
  readonly syncFullHistory?: boolean;
}

const DEFAULT_BROWSER: readonly [string, string, string] = ["libwa", "1.0.0", "1"];
const RAW_CACHE_LIMIT = 500;
const PROFILE_PICTURE_TIMEOUT_MS = 10_000;

/** Creates a backend backed by the Baileys provider. */
export function createBaileysBackend(options: BaileysBackendOptions = {}): WhatsAppBackend {
  return new BaileysBackend(options);
}

class BaileysBackend implements WhatsAppBackend {
  readonly id = "baileys";
  readonly #options: BaileysBackendOptions;
  readonly #events: TypedEventEmitter<BackendEventMap>;
  readonly #rawCache = new Map<string, WAMessage>();
  readonly #groupMetaCache = new Map<ChatId, ProviderGroupMetadata>();

  #logger: Logger = nullLogger;
  #connectOptions: BackendConnectOptions | undefined;
  #auth: BaileysAuthHandle | undefined;
  #socket: ProviderSocket | undefined;
  #unwire: (() => void) | undefined;
  #generation = 0;
  #status: "closed" | "connecting" | "open" = "closed";
  #selfId: string | undefined;
  #pairingRequested = false;
  #suppressEvents = false;

  constructor(options: BaileysBackendOptions) {
    this.#options = options;
    this.#events = new TypedEventEmitter<BackendEventMap>({
      onListenerError: (error) => {
        this.#logger.error("backend listener failed:", errorMessage(error));
      },
    });
  }

  // --- lifecycle ---------------------------------------------------------------

  async connect(options: BackendConnectOptions): Promise<void> {
    this.#connectOptions = options;
    this.#logger = options.logger;
    this.#suppressEvents = false;
    this.#pairingRequested = false;

    await this.#teardownSocket();
    const generation = ++this.#generation;
    this.#status = "connecting";

    const session = await options.sessionStore.load(options.sessionId);
    this.#auth = await createBaileysAuth(session, {
      store: options.sessionStore,
      sessionId: options.sessionId,
      provider: this.id,
      logger: options.logger,
    });

    const socket = makeWASocket({
      auth: this.#auth.auth,
      logger: createProviderLogger(options.logger),
      browser: [...(this.#options.browser ?? DEFAULT_BROWSER)],
      emitOwnEvents: false,
      syncFullHistory: this.#options.syncFullHistory ?? false,
      shouldSyncHistoryMessage: () => false,
      getMessage: (key) => Promise.resolve(this.#lookupRawByKey(key)?.message ?? undefined),
      cachedGroupMetadata: (jid) =>
        Promise.resolve(this.#groupMetaCache.get(jidNormalizedUser(jid))),
    });
    this.#socket = socket;
    this.#unwire = this.#wireEvents(socket, generation);

    this.#emitConnection({ status: "connecting" });
    if (this.#auth.auth.creds.me === undefined && options.pairingPhoneNumber !== undefined) {
      this.#startPairingRequest(socket, generation, options.pairingPhoneNumber);
    }
  }

  async disconnect(): Promise<void> {
    this.#suppressEvents = true;
    this.#generation += 1;
    await this.#teardownSocket();
    this.#status = "closed";
    await this.#auth?.flush();
  }

  isConnected(): boolean {
    return this.#status === "open" && this.#socket !== undefined;
  }

  // --- messaging ---------------------------------------------------------------

  async sendMessage(request: BackendSendMessage): Promise<BackendSentMessage> {
    const socket = this.#requireSocket();
    const content = this.#toProviderContent(request);
    const sendOptions: MiscMessageGenerationOptions = {};
    if (request.replyToMessageId !== undefined) {
      const quoted = this.#rawCache.get(`${request.chatId}:${request.replyToMessageId}`);
      if (quoted !== undefined) {
        sendOptions.quoted = quoted;
      }
    }

    let sent: WAMessage | undefined;
    try {
      sent = await socket.sendMessage(request.chatId, content, sendOptions);
    } catch (error) {
      if (error instanceof WhatsAppError) {
        throw error;
      }
      throw new MessageError(`Failed to send message: ${errorMessage(error)}`, { cause: error });
    }

    const messageId = sent?.key?.id;
    if (sent === undefined || messageId === undefined || messageId === null || messageId === "") {
      throw new MessageError("Provider did not confirm the sent message.");
    }
    this.#cacheRaw(request.chatId, messageId, sent);
    return {
      id: messageId,
      chatId: request.chatId,
      chatKind: mapChatKind(request.chatId),
      timestamp: providerDate(sent.messageTimestamp),
    };
  }

  async downloadMedia(request: BackendMediaDownload): Promise<Uint8Array> {
    const raw = this.#rawCache.get(`${request.chatId}:${request.messageId}`);
    if (raw === undefined || raw.message == null) {
      throw new NotFoundError(`Message ${request.messageId} is no longer available for download.`);
    }
    try {
      return await downloadMediaMessage(raw, "buffer", {});
    } catch (error) {
      throw new MessageError(`Failed to download media: ${errorMessage(error)}`, {
        cause: error,
      });
    }
  }

  async react(request: BackendReactRequest): Promise<void> {
    const socket = this.#requireSocket();
    const key = this.#targetKey(request.chatId, request.messageId, false);
    await this.#sendOrThrow(`React to ${request.messageId}`, () =>
      socket.sendMessage(request.chatId, { react: { text: request.emoji ?? "", key } }),
    );
  }

  async editMessage(request: BackendEditMessageRequest): Promise<void> {
    const socket = this.#requireSocket();
    const key = this.#targetKey(request.chatId, request.messageId, true);
    await this.#sendOrThrow(`Edit message ${request.messageId}`, () =>
      socket.sendMessage(request.chatId, { text: request.text, edit: key }),
    );
  }

  async deleteMessage(request: BackendDeleteMessageRequest): Promise<void> {
    const socket = this.#requireSocket();
    const key = this.#targetKey(request.chatId, request.messageId, true);
    await this.#sendOrThrow(`Delete message ${request.messageId}`, () =>
      socket.sendMessage(request.chatId, { delete: key }),
    );
  }

  // --- groups ------------------------------------------------------------------

  async getGroupMetadata(chatId: ChatId): Promise<GroupMetadata> {
    const socket = this.#requireSocket();
    try {
      const metadata = await socket.groupMetadata(chatId);
      this.#groupMetaCache.set(chatId, metadata);
      return mapGroupMetadata(metadata);
    } catch (error) {
      const status = providerStatusCode(error);
      if (status === 404) {
        throw new NotFoundError(`Group ${chatId} was not found.`, { cause: error });
      }
      if (status === 403 || status === 401) {
        throw new PermissionError(`No access to group ${chatId}.`, { cause: error });
      }
      rethrowAsBackendError(`Fetch metadata of group ${chatId}`, error);
    }
  }

  async updateGroupParticipants(request: BackendGroupParticipantsRequest): Promise<void> {
    const socket = this.#requireSocket();
    let results: Awaited<ReturnType<ProviderSocket["groupParticipantsUpdate"]>>;
    try {
      results = await socket.groupParticipantsUpdate(
        request.chatId,
        [...request.userIds],
        request.action,
      );
    } catch (error) {
      rethrowAsBackendError(`Update participants of ${request.chatId}`, error);
    }
    const failures = results.filter((result) => !isProviderSuccess(result.status));
    if (failures.length > 0 && failures.length === results.length) {
      throw new PermissionError(
        `Provider rejected participant update (${failures
          .map((result) => `${result.jid ?? "?"}: ${result.status}`)
          .join(", ")}).`,
      );
    }
    for (const failure of failures) {
      this.#logger.warn(
        `participant update partially rejected for ${request.chatId}:`,
        `${failure.jid ?? "?"} -> ${failure.status}`,
      );
    }
  }

  async updateGroupName(request: BackendGroupNameRequest): Promise<void> {
    const socket = this.#requireSocket();
    try {
      await socket.groupUpdateSubject(request.chatId, request.name);
    } catch (error) {
      rethrowAsBackendError(`Rename group ${request.chatId}`, error);
    }
  }

  async updateGroupDescription(request: BackendGroupDescriptionRequest): Promise<void> {
    const socket = this.#requireSocket();
    try {
      await socket.groupUpdateDescription(request.chatId, request.description);
    } catch (error) {
      rethrowAsBackendError(`Update description of group ${request.chatId}`, error);
    }
  }

  // --- session -----------------------------------------------------------------

  async requestPairingCode(phoneNumber: string): Promise<string> {
    const socket = this.#requireSocket();
    this.#pairingRequested = true;
    try {
      const code = await socket.requestPairingCode(phoneNumber);
      this.#emitConnection({ status: "connecting", pairingCode: code });
      return code;
    } catch (error) {
      rethrowAsBackendError("Request pairing code", error);
    }
  }

  async logout(): Promise<void> {
    const socket = this.#socket;
    if (socket === undefined) {
      return;
    }
    try {
      await socket.logout();
    } catch (error) {
      this.#logger.warn("provider logout failed:", errorMessage(error));
    } finally {
      await this.#teardownSocket();
    }
  }

  // --- identity resolution ------------------------------------------------------

  async getPhoneNumberForLid(lid: UserId): Promise<string | null> {
    const socket = this.#requireSocket();
    try {
      const jid = await socket.signalRepository.lidMapping.getPNForLID(lid);
      if (jid === null) return null;
      return phoneFromId(jidNormalizedUser(jid)) ?? null;
    } catch (error) {
      rethrowAsBackendError(`Resolve phone number for ${lid}`, error);
    }
  }

  async getLidForPhoneNumber(phone: string): Promise<UserId | null> {
    const socket = this.#requireSocket();
    try {
      const lid = await socket.signalRepository.lidMapping.getLIDForPN(`${phone}@s.whatsapp.net`);
      if (lid === null) return null;
      return jidNormalizedUser(lid);
    } catch (error) {
      rethrowAsBackendError(`Resolve linked id for ${phone}`, error);
    }
  }

  async fetchUser(phone: string): Promise<BackendUserLookup> {
    const socket = this.#requireSocket();
    try {
      // USync contact query (`onWhatsApp`); linked ids never reach it — the
      // service resolves them to digits first. The provider only reports
      // existence for phone-addressed lookups, so names stay unset here.
      const results = await socket.onWhatsApp(`${phone}@s.whatsapp.net`);
      if (results === undefined) {
        throw new Error("provider returned no user-lookup result");
      }
      return { exists: results.some((entry) => entry.exists) };
    } catch (error) {
      rethrowAsBackendError(`Fetch user ${phone}`, error);
    }
  }

  // --- profile enrichment --------------------------------------------------------

  async getProfilePictureUrl(id: UserId, type: ProfilePictureType): Promise<string | undefined> {
    const socket = this.#requireSocket();
    try {
      // Works for both id schemes (LID included); `undefined` = no picture.
      return await socket.profilePictureUrl(id, type, PROFILE_PICTURE_TIMEOUT_MS);
    } catch (error) {
      const status = providerStatusCode(error);
      if (status === 401 || status === 403 || status === 404) {
        // Private or absent picture — same answer as "no picture".
        return undefined;
      }
      rethrowAsBackendError(`Fetch profile picture of ${id}`, error);
    }
  }

  async getAbout(id: UserId): Promise<string | undefined> {
    const socket = this.#requireSocket();
    try {
      // USync status protocol: `{ status: string | null, setAt }` per row.
      // Empty string = hidden by privacy settings; null = not set.
      const rows = await socket.fetchStatus(id);
      const payload = rows?.[0]?.status as { status?: unknown } | undefined;
      const status = payload?.status;
      return typeof status === "string" && status !== "" ? status : undefined;
    } catch (error) {
      const status = providerStatusCode(error);
      if (status === 401 || status === 403 || status === 404) {
        return undefined;
      }
      rethrowAsBackendError(`Fetch about of ${id}`, error);
    }
  }

  async getBusinessProfile(id: UserId): Promise<BackendBusinessProfile | undefined> {
    const socket = this.#requireSocket();
    try {
      let jid = id;
      if (id.endsWith("@lid")) {
        const phone = await socket.signalRepository.lidMapping.getPNForLID(id);
        if (phone === null) {
          throw new Error(`linked id ${id} has no known phone number`);
        }
        jid = jidNormalizedUser(phone);
      }
      const profile = await socket.getBusinessProfile(jid);
      if (!profile) {
        // Probe completed with no profile — a standard account.
        return undefined;
      }
      return {
        description: profile.description ?? "",
        category: profile.category,
        email: profile.email,
        website: [...(profile.website ?? [])],
        address: profile.address,
      };
    } catch (error) {
      rethrowAsBackendError(`Fetch business profile of ${id}`, error);
    }
  }

  // --- events ------------------------------------------------------------------

  on<Name extends BackendEventName>(
    event: Name,
    listener: BackendEventListener<Name>,
  ): Unsubscribe {
    return this.#events.on(event, listener);
  }

  // --- internals ---------------------------------------------------------------

  #requireSocket(): ProviderSocket {
    const socket = this.#socket;
    if (socket === undefined) {
      throw new ConnectionError("Backend is not connected.");
    }
    return socket;
  }

  async #teardownSocket(): Promise<void> {
    const socket = this.#socket;
    if (socket === undefined) {
      return;
    }
    this.#socket = undefined;
    this.#status = "closed";
    this.#unwire?.();
    this.#unwire = undefined;
    try {
      await socket.end(undefined);
    } catch (error) {
      this.#logger.warn("failed to close provider connection:", errorMessage(error));
    }
  }

  #emitConnection(update: {
    status: "connecting" | "open" | "close";
    qr?: string | undefined;
    me?: BackendSelf | undefined;
    reason?: DisconnectReason | undefined;
    detail?: string | undefined;
    pairingCode?: string | undefined;
  }): void {
    if (this.#suppressEvents) {
      return;
    }
    this.#events.emit("connection", {
      status: update.status,
      qr: update.qr,
      me: update.me,
      reason: update.reason,
      detail: update.detail,
      pairingCode: update.pairingCode,
    });
  }

  #wireEvents(socket: ProviderSocket, generation: number): () => void {
    const unsubs: Unsubscribe[] = [];
    const alive = (): boolean => generation === this.#generation && !this.#suppressEvents;
    const subscribe = <Key extends keyof BaileysEventMap>(
      event: Key,
      listener: (arg: BaileysEventMap[Key]) => void,
    ): void => {
      socket.ev.on(event, listener);
      unsubs.push(() => {
        socket.ev.off(event, listener);
      });
    };

    subscribe("connection.update", (update) => {
      if (!alive()) return;
      if (update.connection === "open") {
        this.#status = "open";
        const user = socket.user;
        const me =
          user === undefined
            ? undefined
            : { id: jidNormalizedUser(user.id), name: user.notify ?? user.name ?? undefined };
        if (me !== undefined) {
          this.#selfId = me.id;
        }
        this.#emitConnection({ status: "open", me });
        return;
      }
      if (update.connection === "close") {
        this.#status = "closed";
        const mapped = mapDisconnectError(update.lastDisconnect?.error);
        this.#emitConnection({
          status: "close",
          reason: mapped.reason,
          detail: mapped.detail,
        });
        return;
      }
      if (update.qr !== undefined) {
        this.#maybeStartPairing(socket, generation);
        this.#emitConnection({ status: "connecting", qr: update.qr });
        return;
      }
      if (update.connection === "connecting") {
        this.#emitConnection({ status: "connecting" });
      }
    });

    subscribe("creds.update", () => {
      if (!alive()) return;
      void this.#auth?.persistCreds();
    });

    subscribe("messages.upsert", (upsert) => {
      if (!alive() || upsert.type !== "notify") return;
      const context = this.#mapperContext();
      for (const message of upsert.messages) {
        const event = mapIncomingMessage(message, context);
        if (event !== null) {
          this.#events.emit("message", event);
        }
      }
    });

    subscribe("messages.update", (updates) => {
      if (!alive()) return;
      for (const event of mapMessageUpdates(updates, this.#mapperContext())) {
        this.#events.emit("messageUpdate", event);
      }
    });

    subscribe("messages.delete", (event) => {
      if (!alive()) return;
      for (const mapped of mapMessagesDelete(event, this.#mapperContext())) {
        this.#events.emit("messageUpdate", mapped);
      }
    });

    subscribe("messages.reaction", (entries) => {
      if (!alive()) return;
      const context = this.#mapperContext();
      for (const entry of entries) {
        const event = mapReaction(entry, context);
        if (event !== null) {
          this.#events.emit("reaction", event);
        }
      }
    });

    subscribe("group-participants.update", (event) => {
      if (!alive()) return;
      const mapped = mapGroupParticipants(event, this.#mapperContext());
      if (mapped !== null) {
        this.#events.emit("groupParticipants", mapped);
      }
    });

    subscribe("groups.update", (updates) => {
      if (!alive()) return;
      for (const mapped of mapGroupUpdates(updates, this.#mapperContext())) {
        this.#events.emit("groupUpdate", mapped);
      }
    });

    subscribe("groups.upsert", (groups) => {
      if (!alive()) return;
      for (const group of groups) {
        this.#groupMetaCache.set(jidNormalizedUser(group.id), group);
      }
    });

    return () => {
      for (const off of unsubs) {
        off();
      }
    };
  }

  #mapperContext(): MapperContext {
    return {
      selfId: this.#selfId,
      cacheRaw: (chatId, messageId, message) => {
        this.#cacheRaw(chatId, messageId, message);
      },
      createDownloader: (chatId, messageId) => () => this.downloadMedia({ chatId, messageId }),
    };
  }

  #maybeStartPairing(socket: ProviderSocket, generation: number): void {
    const phone = this.#connectOptions?.pairingPhoneNumber;
    if (phone === undefined || this.#pairingRequested || this.#auth?.auth.creds.me !== undefined) {
      return;
    }
    this.#startPairingRequest(socket, generation, phone);
  }

  #startPairingRequest(socket: ProviderSocket, generation: number, phoneNumber: string): void {
    if (this.#pairingRequested) {
      return;
    }
    this.#pairingRequested = true;
    void socket
      .requestPairingCode(phoneNumber)
      .then((code) => {
        if (generation === this.#generation && !this.#suppressEvents) {
          this.#emitConnection({ status: "connecting", pairingCode: code });
        }
      })
      .catch((error: unknown) => {
        this.#logger.warn("failed to request pairing code:", errorMessage(error));
      });
  }

  #cacheRaw(chatId: ChatId, messageId: string, message: WAMessage): void {
    const cacheKey = `${chatId}:${messageId}`;
    this.#rawCache.delete(cacheKey);
    this.#rawCache.set(cacheKey, message);
    while (this.#rawCache.size > RAW_CACHE_LIMIT) {
      const oldest = this.#rawCache.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.#rawCache.delete(oldest);
    }
  }

  #lookupRaw(chatId: ChatId, messageId: string): WAMessage | undefined {
    return this.#rawCache.get(`${chatId}:${messageId}`);
  }

  #lookupRawByKey(key: WAMessageKey): WAMessage | undefined {
    if (key.remoteJid == null || key.remoteJid === "" || key.id == null || key.id === "") {
      return undefined;
    }
    return this.#lookupRaw(jidNormalizedUser(key.remoteJid), key.id);
  }

  /** Builds the provider key for an already-known message. */
  #targetKey(chatId: ChatId, messageId: string, assumeFromMe: boolean): WAMessageKey {
    const cached = this.#lookupRaw(chatId, messageId);
    if (cached?.key !== undefined && cached.key !== null) {
      return cached.key;
    }
    return { remoteJid: chatId, id: messageId, fromMe: assumeFromMe };
  }

  async #sendOrThrow(operation: string, send: () => Promise<unknown>): Promise<void> {
    try {
      await send();
    } catch (error) {
      if (error instanceof WhatsAppError) {
        throw error;
      }
      throw new MessageError(`${operation}: ${errorMessage(error)}`, { cause: error });
    }
  }

  #toProviderContent(request: BackendSendMessage): AnyMessageContent {
    const { content, mentionUserIds } = request;
    switch (content.kind) {
      case "text": {
        const payload: TextSend = { text: content.text };
        if (mentionUserIds.length > 0) {
          payload.mentions = [...mentionUserIds];
        }
        return payload;
      }
      case "image": {
        const payload: ImageSend = { image: this.#asBuffer(content.data) };
        if (content.caption !== undefined) payload.caption = content.caption;
        if (content.mimetype !== undefined) payload.mimetype = content.mimetype;
        if (mentionUserIds.length > 0) payload.mentions = [...mentionUserIds];
        return payload;
      }
      case "video": {
        const payload: VideoSend = { video: this.#asBuffer(content.data) };
        if (content.caption !== undefined) payload.caption = content.caption;
        if (content.mimetype !== undefined) payload.mimetype = content.mimetype;
        if (content.animated) payload.gifPlayback = true;
        if (mentionUserIds.length > 0) payload.mentions = [...mentionUserIds];
        return payload;
      }
      case "audio": {
        const payload: AudioSend = { audio: this.#asBuffer(content.data) };
        if (content.voice) payload.ptt = true;
        if (content.durationSeconds !== undefined) payload.seconds = content.durationSeconds;
        if (content.mimetype !== undefined) payload.mimetype = content.mimetype;
        return payload;
      }
      case "document": {
        const payload: DocumentSend = {
          document: this.#asBuffer(content.data),
          mimetype: content.mimetype ?? "application/octet-stream",
        };
        if (content.caption !== undefined) payload.caption = content.caption;
        if (content.fileName !== undefined) payload.fileName = content.fileName;
        return payload;
      }
      case "sticker": {
        const payload: StickerSend = { sticker: this.#asBuffer(content.data) };
        if (content.animated) payload.isAnimated = true;
        if (content.mimetype !== undefined) payload.mimetype = content.mimetype;
        return payload;
      }
      case "location": {
        const location: LocationSend["location"] = {
          degreesLatitude: content.latitude,
          degreesLongitude: content.longitude,
        };
        if (content.address !== undefined) location.address = content.address;
        if (content.name !== undefined) location.name = content.name;
        return { location };
      }
    }
  }

  #asBuffer(data: Uint8Array): Buffer {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
}

function isProviderSuccess(status: string): boolean {
  return status === "200" || status === "ok" || status === "409";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
