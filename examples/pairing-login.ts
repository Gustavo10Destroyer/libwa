/**
 * Pairing-code login: connect with a phone number instead of a QR scan.
 *
 * The bot prints a pairing code; enter it on the phone under
 * WhatsApp > Linked devices > Link a device.
 */
import { Client } from "libwa";

const client = new Client({
  auth: { pairingPhoneNumber: process.env.WA_PHONE_NUMBER ?? "5511999999999" },
  commands: { prefix: "!" },
  // Sessions persist to the default filesystem store in .libwa/.
});

client.on("pairingCode", (code) => {
  console.log(`Pairing code: ${code}`);
});

client.on("qr", (qr) => {
  // Only emitted when no pairing phone number is configured.
  console.log("QR payload:", qr);
});

client.on("ready", () => {
  console.log("Connected as", client.me?.displayName);
});

client.on("error", (error) => {
  console.error("error:", error.message);
});

client.on("reconnecting", (attempt, delayMs) => {
  console.log(`Reconnecting (attempt ${attempt}) in ${delayMs}ms…`);
});

client.commands.register({
  name: "logout",
  description: "Logs the bot out and clears the session",
  async execute(interaction) {
    await interaction.reply("Logging out…");
    await client.logout();
  },
});

async function main(): Promise<void> {
  try {
    await client.login();
  } catch (error) {
    console.error("Login failed:", error);
    process.exit(1);
  }

  // Alternatively request codes manually while connecting:
  // const code = await client.requestPairingCode("5511999999999");
  // console.log("Pairing code:", code);
}

void main();
