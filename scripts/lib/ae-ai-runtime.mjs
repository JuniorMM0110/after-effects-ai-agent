import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function aeAiRoot(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "AE AI");
  }
  if (platform === "win32") {
    return path.join(env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "AE AI");
  }
  return path.join(env.XDG_DATA_HOME ?? path.join(home, ".local", "share"), "AE AI");
}

export function aeAiPaths(options = {}) {
  const platform = options.platform ?? process.platform;
  const root = aeAiRoot(platform, options.env ?? process.env, options.home ?? os.homedir());
  const binDir = path.join(root, "bin");
  return {
    root,
    binDir,
    codexHome: path.join(root, "codex"),
    runtimeDir: path.join(root, "runtime"),
    codexBinary: path.join(binDir, platform === "win32" ? "codex.exe" : "codex"),
    mcpBinary: path.join(binDir, platform === "win32" ? "after-effects-mcp.exe" : "after-effects-mcp"),
  };
}

export function ensureAeAiDirs(paths = aeAiPaths()) {
  for (const dir of [paths.root, paths.binDir, paths.codexHome, paths.runtimeDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return paths;
}

export function codexEnvironment(base = process.env, paths = aeAiPaths()) {
  return { ...base, CODEX_HOME: paths.codexHome };
}
