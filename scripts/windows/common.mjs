import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const w = path.win32;

export function appPaths(env = process.env) {
  const user = env.USERPROFILE || "C:\\Users\\User";
  const local = env.LOCALAPPDATA || w.join(user, "AppData", "Local");
  const roaming = env.APPDATA || w.join(user, "AppData", "Roaming");
  const root = w.join(local, "AE AI");
  const binDir = w.join(root, "bin");
  const cepRoot = w.join(roaming, "Adobe", "CEP", "extensions");
  return {
    root,
    binDir,
    codexHome: w.join(root, "codex"),
    runtimeDir: w.join(root, "runtime"),
    mcpBinary: w.join(binDir, "after-effects-mcp.exe"),
    codexBinary: w.join(binDir, "codex.exe"),
    codexHostBinary: w.join(binDir, "codex-code-mode-host.exe"),
    rgBinary: w.join(binDir, "rg.exe"),
    cepRoot,
    panelDir: w.join(cepRoot, "games.engine-room.ae-mcp"),
  };
}

export function isAfterEffectsRunning() {
  try {
    const out = execFileSync("tasklist.exe", ["/FI", "IMAGENAME eq AfterFX.exe", "/NH"], {
      encoding: "utf8", windowsHide: true,
    });
    return /AfterFX\.exe/i.test(out);
  } catch { return false; }
}

function powershell(script, extraEnv = {}) {
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script], {
    encoding: "utf8", windowsHide: true, env: { ...process.env, ...extraEnv },
  }).trim();
}

export function showDialog(title, message, kind = "info") {
  const icon = kind === "error" ? "Error" : kind === "warning" ? "Warning" : "Information";
  try {
    powershell('Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show($env:AEAI_MSG,$env:AEAI_TITLE,"OK","' + icon + '") | Out-Null', {
      AEAI_TITLE: title, AEAI_MSG: message,
    });
  } catch {}
}

export function confirmDialog(title, message) {
  try {
    const out = powershell('Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show($env:AEAI_MSG,$env:AEAI_TITLE,"YesNo","Warning")', {
      AEAI_TITLE: title, AEAI_MSG: message,
    });
    return /Yes/i.test(out);
  } catch { return false; }
}

export function enableAdobeDebug() {
  for (const v of [9, 10, 11, 12, 13]) {
    try {
      execFileSync("reg.exe", ["add", `HKCU\\Software\\Adobe\\CSXS.${v}`, "/v", "PlayerDebugMode", "/t", "REG_SZ", "/d", "1", "/f"], { stdio: "ignore", windowsHide: true });
    } catch {}
    try {
      execFileSync("reg.exe", ["query", `HKCU\\Software\\Adobe\\CSXS.${v}`, "/v", "LogLevel"], { stdio: "ignore", windowsHide: true });
    } catch {
      try {
        execFileSync("reg.exe", ["add", `HKCU\\Software\\Adobe\\CSXS.${v}`, "/v", "LogLevel", "/t", "REG_DWORD", "/d", "6", "/f"], { stdio: "ignore", windowsHide: true });
      } catch {}
    }
  }
}

function firstWhere(name) {
  try {
    const out = execFileSync("where.exe", [name], { encoding: "utf8", windowsHide: true });
    return out.split(/\r?\n/).map((x) => x.trim()).find((x) => x && fs.existsSync(x));
  } catch { return undefined; }
}

function scan(root, name, maxDepth = 6) {
  if (!root || !fs.existsSync(root)) return undefined;
  const queue = [[root, 0]];
  let seen = 0;
  while (queue.length && seen < 5000) {
    const [dir, depth] = queue.shift();
    seen++;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = w.join(dir, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) return full;
      if (entry.isDirectory() && depth < maxDepth && !/^(cache|logs?|temp)$/i.test(entry.name)) queue.push([full, depth + 1]);
    }
  }
  return undefined;
}

