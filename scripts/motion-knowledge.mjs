import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const knowledgeDir = path.join(root, "knowledge");
const catalogPath = path.join(knowledgeDir, "motion-sources.json");
const recipesDir = path.join(knowledgeDir, "recipes");
const curatedDir = path.join(knowledgeDir, "curated");
const synthesizedDir = path.join(knowledgeDir, "synthesized");
const analysisPromptPath = path.join(knowledgeDir, "analysis-prompt.md");
const synthesisPromptPath = path.join(knowledgeDir, "synthesis-prompt.md");

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const jsonFiles = (dir) => fs.existsSync(dir)
  ? fs.readdirSync(dir).filter((n) => n.endsWith(".json")).sort()
  : [];
const catalog = readJson(catalogPath);
const analysisPrompt = fs.readFileSync(analysisPromptPath, "utf8");
const synthesisPrompt = fs.readFileSync(synthesisPromptPath, "utf8");
const sourceById = new Map(catalog.sources.map((s) => [s.id, s]));
const curated = jsonFiles(curatedDir).map((n) => readJson(path.join(curatedDir, n)));
const curatedById = new Map(curated.map((r) => [r.id, r]));

function recipeIds() {
  return new Set(jsonFiles(recipesDir).map((n) => n.replace(/\.json$/, "")));
}

function learnedRecipes() {
  return jsonFiles(recipesDir).map((n) => readJson(path.join(recipesDir, n)));
}

function synthesizedRecipes() {
  return jsonFiles(synthesizedDir).map((n) => readJson(path.join(synthesizedDir, n)));
}

function validateEvidenceRows(rows, field) {
  if (rows === undefined) return;
  if (!Array.isArray(rows)) throw new Error(`${field} must be an array`);
  for (const row of rows) {
    if (!row || typeof row !== "object") throw new Error(`${field} entries must be objects`);
    if (row.evidence !== undefined && !["confirmed", "inferred", "unknown"].includes(row.evidence)) {
      throw new Error(`${field} contains invalid evidence: ${row.evidence}`);
    }
  }
}

function validateAnalysis(a) {
  if (!a || typeof a !== "object") throw new Error("analysis must be an object");
  if (!sourceById.has(a.sourceId)) throw new Error(`unknown sourceId: ${a.sourceId}`);
  if (!a.summary || !Array.isArray(a.techniques) || !Array.isArray(a.reusableRecipe)) {
    throw new Error("analysis must include summary, techniques[] and reusableRecipe[]");
  }

  if (typeof a.confidence !== "number" || a.confidence < 0 || a.confidence > 1) {
    throw new Error("confidence must be between 0 and 1");
  }
  validateEvidenceRows(a.procedure, "procedure");
  validateEvidenceRows(a.animation, "animation");
  validateEvidenceRows(a.effects, "effects");
  return a;
}

function validateSynthesis(a) {
  if (!a || typeof a !== "object") throw new Error("synthesis must be an object");
  if (!/^SYNTH-[A-Z0-9-]+$/.test(a.id || "")) throw new Error("synthesis id must match SYNTH-[A-Z0-9-]+");
  if (a.origin !== "synthesized" || !a.title || !a.technique || !a.summary) {
    throw new Error("synthesis must include origin=synthesized, title, technique and summary");
  }
  if (!Array.isArray(a.sourceIds) || !Array.isArray(a.curatedIds) || !Array.isArray(a.reusableRecipe)) {
    throw new Error("synthesis must include sourceIds[], curatedIds[] and reusableRecipe[]");
  }
  for (const id of a.sourceIds) if (!sourceById.has(id)) throw new Error(`unknown synthesized sourceId: ${id}`);
  for (const id of a.curatedIds) if (!curatedById.has(id)) throw new Error(`unknown synthesized curatedId: ${id}`);
  if (typeof a.confidence !== "number" || a.confidence < 0 || a.confidence > 1) throw new Error("confidence must be between 0 and 1");
  if (a.consensus !== undefined) {
    if (!Array.isArray(a.consensus)) throw new Error("consensus must be an array");
    for (const item of a.consensus) {
      if (!item?.rule || !Number.isInteger(item.support) || item.support < 0) throw new Error("invalid consensus item");
      if (typeof item.confidence !== "number" || item.confidence < 0 || item.confidence > 1) throw new Error("invalid consensus confidence");
    }
  }
  return a;
}

