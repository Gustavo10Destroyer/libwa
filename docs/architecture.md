# Architecture

libwa is organized as a small core with a hard boundary around provider code.

```
┌─────────────────────────────────────────────────────────────┐
│ Application (your bot)                                      │
│   client.on("interactionCreate") · commands · middleware    │
├─────────────────────────────────────────────────────────────┤
│ Core (provider-free)                                        │
│   Client · InteractionFactory · CommandRegistry             │
│   MessageService · GroupService · EntityFactory             │
│   TypedEventEmitter · errors · content · sessions           │
├─────────────────────────────────────────────────────────────┤
│ Backend contract (WhatsAppBackend + BackendEventMap)        │
├─────────────────────────────────────────────────────────────┤
│ src/backend/baileys/  ← the only directory that may import  │
│   BaileysBackend · BaileysMapper · BaileysAuth              │
│   BaileysDisconnect · BaileysLogger     @whiskeysockets/…   │
└─────────────────────────────────────────────────────────────┘
```

## Layers

### Client

`src/Client.ts` is the composition root and the only owner of connection lifecycle:

- Resolves options (`ClientOptions` → defaults) and constructs services.
- Subscribes to the six normalized backend events exactly once per instance.
- Converts backend events into interactions (`InteractionFactory`) — after making the group's metadata cache usable via `groups.ensure()` (fetched at most once per 60s per group; membership and metadata events are applied to the cache while building the interaction) — so interactions carry current members and `interaction.member` can answer with the author's role; runs the middleware chain, then dispatches to commands and `interactionCreate` listeners.
- Owns **reconnection policy** (backoff, attempt counting, fatal-reason classification). Backends only report *why* a connection closed.
- Owns **login bookkeeping**: `login()` returns a deferred promise resolved on first `ready`, rejected on fatal/auth failure or when retries are exhausted.

### Services

| Service | Responsibility |
| --- | --- |
| `MessageService` (`client.messages`) | Validates/normalizes `ReplyContent`, resolves send targets, delegates to the backend, converts confirmations back into domain `Message`s. React/edit/delete with capability checks. |
| `GroupService` (`client.groups`) | Metadata reads — `fetch` always round-trips, `ensure` serves a ≤60s cache (fetch-on-miss, deduped, backs off after failures) — plus member/setting operations, keeping cached group metadata in sync. |
| `CommandRegistry` (`client.commands`) | Registration/aliases/uniqueness + prefix parsing. Data only; execution happens in the dispatch pipeline. |
| `UserService` (`client.users`) | Phone number ↔ linked id (`@lid`) resolution (recorded id pairs answer instantly, `getPhoneNumberForLid`/`getLidForPhoneNumber` fill the gaps), `fetch(id)` — existence check with name under either id scheme, resolved to phone digits — and profile enrichment: `pictureUrl(id, type?)`, `about(id)` and `accountType(id)`, each behind its own optional capability. |

### Entities

Value objects built by `EntityFactory`:

- `Chat` / `Group` (one file, `Group extends Chat`; `isGroup()` is a narrowing guard), `User`, `Message`.
- Chats and group metadata are **cached by id** so identity is stable across events (`interaction.message.chat === interaction.chat`); users are cheap and recreated.
- **Display names are remembered.** Every push name (and provider-supplied lookup name) is stored under both id schemes, so later id-only payloads — mentions, reactions, group members, fetch results — still carry `user.name`.
- **Group membership is group-scoped.** `Group.members` returns `GroupMember`s (`{ user, role }`) and `Group.member(id | user)` looks one account up across both id schemes — roles never leak onto the account-level `User`. Membership events (`applyGroupParticipants`) and metadata diffs (`applyGroupChanges`) patch the cached metadata in place, so a participant list stays current without a refetch.
- Entities expose intent-level actions (`chat.send`, `message.react`, `group.addMembers`) that delegate back to services — never to a provider.

### Interactions

