#!/usr/bin/env node
// Builds standalone executables into `dist-release/` — the install path for
// people on a client that is not Claude Desktop and who do not have Node.
//
// Each target produces a folder, not a bare file:
//
//   after-effects-mcp-<version>-<target>/
//     after-effects-mcp[.exe]   the compiled server
//     package.json              the version, read at runtime
//     panel/                    the CEP panel, installed into AE by setup_panel
//     node_modules/ws/          copied into the panel; cannot be inlined
//     README.txt                what to put in the client's config
//
// The extra files are not optional. A compiled binary has no module paths to
// resolve from, so `setup/paths.ts` falls back to looking beside the executable
// — see `executableDir()` there.
//
// Usage: node scripts/build-binaries.mjs [--out <dir>] [--target <name>]

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPkg = path.join(root, "packages", "mcp-server");
const panelSrc = path.join(root, "packages", "ae-panel");
const wsSrc = path.join(root, "node_modules", "ws");

const outIdx = process.argv.indexOf("--out");
const outDir = outIdx >= 0 ? path.resolve(process.argv[outIdx + 1]) : path.join(root, "dist-release");
const onlyIdx = process.argv.indexOf("--target");
const only = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : null;

const version = JSON.parse(fs.readFileSync(path.join(serverPkg, "package.json"), "utf8")).version;
const localBun = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "bun.cmd" : "bun");
const bunBinary = fs.existsSync(localBun) ? localBun : "bun";

/** Bun's target triples, mapped to the names used in release asset filenames. */
const TARGETS = [
  { name: "macos-arm64", bun: "bun-darwin-arm64", exe: "after-effects-mcp", sign: true },
  { name: "macos-x64", bun: "bun-darwin-x64", exe: "after-effects-mcp", sign: true },
  // Windows binaries ship unsigned: SmartScreen reputation needs a separate
  // certificate this project does not have. Documented in the README rather
  // than quietly produced as if equivalent.
  { name: "windows-x64", bun: "bun-windows-x64", exe: "after-effects-mcp.exe", sign: false },
];

try {
  execFileSync(bunBinary, ["--version"], { stdio: "ignore" });
} catch {
  console.error("bun is not installed. Run `npm install` to install the project-local compiler.");
  process.exit(1);
}
for (const dir of [panelSrc, wsSrc]) {
  if (!fs.existsSync(dir)) {
    console.error(`Missing ${path.relative(root, dir)}. Run \`npm install && npm run build\` first.`);
    process.exit(1);
  }
}
if (!fs.existsSync(path.join(panelSrc, "jsx", "bundle.jsx"))) {
  console.error("Missing packages/ae-panel/jsx/bundle.jsx. Run `npm run build` first.");
  process.exit(1);
}

const README = (target) => `After Effects MCP ${version} — ${target.name}

Point your AI client at the executable in this folder. Keep the folder together:
the panel and the files beside the binary are part of the install.

  {
    "mcpServers": {
      "after-effects": {
        "command": "${path.join("<full path to this folder>", target.exe)}"
      }
    }
  }

Then open After Effects and ask your assistant to set up After Effects. That
installs a small panel into After Effects; it only has to happen once.

${
  target.sign
    ? "This macOS executable is code-signed so the compiled payload is valid. Official release assets may additionally carry Developer ID signing/notarization."
    : "This build is unsigned. Windows SmartScreen may warn on first run: choose\nMore info -> Run anyway."
}

Docs and issues: https://github.com/Engine-Room-Games/after-effects-mcp
`;

fs.mkdirSync(outDir, { recursive: true });
const built = [];

for (const target of TARGETS) {
  if (only && only !== target.name) continue;

  const stageName = `after-effects-mcp-${version}-${target.name}`;
  const finalStage = path.join(outDir, stageName);
  const stage = `${finalStage}.build-${process.pid}`;
  const previousStage = `${finalStage}.previous-${process.pid}`;
  fs.rmSync(stage, { recursive: true, force: true });
  fs.rmSync(previousStage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });

  process.stdout.write(`Compiling ${target.name}… `);
  const binaryPath = path.join(stage, target.exe);
  execFileSync(
    bunBinary,
    [
      "build",
      path.join(serverPkg, "src", "index.ts"),
      "--compile",
      `--target=${target.bun}`,
      "--outfile",
      binaryPath,
      // Bun refuses to start a compiled binary that was built with sourcemaps
      // it cannot find; nothing here needs them.
      "--minify",
    ],
    { stdio: ["ignore", "ignore", "inherit"], cwd: root }
  );

  // Bun's compiler starts from a signed Bun executable and appends/replaces the
  // embedded application payload. On macOS that invalidates Bun's original
  // Developer ID signature; the kernel then kills the resulting executable with
  // SIGKILL before it can print an error. Re-sign every locally built macOS
  // payload ad-hoc immediately, and verify it before calling the stage usable.
  // Official release signing/notarization can replace this signature later.
  if (process.platform === "darwin" && target.name.startsWith("macos-")) {
    execFileSync(
      "codesign",
      ["--force", "--sign", "-", "--timestamp=none", "--options", "runtime", binaryPath],
      { stdio: "inherit" }
    );
    execFileSync("codesign", ["--verify", "--deep", "--strict", binaryPath], { stdio: "inherit" });
  }

  fs.writeFileSync(
    path.join(stage, "package.json"),
    JSON.stringify({ name: "@engine-room/after-effects-mcp", version, private: true }, null, 2) + "\n"
  );
  copy(panelSrc, path.join(stage, "panel"));
  copy(wsSrc, path.join(stage, "node_modules", "ws"));
  fs.writeFileSync(path.join(stage, "README.txt"), README(target));

  // Publish the complete stage only after compile/sign/copy all succeeded. If
  // activating the new folder fails, restore the previous release output so a
  // broken build cannot destroy the last known-good installer payload.
  let hadPrevious = false;
  try {
    if (fs.existsSync(finalStage)) {
      fs.renameSync(finalStage, previousStage);
      hadPrevious = true;
    }
    fs.renameSync(stage, finalStage);
  } catch (error) {
    try { fs.rmSync(finalStage, { recursive: true, force: true }); } catch {}
    if (hadPrevious && fs.existsSync(previousStage)) {
      try { fs.renameSync(previousStage, finalStage); } catch {}
    }
    throw error;
  }
  fs.rmSync(previousStage, { recursive: true, force: true });

  const size = (dirSize(finalStage) / 1024 / 1024).toFixed(1);
  console.log(`${size} MB -> ${path.relative(root, finalStage)}`);
  built.push({ ...target, stage: finalStage, stageName });
}

// Emitted for the release script, which signs the macOS ones and zips them all.
fs.writeFileSync(
  path.join(outDir, "binaries.json"),
  JSON.stringify({ version, targets: built.map(({ name, exe, sign, stageName }) => ({ name, exe, sign, stageName })) }, null, 2) + "\n"
);

console.log(`\n${built.length} target(s) in ${path.relative(root, outDir)}`);

function copy(src, dst) {
  const base = path.basename(src);
  if (base === "node_modules" || base === ".DS_Store") return;
  const stat = fs.lstatSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src)) copy(path.join(src, entry), path.join(dst, entry));
  } else {
    fs.copyFileSync(src, dst);
  }
}

function dirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(full) : fs.statSync(full).size;
  }
  return total;
}
