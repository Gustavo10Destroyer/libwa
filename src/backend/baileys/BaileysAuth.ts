import { BufferJSON, initAuthCreds, proto } from "@whiskeysockets/baileys";
import type {
  AuthenticationCreds,
  AuthenticationState,
  SignalDataSet,
  SignalDataTypeMap,
  SignalKeyStore,
} from "@whiskeysockets/baileys";
import type { Session, SessionStore } from "../../auth/SessionStore.js";
import { ValidationError } from "../../errors/index.js";
import type { Logger } from "../../logging/Logger.js";

/**
 * Authentication state persisted through a library {@link SessionStore}.
 *
 * Baileys mutates credentials in place on `creds.update`, so the backend
 * re-serializes the whole snapshot (creds + signal keys) whenever either
 * changes. Writes are coalesced so bursts of key updates produce a single
 * store write instead of one per key.
 */

const SESSION_FORMAT_VERSION = 1;

interface PersistedSession {
  readonly v: number;
  readonly creds: unknown;
  readonly keys: Record<string, Record<string, unknown>>;
}

export interface BaileysAuthHandle {
  /** State object handed to the provider. */
  readonly auth: AuthenticationState;
  /** Serializes the current snapshot; call whenever the provider updates creds. */
  persistCreds(): Promise<void>;
  /** Resolves once all scheduled writes have completed. */
  flush(): Promise<void>;
}

export interface BaileysAuthOptions {
  readonly store: SessionStore;
  readonly sessionId: string;
  /** Provider id that owns the session (e.g. `baileys`). */
  readonly provider: string;
  readonly logger: Logger;
}

/** Loads (or initializes) auth state and wires it to the session store. */
export async function createBaileysAuth(
  session: Session | null,
  options: BaileysAuthOptions,
): Promise<BaileysAuthHandle> {
  let restored:
    | { creds: AuthenticationCreds; keys: Record<string, Record<string, unknown>> }
    | undefined;

  if (session !== null && session.data.length > 0 && session.provider === options.provider) {
    restored = parseSessionData(session.data, options.sessionId);
  } else if (session !== null && session.data.length > 0) {
    options.logger.warn(
      `ignoring session stored by provider "${session.provider}" (expected "${options.provider}")`,
    );
  }

  const creds = restored?.creds ?? initAuthCreds();

  let chain: Promise<void> = Promise.resolve();
  let scheduled = false;

  const persist = (): Promise<void> => {
    if (scheduled) {
      return chain;
    }
    scheduled = true;
    chain = chain.then(async () => {
      scheduled = false;
      try {
        await options.store.save({
          id: options.sessionId,
          provider: options.provider,
          data: serializeSession(creds, keys),
          updatedAt: new Date(),
        });
      } catch (error) {
        options.logger.error(
          "failed to persist session",
          error instanceof Error ? error.message : String(error),
        );
      }
    });
    return chain;
  };

  /**
   * Resolves once every write scheduled so far has reached the store.
   *
   * `scheduled` flips false when a task *starts*, so a save already in flight
   * would slip past a `while (scheduled)` check. Await the chain tail instead,
   * and keep waiting while new writes got scheduled along the way.
   */
  const flush = async (): Promise<void> => {
    let tail = chain;
    await tail;
    while (chain !== tail) {
      tail = chain;
      await tail;
    }
  };

  const keys = new SessionKeyStore(persist, restored?.keys);

  return {
    auth: { creds, keys },
    persistCreds: persist,
    flush,
  };
}

/** In-memory signal key store backed by the serialized session blob. */
class SessionKeyStore implements SignalKeyStore {
  readonly #data = new Map<string, Map<string, unknown>>();
  readonly #onChange: () => Promise<void>;

  constructor(onChange: () => Promise<void>, initial?: Record<string, Record<string, unknown>>) {
    this.#onChange = onChange;
    if (initial !== undefined) {
      for (const [type, bucket] of Object.entries(initial)) {
        this.#data.set(type, new Map(Object.entries(bucket)));
      }
    }
  }

  async get<T extends keyof SignalDataTypeMap>(
    type: T,
    ids: string[],
  ): Promise<{ [id: string]: SignalDataTypeMap[T] }> {
    const bucket = this.#data.get(type);
    if (bucket === undefined) {
      return {};
    }
    const result: { [id: string]: SignalDataTypeMap[T] } = {};
    for (const id of ids) {
      const value = bucket.get(id);
      if (value !== undefined) {
        result[id] = reviveKeyValue(type, value) as SignalDataTypeMap[T];
      }
    }
    return result;
  }

  async set(data: SignalDataSet): Promise<void> {
    let changed = false;
    for (const rawType of Object.keys(data)) {
      const type = rawType as keyof SignalDataTypeMap;
      const entries = data[type];
      if (entries === undefined) {
        continue;
      }
      let bucket = this.#data.get(type);
      if (bucket === undefined) {
        bucket = new Map();
        this.#data.set(type, bucket);
      }
      for (const [id, value] of Object.entries(entries)) {
        if (value === null || value === undefined) {
          changed = bucket.delete(id) || changed;
        } else {
          bucket.set(id, value);
          changed = true;
        }
      }
    }
    if (changed) {
      await this.#onChange();
    }
  }

  /** Plain-object snapshot for JSON serialization. */
  serialize(): Record<string, Record<string, unknown>> {
    const snapshot: Record<string, Record<string, unknown>> = {};
    for (const [type, bucket] of this.#data) {
      snapshot[type] = Object.fromEntries(bucket);
    }
    return snapshot;
  }
}

/**
 * App-state sync keys must be materialized as typed protobuf objects after a
 * JSON round-trip (mirrors the provider's reference auth state implementation).
 */
function reviveKeyValue(type: string, value: unknown): unknown {
  if (type === "app-state-sync-key" && typeof value === "object" && value !== null) {
    return proto.Message.AppStateSyncKeyData.fromObject(value as { [key: string]: unknown });
  }
  return value;
}

function serializeSession(creds: AuthenticationCreds, keys: SessionKeyStore): Uint8Array {
  const payload: PersistedSession = {
    v: SESSION_FORMAT_VERSION,
    creds,
    keys: keys.serialize(),
  };
  return new TextEncoder().encode(JSON.stringify(payload, BufferJSON.replacer));
}

function parseSessionData(
  data: Uint8Array,
  sessionId: string,
): { creds: AuthenticationCreds; keys: Record<string, Record<string, unknown>> } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(data), BufferJSON.reviver);
  } catch {
    throw new ValidationError(
      `Stored session "${sessionId}" is corrupt and cannot be parsed. Clear the session to log in again.`,
    );
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as PersistedSession).v !== SESSION_FORMAT_VERSION
  ) {
    throw new ValidationError(
      `Stored session "${sessionId}" has an unsupported format. Clear the session to log in again.`,
    );
  }
  const session = parsed as { creds?: unknown; keys?: unknown };
  if (typeof session.creds !== "object" || session.creds === null) {
    throw new ValidationError(
      `Stored session "${sessionId}" is missing credentials. Clear the session to log in again.`,
    );
  }
  const keys =
    typeof session.keys === "object" && session.keys !== null
      ? (session.keys as Record<string, Record<string, unknown>>)
      : {};
  return { creds: session.creds as AuthenticationCreds, keys };
}
