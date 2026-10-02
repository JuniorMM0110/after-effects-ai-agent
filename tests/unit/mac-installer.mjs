import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderInstaller } from "../../scripts/build-mac-installer.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const template = fs.readFileSync(path.join(root, "scripts", "macos", "Instalar AE AI.command"), "utf8");
const uninstaller = fs.readFileSync(path.join(root, "scripts", "macos", "Desinstalar AE AI.command"), "utf8");

const intel = renderInstaller(template, "9.8.7", "x64");
assert.match(intel, /VERSION="9\.8\.7"/);
assert.match(intel, /EXPECTED_ARCH="x86_64"/);
assert.match(intel, /ARCH_LABEL="Intel"/);
assert.doesNotMatch(intel, /__VERSION__|__ARCH__|__ARCH_LABEL__/);
assert.match(intel, /chatgpt\.com\/codex\/install\.sh/);
assert.match(intel, /CODEX_HOME_DIR="\$APP_ROOT\/codex"/);
assert.match(intel, /codex-code-mode-host/);
assert.match(intel, /CODEX_HOST_BIN/);
assert.match(intel, /mcp_servers\.after-effects/);
assert.match(intel, /PlayerDebugMode/);
assert.match(intel, /install-info\.txt/);
assert.match(intel, /rollback_install/);
assert.match(intel, /TRANSACTION_ACTIVE=1/);
assert.match(intel, /activate_path/);
assert.match(intel, /Revirtiendo la instalación incompleta/);
assert.match(intel, /DEFAULT_CODEX_HOME="\$HOME\/\.codex"/);
assert.match(intel, /installation_id/);
assert.match(intel, /AUTH_REUSED=1/);
assert.match(uninstaller, /games\.engine-room\.ae-mcp/);
assert.match(uninstaller, /ChatGPT\/Codex/);

const arm = renderInstaller(template, "9.8.7", "arm64");
assert.match(arm, /EXPECTED_ARCH="arm64"/);
assert.match(arm, /ARCH_LABEL="Apple Silicon"/);

console.log("mac-installer: 20 assertions passed");
