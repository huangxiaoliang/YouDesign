#!/usr/bin/env node
/**
 * Prepare Next standalone output for the Electron desktop package.
 *
 * Next writes the minimal server into .next/standalone, but public/ and
 * .next/static must be copied manually for self-hosted deployments.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const standalone = path.join(root, ".next", "standalone");
const staticSrc = path.join(root, ".next", "static");
const staticDest = path.join(standalone, ".next", "static");
const publicSrc = path.join(root, "public");
const publicDest = path.join(standalone, "public");
const sensitiveStandaloneEntries = ["data", "tmp", "vendor", "dist-desktop"];

if (!existsSync(path.join(standalone, "server.js"))) {
  throw new Error("Missing .next/standalone/server.js. Run `npm run build` first.");
}

mkdirSync(path.dirname(staticDest), { recursive: true });
cpSync(staticSrc, staticDest, { recursive: true, force: true });
if (existsSync(publicSrc)) {
  cpSync(publicSrc, publicDest, { recursive: true, force: true });
}

for (const entry of sensitiveStandaloneEntries) {
  rmSync(path.join(standalone, entry), { recursive: true, force: true });
}
for (const entry of readdirSync(standalone)) {
  if (entry.startsWith(".env")) {
    rmSync(path.join(standalone, entry), { recursive: true, force: true });
  }
}

console.log("Prepared desktop standalone assets:");
console.log(`- ${path.relative(root, staticDest)}`);
console.log(`- ${path.relative(root, publicDest)}`);
for (const entry of sensitiveStandaloneEntries) {
  console.log(`- removed ${path.relative(root, path.join(standalone, entry))}`);
}
