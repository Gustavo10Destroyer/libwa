/**
 * Basic bot: replies to messages, exposes a command, reacts to mentions.
 *
 * Run with any TS runner that understands the package exports, e.g.:
 *   npx tsx examples/basic-bot.ts
 */
import { Client, type Interaction, type Logger } from "libwa";

const logger: Logger = {
  debug: (...args) => console.debug("[debug]", ...args),
  info: (...args) => console.info("[info]", ...args),
  warn: (...args) => console.warn("[warn]", ...args),
  error: (...args) => console.error("[error]", ...args),
};

const client = new Client({
  logger,
  commands: { prefix: ["!", "/"] },
  reconnect: { attempts: 5, initialDelayMs: 1000 },
});

client.on("ready", () => {
  console.log(`Logged in as ${client.me?.displayName ?? "unknown"} (${client.sessionId})`);
});

client.on("qr", (qr) => {
  console.log("Scan this QR with WhatsApp:\n", qr);
});

client.on("interactionCreate", (interaction: Interaction) => {
  if (interaction.isCommand()) {
    // Commands are handled by their definitions (see below).
    return;
  }
  if (!interaction.isMessage() || !interaction.isText()) {
    return;
  }
  if (interaction.isFromMe) {
    return;
  }
  void interaction.reply(`You said: ${interaction.text}`);
});

client.on("error", (error) => {
  console.error("libwa error:", error.message);
});

client.on("disconnect", (reason) => {
  console.warn(`Disconnected (${reason}). Restart the bot to log in again.`);
});

client.commands.registerAll([
  {
    name: "ping",
    description: "Health check",
    aliases: ["p"],
    execute: (interaction) => {
      void interaction.reply("pong");
    },
  },
  {
    name: "echo",
    description: "Repeats the given text",
    groupOnly: false,
    execute: (interaction) => {
      const text = interaction.rawArgs.length > 0 ? interaction.rawArgs : "…nothing to echo.";
      void interaction.reply(text);
    },
  },
  {
    name: "members",
    description: "Shows the group member count (groups only)",
    groupOnly: true,
    async execute(interaction) {
      if (!interaction.isFromGroup()) {
        return;
      }
      const group = await interaction.chat.client.groups.fetch(interaction.chat.id);
      await interaction.reply(`This group has ${group.memberCount ?? "?"} members.`);
    },
  },
]);

async function main(): Promise<void> {
  await client.login();
}

process.on("SIGINT", () => {
  void client.destroy().then(() => process.exit(0));
});

void main().catch((error: unknown) => {
  console.error("Failed to start:", error);
  process.exit(1);
});
