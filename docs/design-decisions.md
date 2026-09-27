# Design decisions

Short ADR-style notes on why libwa is shaped the way it is. Each entry: context → decision → consequence.

## 1. Interactions over raw messages

**Context.** Baileys' `WAMessage` graph (wrappers, `contextInfo`, stub types, protocol messages) is hostile application-facing API. discord.js-style bots want "a message arrived" as one object.

**Decision.** Everything the user handles is an `Interaction` built by a single factory. Raw provider payloads never appear in any public type.

**Consequence.** The mapper is the highest-value, most-tested code (fixtures per content kind, wrapper, stub). New providers cost a new mapper, not new application code.

## 2. Type guards + class hierarchy instead of instanceof chains

**Context.** ESM circular imports make `instanceof` across the interaction graph fragile; consumers should discover variants fluently.

**Decision.** An `InteractionType` discriminator backs every guard (`isMessage()`, `isCommand()`, …), while the class hierarchy (`CommandInteraction extends MessageInteraction`) makes the guards *sound*: `isMessage()` is true for commands, and guards narrow `this` exactly like `if` on a discriminant would.

**Consequence.** `interaction.isCommand()` after `isMessage()` composes without casts; `instanceof` still works, but nothing depends on it.

## 3. Provider behind an interface, with *optional* capabilities

**Context.** Providers differ (reactions yes/no, pairing codes, edits). Making the interface mandatory would lie; making everything optional would cripple DX.

**Decision.** Lifecycle + send/download/metadata + events are mandatory. Everything else is optional on `WhatsAppBackend`; the core checks before calling and raises `UnsupportedOperationError` with the backend id.

**Consequence.** `if (backend.react)` capability discovery, honest errors, and a contract small enough to reimplement in ~200 lines (see `MockBackend` in tests).

## 4. Normalized content union with `T | undefined` fields

**Context.** Provider messages carry dozens of half-present fields; handlers want stable shapes.

**Decision.** One discriminated `MessageContent` union. Every optional field is normalized to `field: T | undefined` (explicitly required, not `?`) and captions default to `""` — so `content.caption` never throws under `exactOptionalPropertyTypes`.

**Consequence.** Exhaustive `switch (content.kind)` compiles; unknown payloads become `kind: "unknown"` instead of vanishing.

## 5. Client owns reconnection, backend owns reason mapping

**Context.** Retry loops inside providers duplicate policy; Baileys close codes are provider-specific.

**Decision.** Backends emit `close` + mapped `DisconnectReason` (+ detail). The client runs backoff, attempt counting, and the fatal set (`LoggedOut`, `BadSession`, `ConnectionReplaced`, `Forbidden`). `destroy()` is terminal; reconnect reuses the same backend instance.

**Consequence.** One place to test policy (fake timers, exhaust/fatal/disabled paths); backends stay dumb about retries.

## 6. Opaque session blobs, coalesced persistence

**Context.** Auth state (creds + signal keys) is provider-owned; Baileys updates can arrive in bursts.

**Decision.** `Session { id, provider, data: Uint8Array }` is opaque to the core. Baileys serializes `{ v, creds, keys }` via `BufferJSON`, revives app-state keys as protobuf objects on read, and coalesces writes (a `scheduled` flag + promise chain) so N key updates → 1 store write; `flush()` drains on disconnect. Provider mismatch → warn + fresh creds; corrupt/unsupported version → `ValidationError`.

**Consequence.** Applications plug in Redis/SQL stores without understanding auth; file/memory stores share one atomic-write story.

## 7. History sync off by default

**Context.** Full history sync is expensive and mostly unwanted; replaying old messages breaks "message received" semantics.

**Decision.** `syncFullHistory: false`, `shouldSyncHistoryMessage: () => false`, `emitOwnEvents: false`, and the backend dispatches only `messages.upsert` with `type === "notify"`.

**Consequence.** Bots respond to live traffic; no deluge on first login. Providers keep the door open for opt-in history later.

