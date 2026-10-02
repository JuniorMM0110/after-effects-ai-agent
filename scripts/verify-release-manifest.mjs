#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256File, validateReleaseManifest } from "./lib/release-manifest.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.resolve(process.argv[2] || path.join(root, "dist-release"));
const file = path.join(dist, "ae-ai-release.json");
const manifest = validateReleaseManifest(JSON.parse(fs.readFileSync(file, "utf8")));
for (const asset of manifest.assets) {
  const assetPath = path.join(dist, asset.name);
  if (!fs.existsSync(assetPath)) throw new Error(`Manifest asset is missing: ${assetPath}`);
  const stat = fs.statSync(assetPath);
  if (stat.size !== asset.bytes) throw new Error(`Size mismatch for ${asset.name}: manifest ${asset.bytes}, disk ${stat.size}`);
  const digest = sha256File(assetPath);
  if (digest !== asset.sha256) throw new Error(`SHA-256 mismatch for ${asset.name}: manifest ${asset.sha256}, disk ${digest}`);
}
console.log(`Verified AE AI release ${manifest.version}: ${manifest.assets.length} installer assets match size + SHA-256.`);
