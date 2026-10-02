import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import { MOTION_CURATED, MOTION_RECIPES, MOTION_SOURCES, MOTION_SYNTHESIZED } from "../generated/motionKnowledge.js";

export const SearchMotionKnowledgeSchema = z.object({
  query: z.string().min(2).max(300),
  limit: z.number().int().min(1).max(8).default(4).optional(),
  includeSources: z.boolean().default(true).optional(),
}).strict();

export const GetMotionTechniqueSchema = z.object({
  id: z.string().min(1),
}).strict();

export const ListMotionSourcesSchema = z.object({
  category: z.string().optional(),
  priority: z.enum(["core", "frequent", "advanced", "specialized", "production"]).optional(),
  status: z.enum(["all", "pending", "analyzed"]).default("all").optional(),
  limit: z.number().int().min(1).max(200).default(50).optional(),
}).strict();

type AnyRecord = Record<string, any>;

function norm(v: unknown): string {
  return String(v ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function terms(v: unknown): string[] {
  return norm(v).split(/[^a-z0-9]+/).filter((x) => x.length > 1);
}
function externalRecipes(): AnyRecord[] {
  const configured = process.env.AE_AI_MOTION_KNOWLEDGE_DIR;
  const supportRoot = process.platform === "win32"
    ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "AE AI")
    : path.join(os.homedir(), "Library", "Application Support", "AE AI");
  const dir = configured || path.join(supportRoot, "motion-knowledge", "recipes");
  if (!fs.existsSync(dir)) return [];
  const out: AnyRecord[] = [];
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(".json")).slice(0, 2000)) {
    try {
      const value = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
      if (value && typeof value === "object" && value.sourceId) out.push(value);
    } catch {}
  }
  return out;
}

function allRecipes(): AnyRecord[] {
  const merged = new Map<string, AnyRecord>();
  for (const r of MOTION_RECIPES as readonly AnyRecord[]) merged.set(r.sourceId, r);
  for (const r of externalRecipes()) merged.set(r.sourceId, r);
  return [...merged.values()];
}

function curatedRecipes(): AnyRecord[] {
  return [...(MOTION_CURATED as readonly AnyRecord[])];
}

function synthesizedRecipes(): AnyRecord[] {
  return [...(MOTION_SYNTHESIZED as readonly AnyRecord[])];
}

function scoreText(query: string, candidate: AnyRecord): number {
  const q = [...new Set(terms(query))];
  const hay = norm([
    candidate.id, candidate.sourceId, candidate.title, candidate.summary, candidate.category, candidate.technique,
    ...(candidate.tags || []), ...(candidate.techniques || []), ...(candidate.reusableRecipe || []),
    ...(candidate.decisionRules || []), ...(candidate.procedure || []), ...(candidate.qualityChecks || []),
    ...(candidate.consensus || []).map((x: AnyRecord) => x.rule),
    ...(candidate.alternatives || []).map((x: AnyRecord) => `${x.when || ""} ${x.use || ""}`),
    ...(candidate.conflicts || []).map((x: AnyRecord) => `${x.topic || ""} ${x.resolution || ""}`),
    candidate.purpose,
  ].join(" "));
  let score = 0;
  let matched = 0;
  for (const token of q) {
    if (hay.includes(token)) {
      matched += 1;
      score += token.length >= 6 ? 3 : 1;
    }
  }
  // A long query should not retrieve a technique merely because it shares one
  // generic word such as "camera" or "animation".
  if (q.length >= 3 && matched < 2) return 0;
  return score;
}
export function searchMotionKnowledge(input: z.infer<typeof SearchMotionKnowledgeSchema>) {
  const limit = input.limit ?? 4;
  const learned = allRecipes();
  const analyzedIds = new Set(learned.map((r) => r.sourceId).filter(Boolean));
  const ranked = (kind: string, item: AnyRecord, boost: number) => {
    const relevance = scoreText(input.query, item);
    return { kind, score: relevance > 0 ? relevance + boost : 0, item };
  };
  const curated = curatedRecipes().map((r) => ranked("curated", r, 0.3));
  const synthesized = synthesizedRecipes().map((r) => ranked("synthesized", r, 0.2));
  const recipes = learned.map((r) => ranked("recipe", r, 0.1));
  const sources = input.includeSources === false ? [] : (MOTION_SOURCES as readonly AnyRecord[])
    .filter((s) => !analyzedIds.has(s.id))
    .map((s) => ranked("source", s, 0));
  return [...curated, ...synthesized, ...recipes, ...sources]
    .filter((x) => x.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const rank: Record<string, number> = { curated: 0, synthesized: 1, recipe: 2, source: 3 };
      return (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9);
    })
    .slice(0, limit)
    .map(({ kind, score, item }) => kind === "source"
      ? { kind, score, id: item.id, title: item.title, category: item.category, priority: item.priority, tags: item.tags, purpose: item.purpose, url: item.url, analysisStatus: item.analysisStatus }
      : { kind, score, id: item.id || item.sourceId, title: item.title, technique: item.technique, summary: item.summary, techniques: item.techniques, decisionRules: item.decisionRules, consensus: item.consensus, alternatives: item.alternatives, conflicts: item.conflicts, procedure: item.procedure, reusableRecipe: item.reusableRecipe, qualityChecks: item.qualityChecks, failureModes: item.failureModes, sourceIds: item.sourceIds, curatedIds: item.curatedIds, confidence: item.confidence, origin: item.origin || "learned" });
}

export function getMotionTechnique(id: string) {
  const curated = curatedRecipes().find((r) => r.id === id);
  if (curated) return { kind: "curated", ...curated };
  const synthesized = synthesizedRecipes().find((r) => r.id === id);
  if (synthesized) return { kind: "synthesized", ...synthesized };
  const recipe = allRecipes().find((r) => r.sourceId === id || r.id === id);
  if (recipe) return { kind: "recipe", ...recipe };
  const source = (MOTION_SOURCES as readonly AnyRecord[]).find((s) => s.id === id);
  return source ? { kind: "source", ...source } : null;
}

export function listMotionSources(input: z.infer<typeof ListMotionSourcesSchema>) {
  const analyzed = new Set(allRecipes().map((r) => r.sourceId));
  return (MOTION_SOURCES as readonly AnyRecord[])
    .filter((s) => !input.category || s.category === input.category)
    .filter((s) => !input.priority || s.priority === input.priority)
    .filter((s) => input.status === "all" || !input.status || (input.status === "analyzed" ? analyzed.has(s.id) : !analyzed.has(s.id)))
    .slice(0, input.limit ?? 50)
    .map((s) => ({ ...s, analysisStatus: analyzed.has(s.id) ? "analyzed" : "pending" }));
}