## 8. Reconnect the *same* backend instance

**Decision.** `connect()` may be called again on the same backend; backends tear down their previous socket on re-entry (generation counter + suppression flags guard late events from a dead socket).

**Consequence.** No backend re-instantiation bugs mid-reconnect; stale provider events can never dispatch into the client.

## 9. Typed events with a structural constraint

**Context.** `EventEmitter` is untyped; interfaces lack index signatures (so `Record<string, …>` constraints reject `ClientEvents`).

**Decision.** `TypedEventEmitter<Map>` with `EventMapConstraint<Map> = Record<keyof Map, readonly unknown[]>`, listeners typed `(...args: Map[Key]) => void | Promise<void>`, async listener failures routed to an `onListenerError` hook. `listenersOf()` powers ordered pipeline dispatch.

**Consequence.** `client.on("reconnecting", (attempt, delayMs) => …)` infers everything; a throwing listener degrades to an `error` event, never a crash.

## 10. Errors: one root, wrapping discipline

**Decision.** Everything extends `WhatsAppError` (`.code`, `.cause`). Services wrap unknown failures via `rethrowAsBackendError` so `WhatsAppError`s pass through and provider errors become `BackendError`. The `error` event never re-enters itself (an `error` listener failure is logged).

**Consequence.** `catch (e) { if (e instanceof NotFoundError) … }` is stable across providers; error events are safe to leave unguarded.

## 11. Entities cache identity, users don't

**Decision.** `EntityFactory` caches chats/groups (and group metadata) by id so `interaction.chat === interaction.message.chat` and group state accumulates; `User` is a value object recreated per event.

**Consequence.** Stable references for UI/identity comparisons without a global identity map that never evicts.

## 12. Dispatch order: middleware → command → listeners

**Decision.** Middlewares gate everything (skip `next()` = silence); a matched command executes first, then `interactionCreate` listeners run. `groupOnly`/`dmOnly` are enforced here, so a skipped command still notifies listeners.

**Consequence.** Rate-limiting/filtering middleware covers commands *and* plain messages; listeners always observe what happened.

## 13. Media as bytes + lazy downloads

**Decision.** Outbound media is `Uint8Array` (+ optional mimetype); inbound attachments expose `download(): Promise<Uint8Array>` backed by the backend's raw-message cache (quoted messages are cached synthetically too).

**Consequence.** No file-system coupling or provider handles in the API; tests inject bytes directly.

## 14. Legacy buttons/lists map to dedicated interactions

**Decision.** `buttonsResponseMessage` / `templateButtonReplyMessage` / `nativeFlowResponseMessage` → `ButtonInteraction` (button id from `paramsJson.id`, fallback to flow name; prompt title recovered from the quoted message); `listResponseMessage` → `ListInteraction`.

**Consequence.** Three provider formats, one guard (`isButton()`/`isList()`), stable fields for handlers.

## 15. Leaks are a build failure

**Decision.** Baileys may be imported only under `src/backend/baileys/`; `npm run check:exports` walks the reachable graph of `dist/index.d.ts` and fails the build on provider tokens (module specifiers anywhere, type names on export lines). Package `exports` exposes only the root entry.

**Consequence.** "No provider types in the public API" is enforced mechanically, not by review.

## 16. Repo hygiene choices

- **`noExplicitAny` / `noNonNullAssertion` as lint errors** — casts must be intentional (`as unknown as …` in tests only).
- **`exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`** — optionals in public API are written `field: T | undefined`.
- **Biome over ESLint+Prettier** — one fast tool; 2-space formatting is authoritative (legacy tabs were normalized).
- **tsconfig split** — the base config typechecks `src`+`tests`+`examples` (no emit); `tsconfig.build.json` adds `rootDir: src`, declarations and sourcemaps for `dist/`.
- **Examples import `"libwa"`** (mapped to `src/index.ts` via `paths`) so they compile exactly like consumer code, while tests import `src/…` to reach internals.
