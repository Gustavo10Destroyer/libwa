/**
 * Middleware and filters: rate limiting, group-only handling and reactions.
 */
import {
  Client,
  DisconnectReason,
  MessageError,
  type Middleware,
  NotFoundError,
  PermissionError,
} from "libwa";

const client = new Client({
  commands: { prefix: "!", ignoreSelf: true },
});

// --- rate limiting -------------------------------------------------------------

const lastSeen = new Map<string, number>();
const RATE_LIMIT_MS = 2_000;

const rateLimit: Middleware = async (interaction, next) => {
  const key = `${interaction.chat.id}:${interaction.author?.id ?? "unknown"}`;
  const now = Date.now();
  const previous = lastSeen.get(key) ?? 0;
  if (now - previous < RATE_LIMIT_MS) {
    return; // drop the interaction: no listeners, no commands
  }
  lastSeen.set(key, now);
  await next();
};

// --- ignore selected chats ---------------------------------------------------------

const IGNORED_CHATS = new Set(["status@broadcast"]);
const ignoreChats: Middleware = (interaction, next) => {
  if (IGNORED_CHATS.has(interaction.chat.id)) {
    return;
  }
  return next();
};

client.use(rateLimit).use(ignoreChats);

// --- interactions -------------------------------------------------------------------

client.on("interactionCreate", async (interaction) => {
  if (interaction.isMessage() && interaction.isImage()) {
    await interaction.react("📷");
    await interaction.reply("Nice photo!");
    return;
  }

  if (interaction.isReaction()) {
    console.log(
      `${interaction.author?.displayName ?? "someone"} reacted with ${interaction.emoji ?? "∅"}`,
    );
    return;
  }

  if (interaction.isGroupParticipantUpdate()) {
    if (interaction.action === "add") {
      await interaction.reply(
        `Welcome ${interaction.users.map((user) => user.displayName).join(", ")}!`,
      );
    }
    return;
  }

  if (interaction.isCommand() && interaction.name === "whoami") {
    await interaction.reply(
      `You are ${interaction.author.displayName} (${interaction.author.phone ?? "no phone"})`,
    );
  }
});

// --- error handling -------------------------------------------------------------------

client.on("error", (error) => {
  if (error instanceof PermissionError) {
    console.warn("Missing permissions:", error.message);
    return;
  }
  if (error instanceof NotFoundError) {
    console.warn("Not found:", error.message);
    return;
  }
  if (error instanceof MessageError) {
    console.warn("Message failed:", error.message);
    return;
  }
  console.error("unexpected error:", error);
});

client.on("disconnect", (reason) => {
  if (reason === DisconnectReason.LoggedOut) {
    console.error("Session revoked — delete .libwa/ and log in again.");
  }
});

void client.login();
