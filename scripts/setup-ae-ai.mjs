#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadSetup } from "./lib/setup.mjs";
import { aeAiPaths, codexEnvironment, ensureAeAiDirs } from "./lib/ae-ai-runtime.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const flags = new Set(process.argv.slice(2));
const dev = flags.has("--dev");
const skipPanel = flags.has("--skip-panel");
const skipCodex = flags.has("--skip-codex-install");
const forceCodex = flags.has("--force-codex");

if (process.platform !== "darwin") {
  console.error("AE AI setup v1 currently targets macOS. Windows will use the same runtime paths later.");
  process.exit(1);
}

const paths = ensureAeAiDirs(aeAiPaths());
const setup = await loadSetup();

console.log("AE AI setup — macOS\n");
console.log(`Data:  ${paths.root}`);
console.log(`Codex: ${paths.codexBinary}`);

function systemCodex() {
  try {
    return execFileSync("/bin/zsh", ["-lc", "command -v codex"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function provisionDevCodex() {
  if (fs.existsSync(paths.codexBinary) && !forceCodex) return;
  const found = systemCodex();
  if (!found) throw new Error("Codex is not installed on this development Mac.");
  fs.rmSync(paths.codexBinary, { force: true });
  fs.symlinkSync(fs.realpathSync(found), paths.codexBinary);
  console.log(`Linked development Codex: ${fs.realpathSync(found)}`);
}

function mcpCommand() {
  if (!dev && fs.existsSync(paths.mcpBinary)) return [paths.mcpBinary];
  if (dev) {
    const server = path.join(root, "packages", "mcp-server", "dist", "index.js");
    if (!fs.existsSync(server)) throw new Error("MCP build missing. Run npm run build:ts first.");
    return [process.execPath, server];
  }
  throw new Error(`Packaged MCP binary missing at ${paths.mcpBinary}.`);
}

function toml(value) {
  return JSON.stringify(String(value));
}

function writeManagedCodexConfig(command) {
  const config = [
    "# Managed by AE AI. User authentication is stored separately by Codex.",
    "[mcp_servers.after-effects]",
    `command = ${toml(command[0])}`,
    `args = [${command.slice(1).map(toml).join(", ")}]`,
    'default_tools_approval_mode = "approve"',
    "",
  ].join("\n");
  fs.writeFileSync(path.join(paths.codexHome, "config.toml"), config, "utf8");
}

if (!skipCodex && dev) provisionDevCodex();
if (!fs.existsSync(paths.codexBinary)) {
  throw new Error(`AE AI Codex runtime is missing at ${paths.codexBinary}.`);
}
const command = mcpCommand();
writeManagedCodexConfig(command);
console.log(`MCP:   ${command.join(" ")}`);

if (!skipPanel) {
  if (await setup.isAfterEffectsRunning()) {
    console.log("Panel: deferred because After Effects is running; no live panel files were touched.");
  } else {
    const result = await setup.installPanel({ enableDebugMode: true });
    for (const line of result.actions) console.log(line);
  }
}

console.log("\nAE AI runtime prepared.");
console.log("Next user step: open AE AI. If this computer already has an active ChatGPT/Codex session, AE AI will reuse it automatically; otherwise choose Connect once.");
