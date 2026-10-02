#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const templatePath = path.join(root, "scripts", "macos", "Instalar AE AI.command");
const uninstallTemplatePath = path.join(root, "scripts", "macos", "Desinstalar AE AI.command");

export function renderInstaller(template, version, arch) {
  const values = {
    "__VERSION__": version,
    "__ARCH__": arch === "x64" ? "x86_64" : "arm64",
    "__ARCH_LABEL__": arch === "x64" ? "Intel" : "Apple Silicon",
  };
  for (const [marker, value] of Object.entries(values)) {
    template = template.replaceAll(marker, value);
  }
  return template;
}

function copy(src, dst) {
  fs.cpSync(src, dst, {
    recursive: true,
    filter: (entry) => path.basename(entry) !== ".DS_Store",
  });
}

function directorySizeBytes(rootDir) {
  let total = 0;
  const stack = [rootDir];
  while (stack.length) {
    const current = stack.pop();
    let stat;
    try { stat = fs.lstatSync(current); } catch { continue; }
    if (stat.isSymbolicLink()) continue;
    if (stat.isFile()) { total += stat.size; continue; }
    if (!stat.isDirectory()) continue;
    let entries = [];
    try { entries = fs.readdirSync(current); } catch { continue; }
    for (const name of entries) stack.push(path.join(current, name));
  }
  return total;
}

