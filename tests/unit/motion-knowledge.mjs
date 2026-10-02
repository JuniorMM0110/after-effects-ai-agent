import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...p) => fs.readFileSync(path.join(root, ...p), "utf8");
let passed = 0;
function check(name, fn) {
  try { fn(); passed++; }
  catch (e) { console.error("motion-knowledge:", name); throw e; }
}

const catalog = JSON.parse(read("knowledge", "motion-sources.json"));
check("catalog schema and useful seed size", () => {
  assert.equal(catalog.schemaVersion, 1);
  assert.ok(catalog.sources.length >= 20);
});
check("source ids are unique", () => {
  assert.equal(new Set(catalog.sources.map((s) => s.id)).size, catalog.sources.length);
});
check("all bundled sources are YouTube watch links", () => {
  for (const s of catalog.sources) assert.match(s.url, /^https:\/\/(www\.)?youtube\.com\/watch\?v=/);
});

check("every source has retrieval metadata", () => {
  for (const s of catalog.sources) {
    assert.ok(s.title && s.category && s.priority && s.purpose);
    assert.ok(Array.isArray(s.tags) && s.tags.length);
  }
});

check("generated knowledge is current", () => {
  const r = spawnSync(process.execPath, ["scripts/build-motion-knowledge.mjs", "--check"], { cwd: root, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr || r.stdout);
});

check("pending export is machine-readable JSONL", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ae-motion-"));
  const out = path.join(dir, "pending.jsonl");
  const r = spawnSync(process.execPath, ["scripts/motion-knowledge.mjs", "export-pending", out], { cwd: root, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const rows = fs.readFileSync(out, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  const analyzedIds = new Set(fs.readdirSync(path.join(root, "knowledge", "recipes")).filter((n) => n.endsWith(".json")).map((n) => n.replace(/\.json$/, "")));
  const expectedPending = catalog.sources.filter((s) => !analyzedIds.has(s.id)).length;
  assert.equal(rows.length, expectedPending);
  if (rows.length) assert.ok(rows[0].instruction.includes(rows[0].source.id));
});


const curatedPath = path.join(root, "knowledge", "curated", "CURATED-PARALLAX-001.json");
const curated = JSON.parse(fs.readFileSync(curatedPath, "utf8"));
check("curated parallax recipe is complete and high confidence", () => {
  assert.equal(curated.origin, "curated");
  assert.ok(curated.confidence >= 0.95);
  assert.ok(curated.decisionRules.some((x) => /Scale/.test(x)));
  assert.ok(curated.procedure.some((x) => /Reconstruir/.test(x)));
  assert.ok(curated.qualityChecks.some((x) => /hueco/i.test(x)));
});

const hierarchyPath = path.join(root, "knowledge", "curated", "CURATED-HIERARCHY-001.json");
const hierarchy = JSON.parse(fs.readFileSync(hierarchyPath, "utf8"));
check("curated hierarchy recipe prefers shared parent motion over duplicate keyframes", () => {
  assert.equal(hierarchy.origin, "curated");
  assert.ok(hierarchy.confidence >= 0.95);
  assert.ok(hierarchy.decisionRules.some((x) => /keyframes/i.test(x) && /Null|padre/i.test(x)));
  assert.ok(hierarchy.procedure.some((x) => /Parentar|parent/i.test(x)));
  assert.ok(hierarchy.qualityChecks.some((x) => /redundantes/i.test(x)));
});

check("generated knowledge contains curated and synthesized collections", () => {
  const generated = read("packages", "mcp-server", "src", "generated", "motionKnowledge.ts");
  assert.match(generated, /MOTION_CURATED/);
  assert.match(generated, /CURATED-PARALLAX-001/);
  assert.match(generated, /CURATED-HIERARCHY-001/);
  assert.match(generated, /MOTION_SYNTHESIZED/);
  assert.match(generated, /SYNTH-PARALLAX-001/);
});

check("synthesis packet exports provenance plus instructions", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ae-motion-synth-"));
  const out = path.join(dir, "parallax.json");
  const r = spawnSync(process.execPath, ["scripts/motion-knowledge.mjs", "export-synthesis", "parallax camera 3d", out], { cwd: root, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const packet = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.equal(packet.schemaVersion, 1);
  assert.equal(packet.technique, "parallax camera 3d");
  assert.ok(packet.curated.some((x) => x.id === "CURATED-PARALLAX-001"));
  assert.ok(packet.learned.length >= 3);
  assert.ok(packet.learned.some((x) => x.sourceId === "AE-008"));
  assert.ok(packet.learned.some((x) => x.sourceId === "AE-009"));
  assert.ok(packet.learned.some((x) => x.sourceId === "AE-010"));
  assert.ok(packet.instruction.includes("síntesis profesional"));
});

check("status exposes all knowledge layers", () => {
  const r = spawnSync(process.execPath, ["scripts/motion-knowledge.mjs", "status"], { cwd: root, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const status = JSON.parse(r.stdout);
  assert.equal(status.sources, catalog.sources.length);
  assert.ok(status.learnedRecipes >= 3);
  assert.ok(status.curatedRecipes >= 1);
  assert.ok(status.synthesizedRecipes >= 1);
});

const server = read("packages", "mcp-server", "src", "server.ts");

check("MCP exposes lazy motion knowledge tools", () => {
  for (const name of ["search_motion_knowledge", "get_motion_technique", "list_motion_sources"]) {
    assert.ok(server.includes(`"${name}"`), `server is missing ${name}`);
  }
});

const ui = read("packages", "ae-panel", "client", "ae-ai.js");
check("knowledge calls are not displayed as After Effects actions", () => {
  assert.match(ui, /search_motion_knowledge\|get_motion_technique\|list_motion_sources/);
  assert.match(ui, /return null/);
});
check("editing prompt requires specialized knowledge preflight without loading the whole library", () => {
  assert.match(ui, /PREFLIGHT DE CONOCIMIENTO/);
  assert.match(ui, /DEBES llamar search_motion_knowledge antes del primer write/);
  assert.match(ui, /Recupera solo 3–5 resultados/);
  assert.match(ui, /get_motion_technique antes de planificar/);
});

console.log(`motion-knowledge: ${passed} assertions passed (${catalog.sources.length} bundled sources)`);
