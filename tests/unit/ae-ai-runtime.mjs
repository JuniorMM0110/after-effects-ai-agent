import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { aeAiPaths, codexEnvironment, ensureAeAiDirs } from "../../scripts/lib/ae-ai-runtime.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ae-ai-runtime-"));
try {
  const paths = aeAiPaths({ platform: "darwin", home: tmp, env: {} });
  assert.equal(paths.root, path.join(tmp, "Library", "Application Support", "AE AI"));
  assert.equal(paths.codexBinary, path.join(paths.binDir, "codex"));
  assert.equal(paths.mcpBinary, path.join(paths.binDir, "after-effects-mcp"));

  ensureAeAiDirs(paths);
  for (const dir of [paths.root, paths.binDir, paths.codexHome, paths.runtimeDir]) {
    assert.equal(fs.statSync(dir).isDirectory(), true, `${dir} should exist`);
  }

  const env = codexEnvironment({ KEEP: "yes" }, paths);
  assert.equal(env.KEEP, "yes");
  assert.equal(env.CODEX_HOME, paths.codexHome);
  console.log("ae-ai-runtime: 9 assertions passed");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
