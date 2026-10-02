#!/usr/bin/env node
/**
 * Removes `dist/` before a build so deleted/renamed sources never leave
 * stale artifacts behind (`files: ["dist"]` packs whatever is there).
 */
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

await rm(fileURLToPath(new URL("../dist", import.meta.url)), {
  recursive: true,
  force: true,
});
