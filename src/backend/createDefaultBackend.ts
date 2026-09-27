import type { WhatsAppBackend } from "./Backend.js";
import { createBaileysBackend } from "./baileys/index.js";

/**
 * Creates the library's default backend.
 *
 * This is the only place outside `src/backend/baileys/` that references the
 * provider factory, keeping the core free of provider imports.
 */
export function createDefaultBackend(): WhatsAppBackend {
  return createBaileysBackend();
}
