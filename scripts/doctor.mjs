#!/usr/bin/env node
// Same diagnosis the check_setup tool performs, printed for a human.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadSetup } from "./lib/setup.mjs";

const { checkSetup } = await loadSetup();
const report = await checkSetup();

console.log("AE MCP doctor\n");

const major = parseInt(process.versions.node.split(".")[0], 10);
line(major >= 22, "Node >= 22", `v${process.versions.node}`, "Upgrade to Node 22 or newer.");

for (const c of report.checks) {
  line(c.ok, c.name, c.detail, c.fix);
}

// Build artefacts are a developer concern, so they live here rather than in the
// shared check used by the MCP tool.
const bundle = path.resolve("packages/ae-panel/jsx/bundle.jsx");
line(fs.existsSync(bundle), "bundle.jsx built", bundle, "Run `npm run build:jsx`.");
const dist = path.resolve("packages/mcp-server/dist/index.js");
line(fs.existsSync(dist), "MCP server built", dist, "Run `npm run build`.");

// AE AI runs a compiled copy from its own data directory, not dist/index.js.
// In a development checkout, compare that binary's timestamp with the source
// trees that feed it so doctor cannot say "All green" while Codex is actually
// launching an older server. Release users have no checkout source and simply
// skip this developer-only freshness check.
const aeAiBinary = process.platform === "win32"
  ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "AE AI", "bin", "after-effects-mcp.exe")
  : path.join(os.homedir(), "Library", "Application Support", "AE AI", "bin", "after-effects-mcp");
const sourceRoots = [path.resolve("packages/mcp-server/src"), path.resolve("packages/shared/src")];
const newestSource = Math.max(...sourceRoots.map(newestMtime));
const runtimePresent = fs.existsSync(aeAiBinary);
const runtimeCurrent = !runtimePresent || fs.statSync(aeAiBinary).mtimeMs >= newestSource;
line(
  runtimeCurrent,
  "AE AI MCP runtime current",
  runtimePresent ? `${aeAiBinary}${runtimeCurrent ? "" : " (older than current source)"}` : "not installed in the default AE AI location",
  `Rebuild the current platform target and reinstall/copy it to ${aeAiBinary}.`
);

if (report.nextSteps.length > 0) {
  console.log("\nNext steps:");
  for (const s of report.nextSteps) console.log(`  - ${s}`);
}

const allOk = report.ready && fs.existsSync(bundle) && fs.existsSync(dist) && major >= 22 && runtimeCurrent;
console.log("\n" + (allOk ? "All green." : "Some checks failed."));
process.exit(allOk ? 0 : 1);

function newestMtime(root) {
  if (!fs.existsSync(root)) return 0;
  let newest = fs.statSync(root).mtimeMs;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(full) : fs.statSync(full).mtimeMs);
  }
  return newest;
}

function line(ok, name, detail, fix) {
  console.log(`  [${ok ? "OK  " : "FAIL"}] ${name}: ${detail}`);
  if (!ok && fix) console.log(`         ${fix}`);
}
