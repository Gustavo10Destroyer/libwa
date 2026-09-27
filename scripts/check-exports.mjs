#!/usr/bin/env node
/**
 * Public API surface guard.
 *
 * Verifies that the published type surface (dist/index.d.ts and everything
 * reachable from it through relative imports) never exposes Baileys:
 *
 *  1. dist/index.d.ts must exist and contain no forbidden provider tokens.
 *  2. The package `exports` map must only expose "." and "./package.json".
 *  3. Every locally-declared file reachable from index.d.ts must not import
 *     the provider module, and its `export` lines must not mention provider
 *     type names (Baileys may only appear in unreachable internal d.ts files,
 *     which the exports map keeps consumers away from).
 *
 * Run after `npm run build`. Exits non-zero with a report on violation.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(root, "dist");
const indexDts = join(distDir, "index.d.ts");

/** Provider tokens that must never appear in the public type surface. */
const FORBIDDEN = [
  "@whiskeysockets/baileys",
  "WAMessage",
  "WASocket",
  "IWebMessageInfo",
  "makeWASocket",
  "proto.",
];

/** Tokens that must not appear on export lines of reachable files. */
const FORBIDDEN_TYPE_NAMES = FORBIDDEN.filter((token) => !token.includes("/"));

const errors = [];

function fail(message) {
  errors.push(message);
}

function rel(filePath) {
  return relative(root, filePath);
}

// --- 1. index.d.ts must exist and be clean ------------------------------------

if (!existsSync(indexDts) || !statSync(indexDts).isFile()) {
  console.error(`check:exports: ${rel(indexDts)} not found — run \`npm run build\` first.`);
  process.exit(1);
}

function readIfExists(filePath) {
  return existsSync(filePath) ? readFileSync(filePath, "utf8") : null;
}

// --- 2. package.json exports map ----------------------------------------------

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const exportKeys = Object.keys(pkg.exports ?? {});
const allowedExportKeys = new Set([".", "./package.json"]);
for (const key of exportKeys) {
  if (!allowedExportKeys.has(key)) {
    fail(
      `package.json exports exposes "${key}" — only "." and "./package.json" are allowed (deep imports would leak internal declarations).`,
    );
  }
}
if (pkg.exports?.["."]?.types !== "./dist/index.d.ts") {
  fail(`package.json exports["."].types must be "./dist/index.d.ts".`);
}

// --- 3. reachable d.ts graph ---------------------------------------------------

/** Extracts relative module specifiers from a d.ts source. */
function relativeSpecifiers(source) {
  const specifiers = [];
  // from "./x.js" / from './x.js'  and  import("./x.js")
  const pattern = /(?:from\s+|import\s*\(\s*)["'](\.[^"']*)["']/g;
  for (const match of source.matchAll(pattern)) {
    specifiers.push(match[1]);
  }
  return specifiers;
}

function resolveSpecifier(fromFile, specifier) {
  // Type resolution maps emitted ".js" specifiers back to ".d.ts" files.
  const base = join(dirname(fromFile), specifier);
  const candidates = [base.replace(/\.js$/, ".d.ts"), `${base}.d.ts`, join(base, "index.d.ts")];
  return candidates.find((candidate) => existsSync(candidate));
}

/** Resolves the export-line spans of a declaration file. */
function exportLines(source) {
  const lines = source.split("\n");
  const spans = [];
  let inBlock = false;
  let blockStart = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (inBlock) {
      if (line.includes("}")) {
        spans.push({ start: blockStart, end: i });
        inBlock = false;
      }
      continue;
    }
    const trimmed = line.trimStart();
    if (/^export\b/.test(trimmed) || /^declare\s+export\b/.test(trimmed)) {
      // Single-line export, or the head of a multi-line `export { ... }` /
      // `export type { ... }` block (possibly `from`-qualified on the tail).
      if (line.includes("{") && !line.includes("}")) {
        inBlock = true;
        blockStart = i;
      } else {
        spans.push({ start: i, end: i });
      }
    }
  }
  return spans;
}

const visited = new Map(); // absolute path -> source
const queue = [indexDts];
while (queue.length > 0) {
  const file = queue.shift();
  if (visited.has(file)) continue;
  const source = readIfExists(file);
  if (source === null) {
    fail(`missing declaration file reachable from index.d.ts: ${rel(file)}`);
    continue;
  }
  visited.set(file, source);
  for (const specifier of relativeSpecifiers(source)) {
    const resolved = resolveSpecifier(file, specifier);
    if (resolved === undefined) {
      fail(`unresolved import "${specifier}" in ${rel(file)}`);
      continue;
    }
    if (!visited.has(resolved)) queue.push(resolved);
  }
}

// 3a. index.d.ts: no forbidden tokens anywhere (it is the whole public surface).
for (const token of FORBIDDEN) {
  if (visited.get(indexDts)?.includes(token)) {
    fail(`dist/index.d.ts mentions "${token}" — provider details leaked into the public API.`);
  }
}

for (const [file, source] of visited) {
  const fileName = rel(file);
  if (file === indexDts) continue; // already scanned in full above

  // 3b. Reachable files must never import the provider module at all: if it is
  // imported, the type graph forces consumers to resolve Baileys declarations.
  if (source.includes("@whiskeysockets/baileys")) {
    fail(
      `${fileName} imports the provider module — Baileys must stay unreachable from the public type surface (keep such declarations internal to src/backend/baileys/).`,
    );
    continue;
  }

  // 3c. Export lines must not mention provider type names.
  const lines = source.split("\n");
  for (const span of exportLines(source)) {
    const text = lines.slice(span.start, span.end + 1).join("\n");
    for (const token of FORBIDDEN_TYPE_NAMES) {
      if (text.includes(token)) {
        fail(
          `${fileName}:${span.start + 1} exports a symbol mentioning "${token}" — provider types must not appear in the public API.`,
        );
      }
    }
  }
}

// --- report ---------------------------------------------------------------------

if (errors.length > 0) {
  console.error(`check:exports: ${errors.length} violation(s):\n`);
  for (const error of errors) {
    console.error(`  - ${error}`);
  }
  process.exit(1);
}

console.log(
  `check:exports: ok — ${visited.size} declaration file(s) reachable from dist/index.d.ts, no provider tokens in the public type surface.`,
);
