import assert from "node:assert/strict";
import { compareSemver, selectAeAiAsset, validateReleaseManifest } from "../../scripts/lib/release-manifest.mjs";

const hash = "a".repeat(64);
const manifest = {
  schema: 1, product: "AE AI", version: "1.2.3", publishedAt: "2026-09-16T00:00:00Z",
  assets: [
    { name: "intel.dmg", kind: "ae-ai-installer", target: "macos-x64", bytes: 10, sha256: hash },
    { name: "arm.dmg", kind: "ae-ai-installer", target: "macos-arm64", bytes: 11, sha256: hash },
    { name: "win.zip", kind: "ae-ai-installer", target: "windows-x64", bytes: 12, sha256: hash },
  ],
};
assert.equal(validateReleaseManifest(manifest), manifest);
assert.equal(selectAeAiAsset(manifest, { platform: "darwin", arch: "x64" }).name, "intel.dmg");
assert.equal(selectAeAiAsset(manifest, { platform: "darwin", arch: "arm64" }).name, "arm.dmg");
assert.equal(selectAeAiAsset(manifest, { platform: "win32", arch: "x64" }).name, "win.zip");
assert.equal(selectAeAiAsset(manifest, { platform: "linux", arch: "x64" }), null);
assert.equal(compareSemver("1.2.4", "1.2.3"), 1);
assert.equal(compareSemver("1.2.3", "1.2.3"), 0);
assert.equal(compareSemver("1.1.9", "1.2.0"), -1);
assert.throws(() => validateReleaseManifest({ ...manifest, schema: 99 }), /unsupported/);
assert.throws(() => validateReleaseManifest({ ...manifest, assets: [{ ...manifest.assets[0], sha256: "bad" }] }), /sha256/);
assert.throws(() => validateReleaseManifest({ ...manifest, assets: [{ ...manifest.assets[0], name: "../evil.dmg" }] }), /unsafe/);
assert.throws(() => validateReleaseManifest({ ...manifest, assets: [{ ...manifest.assets[0], bytes: 2 * 1024 * 1024 * 1024 }] }), /size/);
console.log("release-manifest: 12 assertions passed");