export function codexCandidates(env = process.env) {
  const user = env.USERPROFILE || "";
  return [
    env.AE_AI_CODEX_PATH,
    firstWhere("codex.exe"),
    env.LOCALAPPDATA && w.join(env.LOCALAPPDATA, "Programs", "ChatGPT", "resources", "codex.exe"),
    env.LOCALAPPDATA && w.join(env.LOCALAPPDATA, "Programs", "ChatGPT", "resources", "app", "codex.exe"),
    env.PROGRAMFILES && w.join(env.PROGRAMFILES, "ChatGPT", "resources", "codex.exe"),
    env.PROGRAMFILES && w.join(env.PROGRAMFILES, "ChatGPT", "resources", "app", "codex.exe"),
    w.join(user, ".codex", "packages", "standalone", "current", "bin", "codex.exe"),
    w.join(user, ".local", "bin", "codex.exe"),
  ].filter(Boolean);
}

export function findCodex(env = process.env) {
  const candidates = codexCandidates(env);
  for (const c of candidates) if (fs.existsSync(c)) return c;

  const roots = [
    env.LOCALAPPDATA && w.join(env.LOCALAPPDATA, "Programs", "ChatGPT"),
    env.LOCALAPPDATA && w.join(env.LOCALAPPDATA, "OpenAI"),
    env.PROGRAMFILES && w.join(env.PROGRAMFILES, "ChatGPT"),
  ].filter(Boolean);
  try {
    const appx = powershell("Get-AppxPackage *ChatGPT* | Select-Object -ExpandProperty InstallLocation");
    roots.push(...appx.split(/\r?\n/).map((x) => x.trim()).filter(Boolean));
  } catch {}
  for (const root of roots) {
    const found = scan(root, "codex.exe", 7);
    if (found) return found;
  }
  return undefined;
}

export function installCodexOfficial(env = process.env) {
  const script = "$ProgressPreference='SilentlyContinue'; irm https://chatgpt.com/codex/install.ps1 | iex";
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "ByPass", "-Command", script], {
      encoding: "utf8", windowsHide: true, env, timeout: 180000,
    });
  } catch (error) {
    const detail = String(error?.stderr || error?.stdout || error?.message || error).trim();
    throw new Error("No se pudo instalar automáticamente el componente oficial Codex de OpenAI." + (detail ? `\n\n${detail}` : ""));
  }
  const installed = findCodex(env);
  if (!installed) throw new Error("Codex terminó de instalarse, pero AE AI no pudo localizarlo.");
  return installed;
}

export function findCodexSupport(codex, name, env = process.env) {
  const direct = w.join(w.dirname(codex), name);
  if (fs.existsSync(direct)) return direct;
  const user = env.USERPROFILE || "";
  for (const root of [
    w.join(user, ".codex", "packages", "standalone", "current", "bin"),
    w.join(user, ".codex", "packages", "standalone", "current", "codex-path"),
    w.dirname(codex),
  ]) {
    const found = scan(root, name, 3);
    if (found) return found;
  }
  return undefined;
}

export function tomlString(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function copyTree(src, dst) {
  fs.cpSync(src, dst, { recursive: true, force: true });
}

export function reuseExistingCodexAuth(codex, managedHome, env = process.env) {
  const user = env.USERPROFILE || "";
  const sourceHome = w.join(user, ".codex");
  const auth = w.join(sourceHome, "auth.json");
  const installation = w.join(sourceHome, "installation_id");
  if (!codex || !user || !fs.existsSync(auth)) return false;
  try {
    const defaultEnv = { ...env };
    delete defaultEnv.CODEX_HOME;
    const defaultStatus = execFileSync(codex, ["login", "status"], {
      encoding: "utf8", windowsHide: true, env: defaultEnv, timeout: 10000,
    });
    if (!/logged in/i.test(String(defaultStatus))) return false;
    fs.mkdirSync(managedHome, { recursive: true });
    fs.copyFileSync(auth, w.join(managedHome, "auth.json"));
    if (fs.existsSync(installation)) fs.copyFileSync(installation, w.join(managedHome, "installation_id"));
    const managedStatus = execFileSync(codex, ["login", "status"], {
      encoding: "utf8", windowsHide: true, env: { ...env, CODEX_HOME: managedHome }, timeout: 10000,
    });
    return /logged in/i.test(String(managedStatus));
  } catch {
    return false;
  }
}

export function timestamp() {
  return new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
}
