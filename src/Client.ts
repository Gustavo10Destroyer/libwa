import type { ClientOptions, ResolvedClientOptions } from "./ClientOptions.js";
import { resolveClientOptions } from "./ClientOptions.js";
import { FileSessionStore } from "./auth/FileSessionStore.js";
import type { SessionStore } from "./auth/SessionStore.js";
import type { WhatsAppBackend } from "./backend/Backend.js";
import { createDefaultBackend } from "./backend/createDefaultBackend.js";
import type { BackendConnectionUpdate } from "./backend/events.js";
import type { CommandDefinition } from "./commands/CommandDefinition.js";
import { CommandRegistry } from "./commands/CommandRegistry.js";
import { DisconnectReason, FATAL_DISCONNECT_REASONS } from "./core/DisconnectReason.js";
import type { ChatId, Unsubscribe } from "./core/ids.js";
import type { ChatKind } from "./entities/Chat.js";
import { EntityFactory } from "./entities/EntityFactory.js";
import type { User } from "./entities/User.js";
import {
  AuthenticationError,
  ConnectionError,
  ValidationError,
  rethrowAsBackendError,
  toError,
} from "./errors/index.js";
import type { ClientEvents } from "./events/ClientEvents.js";
import { type ListenerOf, TypedEventEmitter } from "./events/TypedEventEmitter.js";
import { GroupService } from "./groups/GroupService.js";
import type { Interaction } from "./interactions/Interaction.js";
import { InteractionFactory } from "./interactions/InteractionFactory.js";
import type { Logger } from "./logging/Logger.js";
import { MessageService } from "./messaging/MessageService.js";
import { type Middleware, runMiddlewareChain } from "./middleware/compose.js";
import { UserService } from "./users/UserService.js";

/** Lifecycle state of a client. */
export type ClientState = "idle" | "connecting" | "ready" | "destroyed";

interface LoginDeferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
}

/**
 * The entry point of the library.
 *
 * The client owns the connection lifecycle, subscribes to normalized backend
 * events, converts them into interactions, runs the middleware pipeline and
 * dispatches them to listeners. It composes focused services rather than
 * being a monolith:
 *
 * - `client.messages` — send/edit/delete/react
 * - `client.groups` — fetch metadata and manage groups
 * - `client.commands` — command registry
 * - `client.users` — phone number ↔ linked id resolution, user fetches
 *
 * ```ts
 * const client = new Client();
 * client.on("interactionCreate", async (interaction) => {
 *   if (interaction.isMessage()) await interaction.reply("Hello!");
 * });
 * await client.login();
 * ```
 */
export class Client {
  readonly #options: ResolvedClientOptions;
  readonly #logger: Logger;
  readonly #events: TypedEventEmitter<ClientEvents>;
  readonly #backend: WhatsAppBackend;
  readonly #sessionStore: SessionStore;
  readonly #entities: EntityFactory;
  readonly #registry: CommandRegistry;
  readonly #factory: InteractionFactory;
  readonly #middlewares: Middleware[] = [];
  readonly #backendListeners: Unsubscribe[] = [];

  /** High-level messaging service. */
  readonly messages: MessageService;
  /** Group management service. */
  readonly groups: GroupService;
  /** Command registry. */
  readonly commands: CommandRegistry;
  /** Phone number ↔ linked id resolution. */
  readonly users: UserService;

