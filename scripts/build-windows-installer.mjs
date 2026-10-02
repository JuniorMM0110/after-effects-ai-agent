#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const bun = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "bun.cmd" : "bun");
const stage = path.join(root, "dist-release", `after-effects-mcp-${pkg.version}-windows-x64`);
const outputDir = path.join(root, "dist-release", `AE-AI-${pkg.version}-Windows-x64`);
const zipPath = outputDir + ".zip";
const srcDir = path.join(root, "scripts", "windows");

// Same invariant as the macOS installer: the stage is disposable output, not
// an authority. Rebuild it so a release cannot silently bundle yesterday's
// panel/server after today's source changed.
execFileSync(process.execPath, [path.join(root, "scripts", "build-binaries.mjs"), "--target", "windows-x64"], { cwd: root, stdio: "inherit" });

for (const required of [
  path.join(stage, "after-effects-mcp.exe"),
  path.join(stage, "panel"),
  path.join(stage, "node_modules", "ws"),
  path.join(srcDir, "common.mjs"),
  path.join(srcDir, "install.mjs"),
  path.join(srcDir, "uninstall.mjs"),
]) {
  if (!fs.existsSync(required)) throw new Error(`Missing ${required}`);
}

fs.rmSync(outputDir, { recursive: true, force: true });
fs.rmSync(zipPath, { force: true });
fs.mkdirSync(path.join(outputDir, "payload", "node_modules"), { recursive: true });
fs.copyFileSync(path.join(stage, "after-effects-mcp.exe"), path.join(outputDir, "payload", "after-effects-mcp.exe"));
fs.cpSync(path.join(stage, "panel"), path.join(outputDir, "payload", "panel"), { recursive: true });
fs.cpSync(path.join(stage, "node_modules", "ws"), path.join(outputDir, "payload", "node_modules", "ws"), { recursive: true });

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ae-ai-win-installer-"));
try {
  fs.copyFileSync(path.join(srcDir, "common.mjs"), path.join(temp, "common.mjs"));
  fs.writeFileSync(path.join(temp, "install.mjs"), fs.readFileSync(path.join(srcDir, "install.mjs"), "utf8").replaceAll("__VERSION__", pkg.version));
  fs.copyFileSync(path.join(srcDir, "uninstall.mjs"), path.join(temp, "uninstall.mjs"));

  compile(path.join(temp, "install.mjs"), path.join(outputDir, "Instalar AE AI.exe"), "Instalar AE AI", "Instalador gráfico de AE AI para After Effects");
  compile(path.join(temp, "uninstall.mjs"), path.join(outputDir, "Desinstalar AE AI.exe"), "Desinstalar AE AI", "Desinstalador gráfico de AE AI para After Effects");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

fs.writeFileSync(path.join(outputDir, "LEEME.txt"),
  `AE AI ${pkg.version} para Windows 10/11 x64\r\n\r\n` +
  `1. Cierra After Effects.\r\n` +
  `2. Mantén conexión a Internet durante la instalación.\r\n` +
  `3. Haz doble clic en "Instalar AE AI.exe". Si Codex no está instalado, AE AI instalará automáticamente el componente oficial de OpenAI.\r\n` +
  `4. Abre After Effects > Ventana > Extensiones > AE AI.\r\n` +
  `5. Si ya existe una sesión válida de ChatGPT/Codex, AE AI intentará reutilizarla automáticamente; si no, conecta tu cuenta una vez.\r\n\r\n` +
  `Para quitar AE AI: cierra After Effects y abre "Desinstalar AE AI.exe".\r\n` +
  `Nota: esta compilación de desarrollo no tiene certificado Authenticode; Windows puede mostrar SmartScreen.\r\n`, "utf8");

createZip(outputDir, zipPath);
console.log(`Windows installer folder: ${outputDir}`);
console.log(`Windows installer ZIP: ${zipPath}`);

function compile(entry, outfile, title, description) {
  const args = [
    "build", entry, "--compile", "--target=bun-windows-x64", "--minify",
    "--windows-hide-console",
  ];
  // Bun can cross-compile the executable and hide its console from macOS, but
  // editing PE metadata is host-Windows-only. CI/release builds on Windows add
  // the friendly metadata; Mac development builds remain fully functional.
  if (process.platform === "win32") {
    args.push(
      `--windows-title=${title}`,
      "--windows-publisher=AE AI",
      `--windows-version=${pkg.version}.0`,
      `--windows-description=${description}`,
    );
  }
  args.push("--outfile", outfile);
  execFileSync(bun, args, { cwd: root, stdio: "inherit" });
}

function createZip(dir, out) {
  if (process.platform === "darwin") {
    execFileSync("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", dir, out], { stdio: "inherit" });
    return;
  }
  if (process.platform === "win32") {
    execFileSync("powershell.exe", ["-NoProfile", "-Command", `Compress-Archive -Path '${dir.replaceAll("'", "''")}' -DestinationPath '${out.replaceAll("'", "''")}' -Force`], { stdio: "inherit", windowsHide: true });
    return;
  }
  execFileSync("zip", ["-qr", out, path.basename(dir)], { cwd: path.dirname(dir), stdio: "inherit" });
}