function norm(v) {
  return String(v ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function score(query, item) {
  const tokens = norm(query).split(/[^a-z0-9]+/).filter((x) => x.length > 1);
  const hay = norm([
    item.id, item.sourceId, item.title, item.summary, item.category, item.technique,
    ...(item.tags || []), ...(item.techniques || []), ...(item.reusableRecipe || []),
    ...(item.decisionRules || []),
    ...(item.procedure || []).map((x) => typeof x === "string" ? x : `${x.action || ""} ${x.why || ""}`),
  ].join(" "));
  return tokens.reduce((total, token) => total + (hay.includes(token) ? (token.length >= 6 ? 3 : 1) : 0), 0);
}

function relevant(query, items, limit = 30) {
  return items.map((item) => ({ item, score: score(query, item) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.item);
}

const args = process.argv.slice(2);
const [cmd = "status", arg, arg2] = args;
const force = args.includes("--force");

if (cmd === "status") {
  const done = recipeIds();
  const pending = catalog.sources.filter((s) => !done.has(s.id));
  console.log(JSON.stringify({
    sources: catalog.sources.length,
    analyzed: done.size,
    learnedRecipes: done.size,
    curatedRecipes: curated.length,
    synthesizedRecipes: synthesizedRecipes().length,
    pending: pending.length,
  }, null, 2));

} else if (cmd === "validate") {
  const seen = new Set();
  for (const s of catalog.sources) {
    if (!/^AE-\d{3}$/.test(s.id) || seen.has(s.id)) throw new Error(`invalid/duplicate id: ${s.id}`);
    if (!/^https:\/\/(www\.)?youtube\.com\/watch\?v=/.test(s.url)) throw new Error(`invalid YouTube URL: ${s.id}`);
    seen.add(s.id);
  }
  for (const recipe of learnedRecipes()) validateAnalysis(recipe);
  for (const synthesis of synthesizedRecipes()) validateSynthesis(synthesis);
  console.log(`motion knowledge valid: ${catalog.sources.length} sources, ${curated.length} curated, ${synthesizedRecipes().length} synthesized`);
} else if (cmd === "export-pending") {
  const out = path.resolve(arg || path.join(knowledgeDir, "pending-analysis.jsonl"));
  const done = recipeIds();
  const rows = catalog.sources.filter((s) => !done.has(s.id)).map((source) => ({
    source,
    instruction: analysisPrompt.replace("AE-000", source.id),
  }));
  fs.writeFileSync(out, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
  console.log(`exported ${rows.length} pending analyses -> ${out}`);
} else if (cmd === "import-analysis") {
  if (!arg) throw new Error("usage: npm run motion:knowledge -- import-analysis <analysis.json> [--force]");
  const analysis = validateAnalysis(readJson(path.resolve(arg)));
  fs.mkdirSync(recipesDir, { recursive: true });
  const out = path.join(recipesDir, `${analysis.sourceId}.json`);
  if (fs.existsSync(out) && !force) throw new Error(`${analysis.sourceId} already exists; pass --force to replace it`);
  fs.writeFileSync(out, JSON.stringify(analysis, null, 2) + "\n");
  console.log(`imported ${analysis.sourceId} -> ${out}`);

} else if (cmd === "export-synthesis") {
  if (!arg) throw new Error("usage: npm run motion:knowledge -- export-synthesis <technique> [out.json]");
  const learned = relevant(arg, learnedRecipes());
  const curatedMatches = relevant(arg, curated);
  if (!learned.length && !curatedMatches.length) throw new Error(`no analyzed or curated knowledge found for: ${arg}`);
  const sourceIds = [...new Set(learned.map((r) => r.sourceId).filter(Boolean))];
  const packet = {
    schemaVersion: 1,
    technique: arg,
    sources: sourceIds.map((id) => sourceById.get(id)),
    learned,
    curated: curatedMatches,
    instruction: synthesisPrompt,
  };
  const safe = norm(arg).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "technique";
  const out = path.resolve(arg2 || path.join(knowledgeDir, `synthesis-${safe}.json`));
  fs.writeFileSync(out, JSON.stringify(packet, null, 2) + "\n");
  console.log(`exported synthesis packet: ${learned.length} learned + ${curatedMatches.length} curated -> ${out}`);
} else if (cmd === "import-synthesis") {
  if (!arg) throw new Error("usage: npm run motion:knowledge -- import-synthesis <synthesis.json> [--force]");
  const synthesis = validateSynthesis(readJson(path.resolve(arg)));
  fs.mkdirSync(synthesizedDir, { recursive: true });
  const out = path.join(synthesizedDir, `${synthesis.id}.json`);
  if (fs.existsSync(out) && !force) throw new Error(`${synthesis.id} already exists; pass --force to replace it`);
  fs.writeFileSync(out, JSON.stringify(synthesis, null, 2) + "\n");
  console.log(`imported ${synthesis.id} -> ${out}`);
} else {
  throw new Error("commands: status | validate | export-pending [out.jsonl] | import-analysis <file.json> [--force] | export-synthesis <technique> [out.json] | import-synthesis <file.json> [--force]");
}
