import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const RELEASE_MANIFEST_SCHEMA = 1;

export function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export function compareSemver(a, b) {
  const parse = (v) => String(v || "").replace(/^v/, "").split("-")[0].split(".").map((n) => Number(n));
  const aa = parse(a), bb = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (aa[i] || 0) - (bb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

export function selectAeAiAsset(manifest, { platform, arch }) {
  validateReleaseManifest(manifest);
  const wanted = platform === "darwin"
    ? (arch === "arm64" ? "macos-arm64" : arch === "x64" ? "macos-x64" : null)
    : platform === "win32" && arch === "x64" ? "windows-x64" : null;
  if (!wanted) return null;
  return manifest.assets.find((a) => a.kind === "ae-ai-installer" && a.target === wanted) || null;
}

export function validateReleaseManifest(value) {
  if (!value || typeof value !== "object") throw new Error("release manifest must be an object");
  if (value.schema !== RELEASE_MANIFEST_SCHEMA) throw new Error(`unsupported release manifest schema ${value.schema}`);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(value.version || ""))) throw new Error("release manifest has an invalid version");
  if (!Array.isArray(value.assets)) throw new Error("release manifest assets must be an array");
  const names = new Set();
  for (const asset of value.assets) {
    if (!asset || typeof asset !== "object") throw new Error("release asset must be an object");
    if (!asset.name || names.has(asset.name)) throw new Error(`duplicate or empty release asset name: ${asset.name || "(empty)"}`);
    if (path.basename(asset.name) !== asset.name || /[\\/]/.test(asset.name)) throw new Error(`unsafe release asset name: ${asset.name}`);
    names.add(asset.name);
    if (!/^[a-f0-9]{64}$/.test(String(asset.sha256 || ""))) throw new Error(`invalid sha256 for ${asset.name}`);
    if (!Number.isSafeInteger(asset.bytes) || asset.bytes <= 0 || asset.bytes > 1024 * 1024 * 1024) throw new Error(`invalid size for ${asset.name}`);
    if (!asset.kind || !asset.target) throw new Error(`missing kind/target for ${asset.name}`);
  }
  return value;
}

export function buildAssetRecord(file, { kind, target }) {
  const stat = fs.statSync(file);
  return { name: path.basename(file), kind, target, bytes: stat.size, sha256: sha256File(file) };
}