  #state: ClientState = "idle";
  #subscribed = false;
  #ready = false;
  #login: LoginDeferred | undefined;
  #reconnectAttempt = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: ClientOptions = {}) {
    this.#options = resolveClientOptions(options);
    this.#logger = this.#options.logger;
    this.#events = new TypedEventEmitter<ClientEvents>({
      onListenerError: (error, event) => {
        if (event === "error") {
          // A failing error handler must not re-enter the error event.
          this.#logger.error("[error listener]", toError(error).message);
          return;
        }
        this.#handleError(error, `listener for "${event}"`);
      },
    });
    this.#backend =
      typeof this.#options.backend === "function"
        ? this.#options.backend()
        : (this.#options.backend ?? createDefaultBackend());
    this.#sessionStore = this.#options.sessionStore ?? new FileSessionStore();
    this.#entities = new EntityFactory(this);
    this.#registry = new CommandRegistry();
    this.#factory = new InteractionFactory(
      this,
      this.#entities,
      this.#registry,
      this.#options.commandOptions,
    );
    this.messages = new MessageService(this.#backend, this.#entities);
    this.groups = new GroupService(this.#backend, this.#entities);
    this.commands = this.#registry;
    this.users = new UserService(this.#backend, this.#entities);
  }

  // --- public state ----------------------------------------------------------

  /** Current lifecycle state. */
  get state(): ClientState {
    return this.#state;
  }

  /** True while the connection is open. */
  get isReady(): boolean {
    return this.#ready;
  }

  /** The logged-in user, once the connection reported it. */
  get me(): User | null {
    return this.#entities.me;
  }

  /** The active backend (for advanced integrations; normal bots never need it). */
  get backend(): WhatsAppBackend {
    return this.#backend;
  }

  /** Session slot used by this client. */
  get sessionId(): string {
    return this.#options.sessionId;
  }

  // --- events ----------------------------------------------------------------

  /** Registers a listener for `event`. Returns an unsubscribe function. */
  on<Key extends keyof ClientEvents>(
    event: Key,
    listener: ListenerOf<ClientEvents, Key>,
  ): Unsubscribe {
    return this.#events.on(event, listener);
  }

  /** Registers a one-shot listener for `event`. */
  once<Key extends keyof ClientEvents>(
    event: Key,
    listener: ListenerOf<ClientEvents, Key>,
  ): Unsubscribe {
    return this.#events.once(event, listener);
  }

  /** Removes a listener (or all listeners) for `event`. */
  off<Key extends keyof ClientEvents>(event: Key, listener?: ListenerOf<ClientEvents, Key>): void {
    this.#events.off(event, listener);
  }

  // --- pipeline --------------------------------------------------------------

  /**
   * Appends a middleware to the interaction pipeline. Middlewares run in
   * order before listeners; skipping `next()` stops dispatch.
   */
  use(middleware: Middleware): this {
    this.#middlewares.push(middleware);
    return this;
  }

  // --- lifecycle -------------------------------------------------------------

  /**
   * Connects to WhatsApp. Resolves once the connection is open (after the
   * first `ready`) and rejects if authentication fails or reconnection is
   * exhausted before the first successful connection.
   *
   * Attach `qr` / `pairingCode` / `error` listeners before calling this.
   */
  login(): Promise<void> {
    if (this.#state === "destroyed") {
      return Promise.reject(
        new ConnectionError("This client has been destroyed and cannot log in again."),
      );
    }
    if (this.#ready) {
      return Promise.resolve();
    }
    if (this.#login !== undefined) {
      return this.#login.promise;
    }

    let resolveLogin!: () => void;
    let rejectLogin!: (error: Error) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolveLogin = resolve;
      rejectLogin = reject;
    });
    const deferred: LoginDeferred = { promise, resolve: resolveLogin, reject: rejectLogin };
    // Keep fire-and-forget `client.login()` from crashing the process on
    // rejection; callers that await still observe the rejection.
    void promise.catch(() => undefined);
    this.#login = deferred;
    this.#state = "connecting";
    this.#subscribeBackend();

    void this.#connectBackend().catch((error: unknown) => {
      const failure = toError(error);
      if (failure instanceof ValidationError || failure instanceof AuthenticationError) {
        // Configuration/session problems will not fix themselves: fail fast.
        this.#failLogin(
          failure instanceof ValidationError
            ? failure
            : new AuthenticationError(failure.message, { cause: failure }),
        );
        return;
      }
      this.#handleError(failure, "connect");
      this.#onClose({
        status: "close",
        qr: undefined,
        me: undefined,
        reason: DisconnectReason.NetworkError,
        detail: failure.message,
        pairingCode: undefined,
      });
    });

    return promise;
  }

  /**
   * Disconnects and permanently stops this client: listeners are detached,
   * pending reconnection is cancelled, and `login()` can no longer be called.
   */
  async destroy(): Promise<void> {
    if (this.#state === "destroyed") {
      return;
    }
    this.#state = "destroyed";
    this.#ready = false;
    if (this.#reconnectTimer !== undefined) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
    }
    this.#failLogin(new ConnectionError("Client was destroyed."), false);
    for (const unsubscribe of this.#backendListeners) {
      unsubscribe();
    }
    this.#backendListeners.length = 0;
    this.#subscribed = false;
    try {
      await this.#backend.disconnect();
    } catch (error) {
      this.#handleError(error, "disconnect during destroy");
    }
  }

  /**
   * Logs out: invalidates the session on the provider (when supported),
   * clears the persisted session and closes the connection. A subsequent
   * `login()` starts a fresh pairing flow.
   */
  async logout(): Promise<void> {
    if (this.#reconnectTimer !== undefined) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
    }
    if (this.#backend.logout) {
      try {
        await this.#backend.logout();
      } catch (error) {
        this.#handleError(error, "backend logout");
      }
    }
    await this.#sessionStore.clear(this.#options.sessionId);
    try {
      await this.#backend.disconnect();
    } catch (error) {
      this.#handleError(error, "disconnect after logout");
    }
    this.#ready = false;
    if (this.#state !== "destroyed") {
      this.#state = "idle";
    }
  }

  /**
   * Requests a pairing code for phone-number login. Only meaningful while
   * the client is connecting and the backend supports pairing codes.
   */
  async requestPairingCode(phoneNumber: string): Promise<string> {
    if (!/^\d{7,15}$/.test(phoneNumber)) {
      throw new ValidationError(
        "phoneNumber must contain 7-15 digits (international format, no '+').",
        { code: "ERR_INVALID_PHONE" },
      );
    }
    if (!this.#backend.requestPairingCode) {
      throw new ValidationError(`Backend "${this.#backend.id}" does not support pairing codes.`, {
        code: "ERR_UNSUPPORTED",
      });
    }
    try {
      return await this.#backend.requestPairingCode(phoneNumber);
    } catch (error) {
      throw rethrowAsBackendError("Failed to request pairing code", error);
    }
  }

  // --- internals -------------------------------------------------------------

  #subscribeBackend(): void {
    if (this.#subscribed) {
      return;
    }
    this.#subscribed = true;
    this.#backendListeners.push(
      this.#backend.on("connection", (update) => {
        this.#onConnectionUpdate(update);
      }),
      this.#backend.on("message", (event) => {
        void this.#dispatchChat(event.chatKind, event.chatId, () =>
          this.#factory.fromMessage(event),
        );
      }),
      this.#backend.on("messageUpdate", (event) => {
        void this.#dispatchChat(event.chatKind, event.chatId, () =>
          this.#factory.fromMessageUpdate(event),
        );
      }),
      this.#backend.on("reaction", (event) => {
        void this.#dispatchChat(event.chatKind, event.chatId, () =>
          this.#factory.fromReaction(event),
        );
      }),
      this.#backend.on("groupParticipants", (event) => {
        void this.#dispatchGroup(event.groupId, () => this.#factory.fromGroupParticipants(event));
      }),
      this.#backend.on("groupUpdate", (event) => {
        void this.#dispatchGroup(event.groupId, () => this.#factory.fromGroupUpdate(event));
      }),
    );
  }

  async #connectBackend(): Promise<void> {
    await this.#backend.connect({
      sessionId: this.#options.sessionId,
      sessionStore: this.#sessionStore,
      logger: this.#logger,
      pairingPhoneNumber: this.#options.pairingPhoneNumber,
    });
  }

  async #dispatch(interaction: Interaction): Promise<void> {
    try {
      await runMiddlewareChain(this.#middlewares, interaction, async () => {
        if (interaction.isCommand()) {
          const command: CommandDefinition | undefined = interaction.command;
          if (command !== undefined && this.#commandAllowed(command, interaction)) {
            try {
              await command.execute(interaction);
            } catch (error) {
              this.#handleError(error, `command "${interaction.name}"`);
            }
          }
        }
        for (const listener of this.#events.listenersOf("interactionCreate")) {
          try {
            await listener(interaction);
          } catch (error) {
            this.#handleError(error, "interactionCreate listener");
          }
        }
      });
    } catch (error) {
      this.#handleError(error, "middleware");
    }
  }

  /**
   * Refreshes the group's metadata, then builds and dispatches a group
   * interaction, so `interaction.group` carries current members and metadata
   * at dispatch time. A failed refresh is logged as a warning and the cached
   * state is used instead — dispatch is never blocked or dropped by it.
   */
  async #dispatchGroup(groupId: ChatId, create: () => Interaction): Promise<void> {
    try {
      await this.groups.fetch(groupId);
    } catch (error) {
      this.#logger.warn("[group refresh]", toError(error).message);
    }
    await this.#dispatch(create());
  }

  /**
   * Builds and dispatches a message-family interaction (message, command,
   * reaction, edit/delete). Group chats first ensure metadata is known —
   * fetching it when nothing is cached yet, once per group — so
   * `interaction.member` can answer with the author's role. A failed
   * fetch logs a warning and dispatch proceeds without metadata, never
   * blocked or dropped.
   */
  async #dispatchChat(kind: ChatKind, chatId: ChatId, create: () => Interaction): Promise<void> {
    if (kind === "group" && this.#entities.group(chatId).metadata === undefined) {
      try {
        await this.groups.fetch(chatId);
      } catch (error) {
        this.#logger.warn("[group refresh]", toError(error).message);
      }
    }
    let interaction: Interaction;
    try {
      interaction = create();
    } catch (error) {
      this.#handleError(error, "interaction build");
      return;
    }
    await this.#dispatch(interaction);
  }

  #commandAllowed(command: CommandDefinition, interaction: Interaction): boolean {
    if (command.groupOnly === true && !interaction.isFromGroup()) {
      return false;
    }
    if (command.dmOnly === true && !interaction.isFromDirectChat()) {
      return false;
    }
    return true;
  }

  #onConnectionUpdate(update: BackendConnectionUpdate): void {
    switch (update.status) {
      case "connecting":
        if (update.qr !== undefined) {
          this.#events.emit("qr", update.qr);
        }
        if (update.pairingCode !== undefined) {
          this.#events.emit("pairingCode", update.pairingCode);
        }
        return;
      case "open": {
        this.#reconnectAttempt = 0;
        if (update.me !== undefined) {
          this.#entities.setSelf(update.me);
        }
        const firstOpen = !this.#ready;
        this.#ready = true;
        this.#state = "ready";
        if (firstOpen) {
          this.#login?.resolve();
          this.#login = undefined;
        }
        this.#events.emit("ready", this);
        return;
      }
      case "close":
        this.#onClose(update);
        return;
    }
  }

  #onClose(update: BackendConnectionUpdate): void {
    if (this.#state === "destroyed") {
      return;
    }
    const reason = update.reason ?? DisconnectReason.Unknown;
    this.#ready = false;
    if (update.detail !== undefined) {
      this.#logger.debug(`connection closed: ${reason} (${update.detail})`);
    }

    const fatal = FATAL_DISCONNECT_REASONS.has(reason);
    const policy = this.#options.reconnect;
    const attempt = this.#reconnectAttempt + 1;
    const canRetry = !fatal && policy !== false && attempt <= policy.attempts;

    if (canRetry) {
      this.#reconnectAttempt = attempt;
      const delay = Math.min(
        policy.maxDelayMs,
        policy.initialDelayMs * policy.factor ** (attempt - 1),
      );
      this.#state = "connecting";
      this.#events.emit("reconnecting", attempt, delay);
      this.#reconnectTimer = setTimeout(() => {
        this.#reconnectTimer = undefined;
        if (this.#state === "destroyed") {
          return;
        }
        this.#state = "connecting";
        void this.#connectBackend().catch((error: unknown) => {
          this.#handleError(error, "reconnection");
          this.#onClose({
            status: "close",
            qr: undefined,
            me: undefined,
            reason,
            detail: error instanceof Error ? error.message : String(error),
            pairingCode: undefined,
          });
        });
      }, delay);
      this.#reconnectTimer.unref?.();
      return;
    }

    // No retry: surface the disconnect and fail any pending login().
    this.#state = "idle";
    if (fatal && this.#login !== undefined) {
      this.#failLogin(
        new AuthenticationError(`Authentication failed (${reason}). A new login is required.`),
      );
    } else if (this.#login !== undefined) {
      this.#failLogin(
        new ConnectionError(`Connection closed (${reason}) before the client became ready.`),
      );
    }
    this.#events.emit("disconnect", reason);
    if (!fatal && policy !== false) {
      this.#handleError(
        new ConnectionError(
          `Gave up reconnecting after ${this.#reconnectAttempt} attempt(s) (${reason}).`,
        ),
        "reconnect exhausted",
      );
    }
  }

  #failLogin(error: Error, report = true): void {
    const deferred = this.#login;
    if (deferred === undefined) {
      return;
    }
    this.#login = undefined;
    if (this.#state !== "destroyed") {
      this.#state = "idle";
    }
    if (report) {
      this.#handleError(error, "login");
    }
    deferred.reject(error);
  }

  #handleError(error: unknown, context: string): void {
    const normalized = toError(error);
    this.#logger.error(`[${context}]`, normalized.message);
    if (this.#events.hasListeners("error")) {
      this.#events.emit("error", normalized);
    }
  }
}