`Interaction` (abstract) carries `id`, `timestamp`, `chat`, `author`, `member` (the author's `GroupMember` in `group`, when applicable), `isFromMe` plus `reply()` and the guard family. Concrete subclasses add event-specific data (`CommandInteraction.args`, `ReactionInteraction.emoji`, …). The discriminator (`InteractionType`) and class hierarchy are kept in sync: `CommandInteraction extends MessageInteraction`, so `isMessage()` is true for commands too.

`GroupUpdateInteraction.changes` is a **diff**, not a snapshot: only fields the provider actually changed are present, so `"name" in changes` is the reliable "did this change?" test. A cleared group description is a present `description` key with an `undefined` value — `"description" in changes` is true and `changes.description === undefined` means "cleared", not "unknown".

## Event pipeline

```
provider event (Baileys)
   │  BaileysBackend: generation guards, history filtering, raw-message LRU
   ▼
BaileysMapper: provider payload → BackendEventMap payload (or null)
   ▼
WhatsAppBackend "message" | "messageUpdate" | "reaction"
              | "groupParticipants" | "groupUpdate" | "connection"
   ▼
Client subscriptions (#subscribeBackend, once per instance)
   ▼
InteractionFactory: domain event → Interaction (command parsing happens here)
   ▼
runMiddlewareChain: ordered middlewares, may stop dispatch
   ▼
command.execute()  →  interactionCreate listeners   (errors → "error" event)
```

Key properties:

- **Nothing provider-shaped crosses the boundary.** Mappers normalize wrappers (ephemeral/view-once/device-sent/edit), timestamps (seconds/Long → `Date`), jids (device suffix stripping), and every content type into the `MessageContent` union.
- **Null means "no event."** Protocol/reaction/poll-update payloads, sender-key-distribution-only stanzas and history sync upserts never surface — and plumbing keys never shadow real content, so the first message in a group (which carries the distribution alongside its text) still arrives.
- **Media stays lazy.** Mappers attach `download()` closures that fetch bytes through the backend's raw-message cache; applications only see `Uint8Array`s.
- **Identity duality is preserved.** Message keys, group metadata participants and membership events carry LID ↔ phone-number pairs (`idPairs`, `GroupParticipant.altId`); the factory records them so `client.users` can resolve phone numbers for linked ids (see https://baileys.wiki/concepts/jids).

## Backend contract

`WhatsAppBackend` (`src/backend/Backend.ts`) = mandatory lifecycle + I/O:

```ts
connect(options) · disconnect() · isConnected()
sendMessage(request) · downloadMedia(request) · getGroupMetadata(chatId)
on(event, listener) → Unsubscribe
```

plus **optional capabilities** (`react?`, `editMessage?`, `deleteMessage?`, `updateGroupParticipants?`, `updateGroupName?`, `updateGroupDescription?`, `requestPairingCode?`, `logout?`, `getPhoneNumberForLid?`, `getLidForPhoneNumber?`, `fetchUser?`, `getProfilePictureUrl?`, `getAbout?`, `getBusinessProfile?`). The core checks for the method before calling and raises `UnsupportedOperationError` when absent — capability discovery stays honest instead of pretending every provider can do everything.

`BackendConnectOptions` is the backend's lifeline into infrastructure: `sessionId`, `sessionStore`, `logger`, `pairingPhoneNumber`. Backends persist **only** through the store they are given.

Normalized events (`BackendEventMap`) use domain types exclusively (`ChatId`, `MessageContent`, `GroupParticipantAction`, `DisconnectReason`, …).

### Baileys adapter (`src/backend/baileys/`)

| File | Role |
| --- | --- |
| `BaileysBackend.ts` | Socket lifecycle, event wiring, send/react/edit/delete/group ops, pairing, profile enrichment (picture/about/business), raw-message LRU cache, provider-content conversion. Module-private class exposed via `createBaileysBackend()`. |
| `BaileysMapper.ts` | Pure functions: `mapIncomingMessage`, `mapMessageUpdates`, `mapMessagesDelete`, `mapReaction`, `mapGroupParticipants`, `mapGroupUpdates`, `mapGroupMetadata`. |
| `BaileysAuth.ts` | `AuthenticationState` backed by a `SessionStore`; coalesced write chain; `BufferJSON` serialization; app-state key revival. |
| `BaileysDisconnect.ts` | Boom/status-code → `DisconnectReason` mapping (incl. network errnos). |
| `BaileysLogger.ts` | Adapts the library `Logger` to the provider's logging shape. |

History sync is off by default (`syncFullHistory: false`, `shouldSyncHistoryMessage: () => false`, `emitOwnEvents: false`): the library dispatches only `messages.upsert` entries with `type === "notify"`.

## Sessions

```
Session { id, provider, data: Uint8Array, updatedAt }
```

- The core treats `data` as an opaque blob; only the owning backend interprets it (Baileys: `{ v, creds, keys }` JSON via `BufferJSON`).
- Provider mismatch (blob written by another backend id) → warn + fresh creds; corrupt/unsupported blobs → `ValidationError` (fail fast, clear session to recover).
- Writes are **coalesced**: bursts of key updates collapse into one store write; `flush()` drains the chain (used on disconnect).
- Stores: `FileSessionStore` (atomic temp+rename, per-slot write queue, id validation) and `MemorySessionStore`.

## Reconnection (client-owned)

- Backend emits `connection: close` with a mapped `DisconnectReason` (+ detail string).
- Client decides: fatal reasons (`LoggedOut`, `BadSession`, `ConnectionReplaced`, `Forbidden`) and exhausted attempts → `disconnect` event (+ `error` when retries were configured); otherwise exponential backoff and a fresh `connect()` call on the same backend instance.
- `destroy()` is terminal (listeners detached, timer cancelled, `login()` rejected); `logout()` clears the session slot for a clean re-pairing.

## Error model

`WhatsAppError` (`.code`, optional `.cause`) → the eight subclasses. Rules:

- Services wrap unknown provider failures with `rethrowAsBackendError` (`WhatsAppError`s pass through untouched).
- Listener/command/middleware failures are routed to the `error` event — dispatch continues, the process never crashes. Nothing is logged unless you supply a logger **and** attach an `error` listener; both default to silent.
- An `error` listener that itself throws is logged, never re-emitted (no recursion).

## Public surface discipline

- `src/index.ts` is the entire public API; package `exports` exposes only `.` (plus `./package.json`), so deep imports into `dist/` are **not part of the supported API** — exports-aware resolvers reject them outright, while legacy `moduleResolution: "node"` can still reach `dist/` on disk. Nothing below the barrel is stable.
- `npm run check:exports` builds a reachability graph from `dist/index.d.ts` and fails if any reachable declaration mentions the provider (`@whiskeysockets/baileys`, `WAMessage`, `WASocket`, `proto.`, …). Unreachable internal `.d.ts` files may reference provider types; consumers can never see them.
- Tests import from `src/…` paths (never from the barrel for internals) and use a `MockBackend` for everything provider-free; Baileys behavior is unit-tested at the mapper/auth/disconnect level with realistic provider fixtures.
