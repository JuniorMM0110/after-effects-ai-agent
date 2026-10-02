#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildAssetRecord, RELEASE_MANIFEST_SCHEMA, validateReleaseManifest } from "./lib/release-manifest.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.resolve(process.argv[2] || path.join(root, "dist-release"));
const pkg = JSON.parse(fs.readFileSync(path.join(root, "packages", "mcp-server", "package.json"), "utf8"));
const expected = [
  [`AE-AI-${pkg.version}-macOS-Intel.dmg`, "ae-ai-installer", "macos-x64"],
  [`AE-AI-${pkg.version}-macOS-Apple-Silicon.dmg`, "ae-ai-installer", "macos-arm64"],
  [`AE-AI-${pkg.version}-Windows-x64.zip`, "ae-ai-installer", "windows-x64"],
];
const assets = [];
for (const [name, kind, target] of expected) {
  const file = path.join(dist, name);
  if (!fs.existsSync(file)) throw new Error(`Missing release asset required by update manifest: ${file}`);
  assets.push(buildAssetRecord(file, { kind, target }));
}
const manifest = validateReleaseManifest({
  schema: RELEASE_MANIFEST_SCHEMA,
  product: "AE AI",
  version: pkg.version,
  publishedAt: new Date().toISOString(),
  assets,
});
const out = path.join(dist, "ae-ai-release.json");
fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n");
console.log(`Release manifest: ${out}`);
for (const a of assets) console.log(`  ${a.target}: ${a.name} ${a.bytes} bytes ${a.sha256}`);
