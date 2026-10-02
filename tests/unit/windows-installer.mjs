import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appPaths, codexCandidates, tomlString } from "../../scripts/windows/common.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const env = {
  USERPROFILE: "C:\\Users\\Nector",
  LOCALAPPDATA: "C:\\Users\\Nector\\AppData\\Local",
  APPDATA: "C:\\Users\\Nector\\AppData\\Roaming",
};
const p = appPaths(env);
assert.equal(p.root, "C:\\Users\\Nector\\AppData\\Local\\AE AI");
assert.equal(p.mcpBinary, "C:\\Users\\Nector\\AppData\\Local\\AE AI\\bin\\after-effects-mcp.exe");
assert.equal(p.panelDir, "C:\\Users\\Nector\\AppData\\Roaming\\Adobe\\CEP\\extensions\\games.engine-room.ae-mcp");
const candidates = codexCandidates({ ...env, PROGRAMFILES: "C:\\Program Files", PATH: "" });
assert.ok(candidates.some((x) => /Programs\\ChatGPT\\resources\\codex\.exe$/i.test(x)));
assert.ok(candidates.some((x) => /Program Files\\ChatGPT\\resources\\codex\.exe$/i.test(x)));
assert.equal(tomlString("C:\\AE AI\\bin\\after-effects-mcp.exe"), '"C:\\\\AE AI\\\\bin\\\\after-effects-mcp.exe"');

const install = fs.readFileSync(path.join(root, "scripts", "windows", "install.mjs"), "utf8");
const uninstall = fs.readFileSync(path.join(root, "scripts", "windows", "uninstall.mjs"), "utf8");
const common = fs.readFileSync(path.join(root, "scripts", "windows", "common.mjs"), "utf8");
const build = fs.readFileSync(path.join(root, "scripts", "build-windows-installer.mjs"), "utf8");
assert.match(common, /AfterFX\.exe/);
assert.match(common, /PlayerDebugMode/);
assert.match(common, /codex-code-mode-host\.exe/);
assert.match(common, /chatgpt\.com\/codex\/install\.ps1/);
assert.match(common, /installCodexOfficial/);
assert.match(common, /reuseExistingCodexAuth/);
assert.match(common, /installation_id/);
assert.match(install, /reuseExistingCodexAuth/);
assert.match(install, /installCodexOfficial/);
assert.match(install, /mcp_servers\.after-effects/);
assert.match(install, /install-info\.txt/);
assert.match(install, /codex_source=/);
assert.match(install, /codex_fallback=/);
assert.match(install, /function rollback\(/);
assert.match(install, /function activate\(/);
assert.match(install, /Se restauró la instalación anterior/);
assert.match(uninstall, /confirmDialog/);
assert.doesNotMatch(uninstall, /reg\.exe.*delete/);
assert.match(build, /--windows-hide-console/);
assert.match(build, /bun-windows-x64/);
assert.match(build, /Desinstalar AE AI\.exe/);
console.log("windows-installer: 27 assertions passed");
