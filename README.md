# libwa

> [!WARNING]
> **Beta — vibe-coded project.** This library was created with AI-assisted "vibe coding", is in **beta**, and may contain bugs. APIs can change without notice — pin your versions and please [report issues](https://github.com/Gustavo10Destroyer/libwa/issues).

Interaction-driven WhatsApp bot library for TypeScript/Node.js — a discord.js-like DX on top of a pluggable backend, with [Baileys](https://github.com/WhiskeySockets/Baileys) as the first provider.

```ts
import { Client } from "libwa";

const client = new Client();

client.on("interactionCreate", async (interaction) => {
  if (interaction.isMessage()) await interaction.reply(`You said: ${interaction.text}`);
});

await client.login();
```

- **Interactions, not raw payloads** — messages, commands, reactions, edits/deletes, group changes all arrive as typed interactions with `isMessage()` / `isCommand()` / `isReaction()`-style guards.
- **Provider-agnostic core** — the library core never imports Baileys; providers sit behind the `WhatsAppBackend` contract. Public `.d.ts` files are verified leak-free by `npm run check:exports`.
- **First-class commands** — prefixes, aliases, args, `groupOnly` / `dmOnly`, `client.commands.register()`.
- **LID-aware identity** — WhatsApp's linked ids (`…@lid`) are paired with phone numbers as they arrive; `client.users.resolvePhone(id)` / `client.users.resolveLid(id)` fill the remaining gaps, `client.users.fetch(id)` checks whether an account exists under either id scheme, and `pictureUrl(id)` / `about(id)` / `accountType(id)` pull profile data behind optional backend capabilities.
- **Group context** — group interactions carry `interaction.member` (the author's `role` and `user` inside that group), with `group.members` and `group.member(id)` offering the same group-scoped view.
- **Middleware pipeline** — rate limiting, chat filters, permissions: `client.use((interaction, next) => …)`.
- **Sessions** — opaque, backend-owned session blobs persisted through `SessionStore` (filesystem by default, memory for tests, bring your own).
- **Typed events & errors** — fully inferred listener arguments, a stable `WhatsAppError` hierarchy with machine-readable codes.
- **Strict TypeScript** — `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, zero `any` in the public surface.

## Requirements

- Node.js ≥ 20.0.0 (ESM package; the bundled Baileys provider requires ≥ 20)

```sh
npm install libwa
```

## Quick start

```ts
import { Client } from "libwa";

const client = new Client({
  commands: { prefix: ["!", "/"] },
});

client.on("ready", () => console.log("connected as", client.me?.displayName));
client.on("qr", (qr) => console.log("scan:", qr));
client.on("error", (error) => console.error(error.message));

client.commands.register({
  name: "ping",
  aliases: ["p"],
  description: "Health check",
  execute: (interaction) => {
    void interaction.reply("pong");
  },
});

client.on("interactionCreate", async (interaction) => {
  if (interaction.isCommand()) return;
  if (interaction.isMessage() && interaction.isImage()) {
    await interaction.react("📷");
  }
});

await client.login();
```

`login()` resolves the first time the connection is open. Attach `qr` / `pairingCode` listeners **before** calling it.

### Pairing-code login (no QR scan)

```ts
const client = new Client({ auth: { pairingPhoneNumber: "5511999999999" } });
client.on("pairingCode", (code) => console.log("code:", code));
await client.login();
// or on demand: const code = await client.requestPairingCode("5511999999999");
```

## Interactions

Every message-family backend event (`message`, `messageUpdate`, `reaction`, `groupParticipants`, `groupUpdate`) is normalized into an `Interaction`; `connection` updates become the lifecycle events (`ready`, `qr`, `pairingCode`, `reconnecting`, `disconnect`). Narrow with guards:

| Guard | Interaction | Highlights |
| --- | --- | --- |
| `isMessage()` | `MessageInteraction` | `.text`, `.content`, `.attachments`, `.reference`, `.mentions`, `.reply()`, `.react()` |
| `isCommand()` | `CommandInteraction` | `.name`, `.args`, `.rawArgs`, `.command` (also a message) |
| `isReaction()` | `ReactionInteraction` | `.emoji` (`null` = removed), `.messageId`, `.react()` |
| `isMessageUpdate()` | `MessageUpdateInteraction` | `.action` (`edit` \| `delete`), `.content` |
| `isGroupParticipantUpdate()` | `GroupParticipantInteraction` | `.action`, `.user` / `.users`, `.group` |
| `isGroupUpdate()` | `GroupUpdateInteraction` | `.changes`, `.group` |
| `isButton()` | `ButtonInteraction` | `.buttonId`, `.title`, `.displayText`, `.variant` |
| `isList()` | `ListInteraction` | `.rowId`, `.title`, `.description` |

Every interaction carries `.chat`; when `isFromGroup()` is true it narrows so `.group` is typed `Group` (undefined for direct chats). Group interactions are dispatched against cached group metadata — fetched at most once per minute per group (`client.groups.ensure()`), with membership and metadata events patched into the cache as they arrive — so `.group.members` is current; every interaction exposes `.member`, the author's group-scoped `{ user, role }` (undefined outside groups or when metadata could not be resolved).

Content is a discriminated union (`content.kind`): `text`, `image`, `video`, `audio`, `document`, `sticker`, `location`, `contact`, `poll`, `buttonReply`, `listReply`, `unknown` — plus `isText()` / `isImage()` / … guards that narrow `content` at compile time.

## Sending messages

```ts
await client.messages.send("111@s.whatsapp.net", "plain text");
await client.messages.send(chat, { image: bytes, caption: "look!" });
await message.reply("quoted reply");           // quotes the original
await message.react("👍");                     // message.react(null) removes it
await client.messages.edit(sentMessage, "edited");
await client.messages.delete(sentMessage);
```

Media is plain bytes (`Uint8Array`); incoming attachments expose a lazy `attachment.download()`.

## Commands

```ts
client.commands.registerAll([
  { name: "help", description: "Lists commands", execute: (i) => void i.reply("hi") },
  { name: "members", groupOnly: true, execute: async (i) => { /* … */ } },
  { name: "start", dmOnly: true, execute: async (i) => { /* … */ } },
]);

client.commands.parse("!ping a b", ["!"]); // { name: "ping", args: ["a", "b"], … }
```

- Default prefix: `"!"` (`commands: { prefix: [...] }`, or `commands: false` to disable parsing).
- Prefix matching is **longest-wins**: with `["!", "!!"]`, `!!help` parses as the `!!` command (ties keep the earlier entry).
- `register()` validates the whole definition first — name and alias charset `^[a-z0-9][a-z0-9_-]{0,31}$`, no duplicates, no alias that collides with a live command or another alias — and only then mutates the registry, so a rejected registration leaves it exactly as it was.
- `groupOnly` / `dmOnly` are enforced during dispatch; skipped commands still emit `interactionCreate`.
- Thrown command errors surface on the client's `error` event — which reports nothing until you subscribe to it (see [Events](#events)).

## Middleware

```ts
client.use(async (interaction, next) => {
  if (shouldIgnore(interaction)) return; // stops dispatch
  await next();                          // continues
});
```

Middlewares run in registration order before commands/listeners. Throwing aborts dispatch and reports through `error`. Calling `next()` twice is rejected.

## Events

| Event | Arguments | When |
| --- | --- | --- |
| `ready` | `(client)` | connection opened (first time or after a drop) |
| `interactionCreate` | `(interaction)` | an interaction passed middleware |
| `error` | `(error)` | library/command/listener failure (never re-enters itself) |
| `disconnect` | `(reason)` | terminal disconnect (`DisconnectReason`) |
| `reconnecting` | `(attempt, delayMs)` | retry scheduled |
| `qr` | `(qr)` | QR payload available |
| `pairingCode` | `(code)` | pairing code available |

Reconnection is client-owned: exponential backoff (`reconnect: { attempts, initialDelayMs, maxDelayMs, factor }`), disabled with `reconnect: false`. Fatal reasons (`LoggedOut`, `BadSession`, `ConnectionReplaced`, `Forbidden`) are never retried.

**Nothing is logged by default.** The default logger is a no-op and an event with no listener is simply dropped, so failures routed to `error` (and `qr` / `pairingCode`) stay invisible until you attach a handler:

```ts
client.on("error", (error) => console.error("libwa:", error));
```

## Errors

Everything thrown by the library extends `WhatsAppError` with a stable `code`:

`ConnectionError` · `AuthenticationError` · `MessageError` · `PermissionError` · `NotFoundError` · `BackendError` · `UnsupportedOperationError` · `ValidationError`

Provider errors are wrapped (`rethrowAsBackendError`) so application code never sees a Baileys type. Missing backend capabilities surface as `UnsupportedOperationError`.

## Sessions

```ts
import { Client, FileSessionStore, MemorySessionStore } from "libwa";

new Client({ sessionStore: new FileSessionStore({ directory: ".libwa" }), sessionId: "work" });
```

Sessions are `{ id, provider, data: Uint8Array, updatedAt }` — opaque to everything but the owning backend. Multi-account bots use distinct `sessionId`s on a shared store. `client.logout()` invalidates the provider session and clears the slot; both `logout()` and `destroy()` also reset the entity and group caches, so a re-login — or a second account sharing the store in the same process — can never answer from the previous session's identity data.

## Custom backends

```ts
import type { WhatsAppBackend } from "libwa";

const backend: WhatsAppBackend = {
  id: "my-backend",
  async connect(options) { /* … */ },
  async disconnect() { /* … */ },
  isConnected: () => connected,
  async sendMessage(request) { /* … */ },
  async downloadMedia(request) { /* … */ },
  async getGroupMetadata(chatId) { /* … */ },
  on(event, listener) { /* … */ },
  // optional: react, editMessage, deleteMessage, updateGroupParticipants,
  //           updateGroupName, updateGroupDescription, requestPairingCode, logout,
  //           getPhoneNumberForLid, getLidForPhoneNumber, fetchUser,
  //           getProfilePictureUrl, getAbout, getBusinessProfile
};

new Client({ backend });
```

See `docs/architecture.md` for the contract and `examples/` for runnable patterns.

## Development

```sh
npm run typecheck     # tsc --noEmit (src + tests + examples)
npm test              # vitest (324 tests)
npm run test:watch    # vitest in watch mode
npm run test:coverage # vitest run --coverage
npm run lint          # biome check
npm run lint:fix      # biome check --write .
npm run format        # biome format --write .
npm run build         # node scripts/clean-dist.mjs && tsc -p tsconfig.build.json → dist/
npm run check:exports # public API surface must not leak the provider
npm run verify        # typecheck → test → lint → build → check:exports
```

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — layers, event pipeline, backend contract, session model
- [`docs/design-decisions.md`](docs/design-decisions.md) — why the library is shaped the way it is
- [`examples/`](https://github.com/Gustavo10Destroyer/libwa/tree/main/examples) — basic bot, pairing login, middleware/filters

## License

MIT
