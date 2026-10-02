import fs from "node:fs";
import path from "node:path";
import {
  appPaths, copyTree, enableAdobeDebug, findCodex, findCodexSupport, installCodexOfficial,
  isAfterEffectsRunning, reuseExistingCodexAuth, showDialog, timestamp, tomlString,
} from "./common.mjs";

const VERSION = "__VERSION__";
const p = appPaths();
const payload = path.win32.join(path.win32.dirname(process.execPath), "payload");
const stamp = `${timestamp()}-${process.pid}`;
const activated = [];
const stages = [];

function exists(file) {
  try { fs.lstatSync(file); return true; } catch { return false; }
}

function stageSibling(target, label) {
  const staged = `${target}.install-${stamp}-${label}`;
  fs.rmSync(staged, { recursive: true, force: true });
  stages.push(staged);
  return staged;
}

function activate(staged, target, { keepBackup = false } = {}) {
  const backup = `${target}.backup-${stamp}`;
  fs.rmSync(backup, { recursive: true, force: true });
  const hadOld = exists(target);
  if (hadOld) fs.renameSync(target, backup);
  try {
    fs.renameSync(staged, target);
  } catch (error) {
    if (hadOld && exists(backup)) fs.renameSync(backup, target);
    throw error;
  }
  activated.push({ target, backup, hadOld, keepBackup });
  return backup;
}

function rollback() {
  for (let i = activated.length - 1; i >= 0; i--) {
    const item = activated[i];
    try { fs.rmSync(item.target, { recursive: true, force: true }); } catch {}
    if (item.hadOld && exists(item.backup)) {
      try { fs.renameSync(item.backup, item.target); } catch {}
    }
  }
}

function finishTransaction() {
  for (const item of activated) {
    if (!item.keepBackup) fs.rmSync(item.backup, { recursive: true, force: true });
  }
}

function cleanupStages() {
  for (const staged of stages) {
    try { fs.rmSync(staged, { recursive: true, force: true }); } catch {}
  }
}

try {
  if (isAfterEffectsRunning()) throw new Error("Cierra After Effects completamente y vuelve a abrir el instalador.");
  for (const required of ["after-effects-mcp.exe", "panel", path.win32.join("node_modules", "ws")]) {
    if (!fs.existsSync(path.win32.join(payload, required))) throw new Error(`El instalador está incompleto: falta ${required}.`);
  }
  for (const dir of [p.root, p.binDir, p.codexHome, p.runtimeDir, p.cepRoot]) fs.mkdirSync(dir, { recursive: true });

  // Resolve and validate every external dependency before replacing anything.
  let codex = findCodex();
  if (!codex) {
    showDialog("AE AI", "AE AI necesita el componente oficial Codex de OpenAI. No se encontró en este equipo, así que se instalará automáticamente. Mantén la conexión a Internet activa y espera a que termine.");
    codex = installCodexOfficial();
  }
  const host = findCodexSupport(codex, "codex-code-mode-host.exe");
  if (!host) throw new Error("La instalación de ChatGPT/Codex no incluye codex-code-mode-host.exe. Actualiza ChatGPT y vuelve a intentarlo.");
  const rg = findCodexSupport(codex, "rg.exe");

  // Stage every AE AI-owned path beside its destination. No existing install is
  // touched until every copy/config write below has succeeded.
  const mcpStage = stageSibling(p.mcpBinary, "mcp");
  fs.copyFileSync(path.win32.join(payload, "after-effects-mcp.exe"), mcpStage);

  const panelStage = stageSibling(p.panelDir, "panel");
  copyTree(path.win32.join(payload, "panel"), panelStage);
  fs.mkdirSync(path.win32.join(panelStage, "node_modules"), { recursive: true });
  copyTree(path.win32.join(payload, "node_modules", "ws"), path.win32.join(panelStage, "node_modules", "ws"));

  const codexStage = stageSibling(p.codexBinary, "codex");
  const hostStage = stageSibling(p.codexHostBinary, "host");
  fs.copyFileSync(codex, codexStage);
  fs.copyFileSync(host, hostStage);
  const rgStage = rg ? stageSibling(p.rgBinary, "rg") : null;
  if (rg && rgStage) fs.copyFileSync(rg, rgStage);

  const configPath = path.win32.join(p.codexHome, "config.toml");
  const configStage = stageSibling(configPath, "config");
  fs.writeFileSync(configStage,
    `# Administrado por AE AI.\r\ncli_auth_credentials_store = "auto"\r\n\r\n` +
    `[mcp_servers.after-effects]\r\ncommand = ${tomlString(p.mcpBinary)}\r\nargs = []\r\ndefault_tools_approval_mode = "approve"\r\n`);

  const infoPath = path.win32.join(p.root, "install-info.txt");
  const infoStage = stageSibling(infoPath, "info");
  fs.writeFileSync(infoStage,
    `version=${VERSION}\r\narchitecture=x64\r\ninstalled_at=${new Date().toISOString()}\r\npanel=${p.panelDir}\r\ncodex_source=${codex}\r\ncodex_fallback=${p.codexBinary}\r\n`);

  // Commit with a backup before every rename. If any later activation fails,
  // rollback() restores each previous target in reverse order.
  activate(mcpStage, p.mcpBinary);
  const panelBackup = activate(panelStage, p.panelDir, { keepBackup: true });
  activate(codexStage, p.codexBinary);
  activate(hostStage, p.codexHostBinary);
  if (rgStage) activate(rgStage, p.rgBinary);
  activate(configStage, configPath);
  activate(infoStage, infoPath);
  finishTransaction();
  cleanupStages();

  enableAdobeDebug();
  const reusedAuth = reuseExistingCodexAuth(p.codexBinary, p.codexHome);
  const backupNote = exists(panelBackup) ? `\n\nRespaldo del panel anterior:\n${panelBackup}` : "";
  const authNote = reusedAuth
    ? "\n\nSe detectó una sesión de ChatGPT/Codex activa y AE AI la reutilizará automáticamente."
    : "\n\nSi este equipo todavía no tiene una sesión de ChatGPT/Codex activa, conecta tu cuenta una vez desde AE AI.";
  showDialog("AE AI", "AE AI se instaló correctamente. Abre After Effects > Ventana > Extensiones > AE AI." + authNote + backupNote);
} catch (error) {
  rollback();
  cleanupStages();
  showDialog("AE AI", `No se pudo instalar AE AI. Se restauró la instalación anterior.\n\n${error?.message || error}`, "error");
  process.exitCode = 1;
}