export function buildInstaller(options = {}) {
  if (process.platform !== "darwin") {
    throw new Error("The macOS installer must be built on macOS.");
  }

  const arch = options.arch ?? os.arch();
  if (!["x64", "arm64"].includes(arch)) {
    throw new Error("Unsupported macOS architecture: " + arch);
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const target = arch === "x64" ? "macos-x64" : "macos-arm64";
  const binaryStage = path.join(root, "dist-release", `after-effects-mcp-${pkg.version}-${target}`);
  // Never package whatever happens to be lying around in dist-release. That
  // directory is build output, and a stale copy previously reinstalled an old
  // AE AI UI over newer source. Rebuild the exact target first unless a test
  // explicitly opts into an already-prepared stage.
  if (options.rebuild !== false) {
    execFileSync(process.execPath, [path.join(root, "scripts", "build-binaries.mjs"), "--target", target], { cwd: root, stdio: "inherit" });
  }
  const outputName = `AE-AI-${pkg.version}-macOS-${arch === "x64" ? "Intel" : "Apple-Silicon"}`;
  const outputDir = path.join(root, "dist-release", outputName);
  const dmgPath = outputDir + ".dmg";
  const appPath = path.join(outputDir, "Instalar AE AI.app");
  const uninstallAppPath = path.join(outputDir, "Desinstalar AE AI.app");

  const required = [
    path.join(binaryStage, "after-effects-mcp"),
    path.join(binaryStage, "panel"),
    path.join(binaryStage, "node_modules", "ws"),
  ];
  for (const item of required) {
    if (!fs.existsSync(item)) throw new Error(`Missing ${item}. Build the standalone macOS target first.`);
  }

  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.rmSync(dmgPath, { force: true });
  fs.mkdirSync(outputDir, { recursive: true });

  const appleScript = `on run\n` +
    `  set appRoot to POSIX path of (path to me)\n` +
    `  set installScript to quoted form of (appRoot & "Contents/Resources/install.sh")\n` +
    `  try\n` +
    `    do shell script "AE_AI_SKIP_PAUSE=1 /bin/bash " & installScript\n` +
    `    display dialog "AE AI se instaló correctamente. Ahora abre After Effects y ve a Ventana > Extensiones > AE AI." with title "AE AI" buttons {"Listo"} default button "Listo" with icon note\n` +
    `  on error errMsg number errNum\n` +
    `    display alert "No se pudo instalar AE AI" message errMsg as critical\n` +
    `  end try\n` +
    `end run\n`;
  const scriptFile = path.join(os.tmpdir(), `ae-ai-installer-${process.pid}.applescript`);
  fs.writeFileSync(scriptFile, appleScript, "utf8");
  try {
    execFileSync("osacompile", ["-o", appPath, scriptFile], { stdio: "inherit" });
  } finally {
    fs.rmSync(scriptFile, { force: true });
  }

  const uninstallAppleScript = `on run\n` +
    `  set appRoot to POSIX path of (path to me)\n` +
    `  set uninstallScript to quoted form of (appRoot & "Contents/Resources/uninstall.sh")\n` +
    `  display dialog "Esto eliminará AE AI y su panel de After Effects. ChatGPT y Codex no se eliminarán." with title "Desinstalar AE AI" buttons {"Cancelar", "Desinstalar"} default button "Cancelar" with icon caution\n` +
    `  if button returned of result is "Desinstalar" then\n` +
    `    try\n` +
    `      do shell script "/bin/bash " & uninstallScript\n` +
    `      display dialog "AE AI se desinstaló correctamente." with title "AE AI" buttons {"Listo"} default button "Listo" with icon note\n` +
    `    on error errMsg number errNum\n` +
    `      display alert "No se pudo desinstalar AE AI" message errMsg as critical\n` +
    `    end try\n` +
    `  end if\n` +
    `end run\n`;
  const uninstallScriptFile = path.join(os.tmpdir(), `ae-ai-uninstaller-${process.pid}.applescript`);
  fs.writeFileSync(uninstallScriptFile, uninstallAppleScript, "utf8");
  try {
    execFileSync("osacompile", ["-o", uninstallAppPath, uninstallScriptFile], { stdio: "inherit" });
  } finally {
    fs.rmSync(uninstallScriptFile, { force: true });
  }

  const resources = path.join(appPath, "Contents", "Resources");
  const payload = path.join(resources, "payload");
  fs.mkdirSync(path.join(payload, "node_modules"), { recursive: true });
  copy(path.join(binaryStage, "after-effects-mcp"), path.join(payload, "after-effects-mcp"));
  copy(path.join(binaryStage, "panel"), path.join(payload, "panel"));
  copy(path.join(binaryStage, "node_modules", "ws"), path.join(payload, "node_modules", "ws"));

  const template = fs.readFileSync(templatePath, "utf8");
  const installScript = path.join(resources, "install.sh");
  fs.writeFileSync(installScript, renderInstaller(template, pkg.version, arch), { mode: 0o755 });
  fs.chmodSync(path.join(payload, "after-effects-mcp"), 0o755);

  const uninstallResources = path.join(uninstallAppPath, "Contents", "Resources");
  const uninstallScript = path.join(uninstallResources, "uninstall.sh");
  fs.copyFileSync(uninstallTemplatePath, uninstallScript);
  fs.chmodSync(uninstallScript, 0o755);

  fs.writeFileSync(path.join(outputDir, "LEEME.txt"),
    `AE AI ${pkg.version} para macOS\n\n` +
    `1. Cierra After Effects.\n` +
    `2. Haz doble clic en \"Instalar AE AI.app\".\n` +
    `3. Abre After Effects > Ventana > Extensiones > AE AI.\n` +
    `4. Si ya existe una sesión de ChatGPT/Codex, AE AI intentará reutilizarla automáticamente; si no, conecta tu cuenta una vez.\n`, "utf8");

  const identity = options.signIdentity ?? process.env.AE_AI_CODESIGN_IDENTITY ?? process.env.AE_MCP_SIGN_IDENTITY ?? "-";
  const mcpBinary = path.join(payload, "after-effects-mcp");
  const signArgs = identity === "-"
    ? ["--force", "--sign", "-", mcpBinary]
    : ["--force", "--options", "runtime", "--timestamp", "--sign", identity, mcpBinary];
  execFileSync("codesign", signArgs, { stdio: "inherit" });
  const appSignArgs = identity === "-"
    ? ["--force", "--deep", "--sign", "-", appPath]
    : ["--force", "--deep", "--options", "runtime", "--timestamp", "--sign", identity, appPath];
  execFileSync("codesign", appSignArgs, { stdio: "inherit" });
  const uninstallSignArgs = identity === "-"
    ? ["--force", "--deep", "--sign", "-", uninstallAppPath]
    : ["--force", "--deep", "--options", "runtime", "--timestamp", "--sign", identity, uninstallAppPath];
  execFileSync("codesign", uninstallSignArgs, { stdio: "inherit" });

  // Give hdiutil explicit headroom. Auto-sizing from an .app with resource
  // forks/xattrs can occasionally undershoot and fail with ENOSPC while the
  // host disk still has plenty of free space.
  const sourceBytes = directorySizeBytes(outputDir);
  const imageSizeMb = Math.max(256, Math.ceil(sourceBytes / (1024 * 1024) * 2.5));
  execFileSync("hdiutil", ["create", "-volname", `AE AI ${pkg.version}`, "-srcfolder", outputDir, "-size", `${imageSizeMb}m`, "-ov", "-format", "UDZO", dmgPath], { stdio: "inherit" });

  if (identity !== "-") {
    execFileSync("codesign", ["--force", "--timestamp", "--sign", identity, dmgPath], { stdio: "inherit" });
    if (process.env.SKIP_NOTARIZE !== "1") {
      const profile = options.notaryProfile ?? process.env.AE_AI_NOTARY_PROFILE ?? process.env.AE_MCP_NOTARY_PROFILE;
      const keyId = process.env.AE_MCP_NOTARY_KEY_ID;
      let notaryArgs = [];
      if (profile) {
        notaryArgs = ["--keychain-profile", profile];
      } else if (keyId && process.env.AE_MCP_NOTARY_KEY_ISSUER && process.env.AE_MCP_NOTARY_KEY_PATH) {
        notaryArgs = [
          "--key", process.env.AE_MCP_NOTARY_KEY_PATH,
          "--key-id", keyId,
          "--issuer", process.env.AE_MCP_NOTARY_KEY_ISSUER,
        ];
      }
      if (notaryArgs.length) {
        execFileSync("xcrun", ["notarytool", "submit", dmgPath, ...notaryArgs, "--wait"], { stdio: "inherit" });
        execFileSync("xcrun", ["stapler", "staple", dmgPath], { stdio: "inherit" });
      }
    }
  }

  return { outputDir, dmgPath, appPath, uninstallAppPath, arch, target, signed: identity !== "-" };
}

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const invokedDirectly = process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    const result = buildInstaller({ arch: argValue("--arch") });
    console.log(`\nInstaller folder: ${result.outputDir}`);
    console.log(`DMG: ${result.dmgPath}`);
  } catch (error) {
    console.error(`Could not build macOS installer: ${error.message}`);
    process.exit(1);
  }
}
