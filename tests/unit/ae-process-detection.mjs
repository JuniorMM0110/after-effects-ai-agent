import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const source = fs.readFileSync(
  path.join(root, "packages", "mcp-server", "src", "setup", "platform.ts"),
  "utf8",
);

assert.match(source, /exec\("pgrep", \["-x", "After Effects"\]\)/);
assert.doesNotMatch(source, /exec\("pgrep", \["-f", "Adobe After Effects"\]\)/);
assert.match(source, /IMAGENAME eq AfterFX\.exe/);

console.log("ae-process-detection: 3 assertions passed");
