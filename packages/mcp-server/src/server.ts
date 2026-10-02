import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { diagnosticPortCandidates } from "./bridge/discovery.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { schemas } from "@engineroom/shared";
import { HttpClient } from "./bridge/httpClient.js";
import { WsClient } from "./bridge/wsClient.js";
import { WriteQueue, mergeWait, type QueueWait, type WriteLease } from "./bridge/writeQueue.js";
import { JobManager } from "./jobs/manager.js";
import { SnapshotStore } from "./snapshots/store.js";
import type { CompFingerprint } from "./snapshots/store.js";
import { descriptions } from "./tools/descriptions.js";
import { AeError, BridgeTimeoutError, BridgeUnreachableError, aeErrorText, invalidArgsText } from "./util/errors.js";
import { resolveRunJsxSource, type RunJsxArgs } from "./tools/runJsxSource.js";
import { checkSetup } from "./setup/check.js";
import { installPanel } from "./setup/install.js";
import { ClientKind, detectClient, scaffold } from "./setup/scaffold.js";
import { assessPanel, installedBundleHash, installedPanelHash, unknownOpMessage } from "./setup/panelVersion.js";
import { installedPanelDir, packageVersion, panelInstallDiff, panelSourceDir } from "./setup/paths.js";
import { renderWhatsNew } from "./tools/whatsNew.js";
import { GUIDES, PROMPTS, SERVER_INSTRUCTIONS, getGuide, getPrompt } from "./generated/content.js";
import { archiveIssue, listIssues, logIssue, markReported } from "./issues/journal.js";
import { JournalCache, annotateFailure } from "./issues/failures.js";
import { applyHouseStyleDetail } from "./style/summary.js";
import { imageContent } from "./util/pngImage.js";
import {
  GetMotionTechniqueSchema, ListMotionSourcesSchema, SearchMotionKnowledgeSchema,
  getMotionTechnique, listMotionSources, searchMotionKnowledge,
} from "./knowledge/motion.js";
import { logger } from "./util/logger.js";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const { OpSchemas } = schemas;

// ChatGPT Work is the primary client for this build. Keep its eager MCP surface
// deliberately small: every tool description + JSON schema in tools/list becomes
// model context before the first useful action. Hidden ops remain fully reachable
// through invoke_op (or run_batch for batch-safe writes), while describe_ops exposes
// their compact contracts lazily only when a task actually needs them. Set
// AE_MCP_TOOL_PROFILE=full for development/debugging clients that want the legacy
// one-tool-per-op surface.
const WORK_TOOL_NAMES = [
  "inspect_scene",
  "review_scene",
  "search_motion_knowledge",
  "get_motion_technique",
  "list_motion_sources",
  "find_layers",
  "run_batch",
  "await_job",
  "get_job",
  "cancel_job",
  "check_setup",
  "setup_panel",
] as const;

const WORK_DESCRIPTIONS: Record<string, string> = {
  inspect_scene: "High-level scene read: active comp + bounded layer map, with optional focused layer detail.",
  build_scene: "High-level scene builder. Create or duplicate layers, create Null/controllers, parent related layers so shared movement is animated once, and add masks/effects/keyframes/expressions in one MCP call.",
  modify_scene: "High-level bulk editor for existing layers, including parentLayerId, masks/effects/keyframes/expressions. Use parentLayerId to link existing layers to one controller when they share motion, instead of duplicating keyframes.",
  review_scene: "Phase-5 visual review: return one contact sheet plus compact structural context for visual analysis and correction.",
  search_motion_knowledge: "Find only the motion techniques relevant to the current task. Returns compact recipes first and source links as fallback.",
  get_motion_technique: "Read one motion recipe/source by id when search_motion_knowledge identifies it as useful.",
  list_motion_sources: "Browse the bundled lightweight YouTube training catalog by category, priority or analysis status.",
  get_project_summary: "Compact project orientation: active item and project items.",
  list_comps: "List comps. Prefer include:[] for id+name only.",
  get_comp: "Read one comp's dimensions/timing without its layer tree.",
  list_layers: "List layers in one comp. Prefer include:[] for id/index/name/type.",
  find_layers: "Find addressable layers by name/type/effect without dumping full comps.",
  get_layer_full: "Inspect one layer. Use include/maxKeyframes/shapeDepth to bound the result.",
  get_house_style: "Read the current project's visual/motion defaults; summary is the cheap default.",
  run_batch: "Primary write tool. Send many primitive AE ops in one call; use diff:true to verify structurally.",
  run_jsx: "Fallback for custom ExtendScript. Prefer scriptPath for long code; diff:true verifies changes.",
  screenshot_frame: "Visual verification. Prefer one contact sheet via times:[...] over repeated screenshots.",
  await_job: "Wait for a chunked batch to finish; this is the progress-bearing call.",
  get_job: "Read chunked-batch status without blocking.",
  cancel_job: "Stop a chunked batch at the next boundary.",
  check_setup: "Diagnose the AE bridge only when connection/setup is the problem.",
  setup_panel: "Install/refresh the AE panel when check_setup says it is missing or stale.",
  describe_ops: "Lazy primitive-op catalog. Ask only for the op names or category needed for the next action.",
  invoke_op: "Call any primitive or specialized AE operation returned by describe_ops without exposing the entire legacy tool surface up front.",
};

const DescribeOpsSchema = z.object({
  names: z.array(z.string()).min(1).max(24).optional(),
  category: z.enum([
    "read", "build", "animate", "effects", "footage", "audio", "text", "shape",
    "expressions", "markers", "vision", "style", "project", "diagnostics"
  ]).optional(),
}).refine((v) => !!v.names || !!v.category, { message: "Pass names or category." });

const InvokeOpSchema = z.object({
  op: z.string().min(1),
  args: z.record(z.string(), z.unknown()).default({}).optional(),
}).strict();

const WORK_OP_CATEGORIES: Record<string, string[]> = {
  read: ["get_project_summary", "list_comps", "get_comp", "get_comp_tree", "list_layers", "find_layers", "get_layer_full", "get_keyframes", "get_expression", "list_effects", "snapshot_comp", "diff_comp"],
  build: ["create_comp", "set_comp", "duplicate_comp", "create_text_layer", "create_shape_layer", "create_solid_layer", "create_null_layer", "create_adjustment_layer", "create_precomp_layer", "create_camera_layer", "create_light_layer", "duplicate_layer", "set_layer", "delete_layer", "parent_layer", "reorder_layer"],
  animate: ["set_transform", "add_keyframe", "remove_keyframe", "set_interpolation", "set_temporal_ease", "set_spatial_tangents"],
  effects: ["list_effects", "add_effect", "remove_effect", "set_effect_param", "set_effect_enabled", "list_available_effects"],
  footage: ["import_footage", "create_footage_layer", "purge_unused_footage"],
  audio: ["place_audio_cues"],
  text: ["create_text_layer", "set_text", "add_text_animator"],
  shape: ["create_shape_layer", "add_shape_content", "set_shape_path", "set_shape_property", "add_mask", "set_mask", "remove_mask"],
  expressions: ["get_expression", "set_expression", "toggle_expression", "clear_expression"],
  markers: ["add_marker", "remove_marker"],
  vision: ["screenshot_frame", "screenshot_layer"],
  style: ["get_house_style", "set_house_style"],
  project: ["create_comp", "set_comp", "delete_comp", "set_active_comp", "duplicate_comp", "import_footage", "create_footage_layer", "export_mogrt", "init_project"],
  diagnostics: ["check_setup", "setup_panel", "ae_guide", "log_issue", "list_known_issues", "mark_issue_reported", "archive_issue"],
};

// A batch calls an ExtendScript handler directly. Only ordinary bridge writes
// are safe there: reads are cheaper as top-level bounded reads, server tools do
// not exist in ExtendScript, and these specialized writes depend on outer
// Node/panel logic that a direct handler call would skip.
const BATCH_SPECIAL_OPS = new Set(["run_batch", "run_jsx", "export_mogrt"]);

export function isBatchSafeOp(name: string): boolean {
  if (!(name in OpSchemas) || BATCH_SPECIAL_OPS.has(name)) return false;
  return (schemas.OpMutation as Record<string, string | undefined>)[name] === "write";
}

function prepareBatchArgs(value: unknown, depth = 0): unknown {
  if (depth > 2) throw new Error("run_batch nesting is limited to 3 levels.");
  const batch = value as { ops: Array<{ op: string; args: unknown }> } & Record<string, unknown>;
  const prepared = batch.ops.map((step, index) => {
    if (step.op === "run_batch") {
      try {
        const inner = (OpSchemas.run_batch as z.ZodTypeAny).parse(step.args ?? {}) as { ops: unknown[]; singleUndo?: boolean };
        if (inner.ops.length > 500 && inner.singleUndo !== true) {
          throw new Error("a nested batch may not become asynchronous; keep it at 500 ops or fewer, or use singleUndo:true");
        }
        return { op: step.op, args: prepareBatchArgs(inner, depth + 1) };
      } catch (e) {
        throw new Error(`run_batch op[${index}] run_batch: ${invalidArgsText("run_batch", e)}`);
      }
    }
    if (!isBatchSafeOp(step.op)) {
      const reason = step.op in OpSchemas
        ? "it needs top-level/server processing or is not a write primitive"
        : "the op does not exist";
      throw new Error(`run_batch op[${index}] ${step.op}: not batch-safe — ${reason}. Call specialized tools at top level.`);
    }
    try {
      const schema = OpSchemas[step.op as keyof typeof OpSchemas] as z.ZodTypeAny;
      return { op: step.op, args: schema.parse(step.args ?? {}) };
    } catch (e) {
      throw new Error(`run_batch op[${index}] ${step.op}: ${invalidArgsText(step.op, e)}`);
    }
  });
  return { ...batch, ops: prepared };
}

const VecSchema = z.array(z.number()).min(2).max(3);
const Vec2Schema = z.tuple([z.number(), z.number()]);
const ColorSchema = z.array(z.number()).length(3);
const MaskSpecSchema = z.object({
  vertices: z.array(Vec2Schema).min(3),
  inTangents: z.array(Vec2Schema).optional(), outTangents: z.array(Vec2Schema).optional(),
  closed: z.boolean().default(true).optional(), mode: z.string().default("ADD").optional(),
  inverted: z.boolean().optional(), expansion: z.number().optional(), feather: Vec2Schema.optional(),
  opacity: z.number().min(0).max(100).optional(),
}).strict();
const KeyframeSpecSchema = z.object({
  propertyPath: schemas.PropertyPath, time: z.number(),
  value: schemas.VecAny, interpolation: schemas.Interpolation.optional(),
}).strict();
const ExpressionSpecSchema = z.object({
  propertyPath: schemas.PropertyPath, expression: z.string(),
}).strict();
const EffectParamSpecSchema = z.union([
  z.object({
    paramName: z.string(), paramMatchName: z.string().optional(),
    value: schemas.VecAny, time: z.number().optional(), keyframe: z.boolean().default(false).optional(),
  }).strict(),
  z.object({
    paramName: z.string().optional(), paramMatchName: z.string(),
    value: schemas.VecAny, time: z.number().optional(), keyframe: z.boolean().default(false).optional(),
  }).strict(),
]);
const EffectSpecSchema = z.object({
  matchName: z.string(), enabled: z.boolean().optional(),
  params: z.array(EffectParamSpecSchema).max(120).optional(),
}).strict();
const EffectChangeSchema = z.union([
  z.object({
    action: z.literal("add"), matchName: z.string(), enabled: z.boolean().optional(),
    params: z.array(EffectParamSpecSchema).max(120).optional(),
  }).strict(),
  z.object({
    action: z.literal("setParam"), effectIndex: z.number().int().positive(),
    paramName: z.string(), paramMatchName: z.string().optional(),
    value: schemas.VecAny, time: z.number().optional(), keyframe: z.boolean().default(false).optional(),
  }).strict(),
  z.object({
    action: z.literal("setParam"), effectIndex: z.number().int().positive(),
    paramName: z.string().optional(), paramMatchName: z.string(),
    value: schemas.VecAny, time: z.number().optional(), keyframe: z.boolean().default(false).optional(),
  }).strict(),
  z.object({
    action: z.literal("enable"), effectIndex: z.number().int().positive(), enabled: z.boolean(),
  }).strict(),
  z.object({
    action: z.literal("remove"), effectIndex: z.number().int().positive(),
  }).strict(),
]);
const TransformSpecSchema = z.object({
  position: VecSchema.optional(), scale: VecSchema.optional(), rotation: z.number().optional(),
  anchorPoint: VecSchema.optional(), opacity: z.number().min(0).max(100).optional(),
  orientation: z.array(z.number()).length(3).optional(), xRotation: z.number().optional(),
  yRotation: z.number().optional(), zRotation: z.number().optional(),
}).strict();

const BuildLayerSchema = z.object({
  kind: z.enum(["text", "shape", "solid", "null", "adjustment", "precomp", "camera", "light", "duplicate"]),
  sourceLayerId: z.number().optional(),
  name: z.string().optional(), text: z.string().optional(), font: z.string().optional(),
  size: z.number().positive().optional(), color: ColorSchema.optional(), tracking: z.number().optional(),
  anchorAlign: z.enum(["left", "center", "right", "none"]).optional(), position: VecSchema.optional(),
  shapes: z.array(z.record(z.string(), z.unknown())).optional(), fill: ColorSchema.optional(),
  stroke: ColorSchema.optional(), strokeWidth: z.number().nonnegative().optional(),
  width: z.number().int().positive().optional(), height: z.number().int().positive().optional(),
  duration: z.number().positive().optional(), sourceCompId: z.number().optional(), oneNode: z.boolean().optional(),
  lightType: z.enum(["parallel", "spot", "point", "ambient"]).optional(), intensity: z.number().optional(),
  threeDLayer: z.boolean().optional(), motionBlur: z.boolean().optional(), collapseTransformation: z.boolean().optional(),
  transform: TransformSpecSchema.optional(),
  parentLayerId: z.number().optional(), parentLayerIndex: z.number().int().min(0).optional(),
  preserveTransform: z.boolean().default(true).optional(),
  masks: z.array(MaskSpecSchema).max(40).optional(),
  effects: z.array(EffectSpecSchema).max(40).optional(),
  keyframes: z.array(KeyframeSpecSchema).max(300).optional(),
  expressions: z.array(ExpressionSpecSchema).max(80).optional(),
}).strict();

const InspectSceneSchema = z.object({
  compId: z.number().optional(),
  detail: z.enum(["summary", "focused", "full"]).default("summary").optional(),
  layerIds: z.array(z.number()).max(50).optional(),
  maxLayers: z.number().int().min(1).max(200).default(80).optional(),
  include: z.array(z.enum(["transform", "effects", "masks", "markers", "bounds", "text", "shape", "source"])).optional(),
  maxKeyframes: z.number().int().positive().max(200).default(12).optional(),
  shapeDepth: z.number().int().min(0).max(4).default(2).optional(),
}).strict();

const BuildSceneSchema = z.object({
  compId: z.number().optional(),
  comp: z.object({
    name: z.string().default("Untitled").optional(), width: z.number().int().positive().default(1920).optional(),
    height: z.number().int().positive().default(1080).optional(), frameRate: z.number().positive().default(30).optional(),
    duration: z.number().positive().default(5).optional(), pixelAspect: z.number().positive().default(1).optional(),
    bgColor: ColorSchema.optional(), motionBlur: z.boolean().optional(), shutterAngle: z.number().min(0).max(720).optional(),
    shutterPhase: z.number().optional(), activate: z.boolean().default(true).optional(),
  }).strict().optional(),
  layers: z.array(BuildLayerSchema).max(100).default([]),
  verify: z.boolean().default(true).optional(),
}).strict();

const MaskChangeSchema = z.object({
  maskIndex: z.number().int().positive().optional(), remove: z.boolean().default(false).optional(),
  vertices: z.array(Vec2Schema).min(3).optional(),
  inTangents: z.array(Vec2Schema).optional(), outTangents: z.array(Vec2Schema).optional(),
  closed: z.boolean().optional(), mode: z.string().optional(), inverted: z.boolean().optional(),
  expansion: z.number().optional(), feather: Vec2Schema.optional(), opacity: z.number().min(0).max(100).optional(),
}).strict();

const ModifyChangeSchema = z.object({
  layerId: z.number(),
  layer: z.object({
    name: z.string().optional(), enabled: z.boolean().optional(), locked: z.boolean().optional(),
    shy: z.boolean().optional(), solo: z.boolean().optional(), threeDLayer: z.boolean().optional(),
    motionBlur: z.boolean().optional(), collapseTransformation: z.boolean().optional(),
    blendingMode: z.string().optional(), label: z.number().int().min(0).max(16).optional(),
    inPoint: z.number().optional(), outPoint: z.number().optional(), startTime: z.number().optional(), stretch: z.number().optional(),
  }).strict().optional(),
  transform: TransformSpecSchema.optional(),
  text: z.object({
    text: z.string().optional(), font: z.string().optional(), size: z.number().positive().optional(),
    color: ColorSchema.optional(), tracking: z.number().optional(),
  }).strict().optional(),
  parentLayerId: z.number().nullable().optional(),
  masks: z.array(MaskChangeSchema).max(80).optional(),
  effects: z.array(EffectChangeSchema).max(120).optional(),
  keyframes: z.array(KeyframeSpecSchema).max(500).optional(),
  expressions: z.array(ExpressionSpecSchema).max(120).optional(),
  delete: z.boolean().default(false).optional(),
}).strict();

const ModifySceneSchema = z.object({
  compId: z.number(), changes: z.array(ModifyChangeSchema).min(1).max(200),
  transactional: z.boolean().default(true).optional(), verify: z.boolean().default(true).optional(),
}).strict();

const ReviewSceneSchema = z.object({
  compId: z.number().optional(),
  times: z.array(z.number()).min(2).max(6).optional(),
  sampling: z.enum(["auto", "motion", "uniform"]).default("auto").optional(),
  downsample: z.number().int().min(1).max(8).optional(),
  maxLayers: z.number().int().min(1).max(120).default(60).optional(),
}).strict();

const HIGH_LEVEL_SCHEMAS: Record<string, z.ZodTypeAny> = {
  inspect_scene: InspectSceneSchema, build_scene: BuildSceneSchema,
  modify_scene: ModifySceneSchema, review_scene: ReviewSceneSchema,
};

const SERVER_TOOL_SCHEMAS: Record<string, z.ZodTypeAny> = {
  search_motion_knowledge: SearchMotionKnowledgeSchema,
  get_motion_technique: GetMotionTechniqueSchema,
  list_motion_sources: ListMotionSourcesSchema,
};

function toolProfile(): "work" | "full" {
  return process.env.AE_MCP_TOOL_PROFILE === "full" ? "full" : "work";
}

const WORK_SERVER_INSTRUCTIONS =
  "Drive the live After Effects session with minimum context and minimum round-trips. " +
  "Prefer inspect_scene once. For ordinary scene edits, lazily request the build_scene or modify_scene contract with describe_ops, then call it through invoke_op; do not fall back to many primitive calls just because those high-level tools are lazy. " +
  "When multiple layers share the same movement, prefer a short parent/Null-controller hierarchy and animate the parent once instead of duplicating identical keyframes across children; keep only truly independent motion on the children. " +
  "For Phase-5 visual QA, use review_scene once, correct through the lazy modify_scene contract via describe_ops + invoke_op, then review once more only if needed. " +
  "For specialized motion work, call search_motion_knowledge only when technique guidance would improve the result; retrieve only the few matching recipes, never the whole catalog. " +
  "When a needed operation is not listed directly, call describe_ops for only that op/category, then use invoke_op for the returned contract. Use run_batch instead when batchSafe:true and several writes belong together. " +
  "Identify comps/layers by id, not shifting indexes. If AE cannot be reached, use check_setup.";

function compactSchema(node: any): any {
  if (Array.isArray(node)) return node.map(compactSchema);
  if (!node || typeof node !== "object") return node;
  const out: any = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "description" || key === "title" || key === "$schema" || key === "examples") continue;
    out[key] = compactSchema(value);
  }
  return out;
}

function conciseDescription(op: string): string {
  const short = WORK_DESCRIPTIONS[op];
  if (short) return short;
  const full = descriptions[op] ?? `AE op: ${op}`;
  const sentence = full.split(/(?<=[.!?])\s+/)[0] ?? full;
  return sentence.length <= 240 ? sentence : `${sentence.slice(0, 237)}...`;
}

// Ops whose handler returns metadata + base64 PNG and should be packaged as an MCP image content.
const VISION_OPS = new Set(["screenshot_frame", "screenshot_layer"]);
// Ops that may return an async jobId envelope from the panel.
const ASYNC_OPS = new Set(["run_batch"]);
// Jobs/await/etc. are handled in-server, not forwarded as-is. The setup ops
// especially must never touch the bridge — they exist precisely for the case
// where the panel is not installed yet, which is also when the issue journal is
// most likely to be written to.
export const SERVER_OPS = new Set([
  "await_job",
  "get_job",
  "cancel_job",
  "check_setup",
  "setup_panel",
  "init_project",
  "ae_guide",
  "log_issue",
  "list_known_issues",
  "mark_issue_reported",
  "archive_issue",
]);
// Half server-resident: only the panel can read After Effects, only the server
// can remember anything between calls. These forward an internal read op to
// gather a fingerprint and keep the result in `SnapshotStore` — they are not in
// SERVER_OPS, because unlike those they do touch the bridge.
const SNAPSHOT_OPS = new Set(["snapshot_comp", "diff_comp"]);

/**
 * True for an op that changes the After Effects session, from the one table
 * that is checked against `OpSchemas` at test time (`schemas.OpMutation`).
 *
 * A hand-kept list here would go stale the first time somebody added a tool,
 * and the failure would be silent — a new writing op classified by omission as
 * a read, interleaving with a batch. Anything this cannot classify is treated
 * as a write, which costs a little serialization and never costs correctness.
 */
export function isWriteOp(name: string): boolean {
  const effect = (schemas.OpMutation as Record<string, string | undefined>)[name];
  return effect === undefined ? true : effect === "write";
}

/**
 * `ae_guide` exists because the two better carriers are not universal. The
 * condensed core goes out in `instructions`, which some clients drop on the
 * floor; the full text is exposed as resources, which fewer clients support
 * still. Tools are the one thing every MCP client can reach, so the guidance has
 * to be available as one — otherwise a Cursor or Codex user gets 60-odd tools
 * and none of the knowledge that stops them being misused.
 */
const GUIDE_URI_PREFIX = "ae://guide/";

// Schema for await_job/get_job/cancel_job (defined inline in shared/schemas.ts).
const AwaitJobSchema = schemas.AwaitJob;
const GetJobSchema = schemas.GetJob;
const CancelJobSchema = schemas.CancelJob;

export interface CreateServerOptions {
  /**
   * The bridge client to use instead of one discovered from the environment.
   * A test hands in one pointed at a stale port with its own candidate list, so
   * the drift path can be exercised without asking anything real on the machine.
   */
  bridge?: HttpClient;
}

export function createServer(opts: CreateServerOptions = {}) {
  const server = new Server(
    { name: "after-effects-mcp", version: "0.5.0" },
    {
      capabilities: { tools: {}, logging: {}, prompts: {}, resources: {} },
      // Clients that honour this fold it into the system prompt, which is the
      // only way non-Claude clients get the cross-cutting guidance at all —
      // skills and slash commands do not exist outside Claude's own clients.
      instructions: toolProfile() === "work" ? WORK_SERVER_INSTRUCTIONS : SERVER_INSTRUCTIONS,
    }
  );

  const bridge = opts.bridge ?? new HttpClient();
  const jobs = new JobManager();
  // One writer at a time. See bridge/writeQueue.ts for why the panel's own
  // evalScript mutex is not enough.
  const writes = new WriteQueue();
  const snapshots = new SnapshotStore();
  // Follows the bridge's port rather than copying it: see wsClient.ts.
  const ws = new WsClient(bridge, jobs);
  ws.start();
  const panelGate = createPanelGate(bridge);

  // The issue journal, pushed rather than pulled: every failed tool call is
  // answered with the journal entries that match its tool and error text, so
  // the pointer arrives at the moment it is needed and nothing else in the
  // session pays for the journal's size (issue #102). `annotateFailure` never
  // throws and never touches the message when nothing matches — see
  // issues/failures.ts. The cache is per process, like `SnapshotStore`.
  const journalCache = new JournalCache();
  const fail = (tool: string, message: string) => errorResult(annotateFailure(journalCache, tool, message));

    // Best-effort health probe; non-fatal. A refusal here is the cheapest moment
  // to notice the port file was stale (issue #92): the search costs a couple
  // of seconds now, against a failed first op later.
  bridge.health().then(
    (h) => logger.info(`Bridge healthy on port ${h.port}`),
    async (e) => {
      logger.warn(`Bridge not reachable yet: ${(e as Error).message}`);
      if (!(e instanceof BridgeUnreachableError)) return;
      const located = await bridge.rediscover().catch(() => null);
      if (located?.found && located.found.port !== bridge.port) {
        await bridge.switchPort(located.found.port);
        logger.info(`Bridge healthy on port ${bridge.port}`);
      }
    }
  );

  // ---------- tools/list ----------
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    if (toolProfile() === "work") {
      const tools = WORK_TOOL_NAMES.map((name) => ({
        name,
        description: WORK_DESCRIPTIONS[name] ?? descriptions[name] ?? `AE op: ${name}`,
        inputSchema: compactSchema(toolInputSchema(name)) as any,
      }));
      tools.push({
        name: "describe_ops",
        description: WORK_DESCRIPTIONS.describe_ops,
        inputSchema: compactSchema(toDraft2020(zodToJsonSchema(DescribeOpsSchema, { target: "jsonSchema7", $refStrategy: "none" }))) as any,
      } as any);
      tools.push({
        name: "invoke_op",
        description: WORK_DESCRIPTIONS.invoke_op,
        inputSchema: compactSchema(toDraft2020(zodToJsonSchema(InvokeOpSchema, { target: "jsonSchema7", $refStrategy: "none" }))) as any,
      } as any);
      return { tools };
    }

    const tools = Object.keys(OpSchemas).map((name) => ({
      name,
      description: descriptions[name] ?? `AE op: ${name}`,
      inputSchema: toolInputSchema(name) as any,
    }));
    return { tools };
  });

  // ---------- prompts ----------
  // The portable form of a slash command. Claude Code gets the same three as
  // plugin commands; everywhere else this is the only way a user can invoke a
  // named flow, so the bodies live in one place and are generated into both.
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: PROMPTS.map((p) => ({
      name: p.name,
      description: p.description,
      arguments: p.argumentHint
        ? [{ name: "arguments", description: p.argumentHint, required: false }]
        : [],
    })),
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const prompt = getPrompt(req.params.name);
    if (!prompt) throw new Error(`Unknown prompt: ${req.params.name}`);
    const given = (req.params.arguments?.arguments as string | undefined) ?? "";
    return {
      description: prompt.description,
      messages: [
        {
          role: "user" as const,
          content: { type: "text" as const, text: prompt.body.replaceAll("$ARGUMENTS", given) },
        },
      ],
    };
  });

  // ---------- resources ----------
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: GUIDES.map((g) => ({
      uri: `${GUIDE_URI_PREFIX}${g.name}`,
      name: g.name,
      description: g.description,
      mimeType: "text/markdown",
    })),
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const uri = req.params.uri;
    const guide = uri.startsWith(GUIDE_URI_PREFIX)
      ? getGuide(uri.slice(GUIDE_URI_PREFIX.length))
      : undefined;
    if (!guide) throw new Error(`Unknown resource: ${uri}`);
    return { contents: [{ uri, mimeType: "text/markdown", text: guide.body }] };
  });

  // ---------- tools/call ----------
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    let name = req.params.name;
    let rawArgs = req.params.arguments ?? {};
    const progressToken = (req.params as any)?._meta?.progressToken as string | number | undefined;

    if (name === "invoke_op") {
      try {
        const invocation = InvokeOpSchema.parse(rawArgs);
        if (!(invocation.op in OpSchemas) && !(invocation.op in HIGH_LEVEL_SCHEMAS) && !(invocation.op in SERVER_TOOL_SCHEMAS)) {
          return errorResult(`Unknown AE op: ${invocation.op}`);
        }
        name = invocation.op;
        rawArgs = invocation.args ?? {};
      } catch (e) {
        return errorResult(invalidArgsText("invoke_op", e));
      }
    }

    if (name === "describe_ops") {
      try {
        const a = DescribeOpsSchema.parse(rawArgs);
        const requested = a.names ?? WORK_OP_CATEGORIES[a.category ?? ""] ?? [];
        const unique = [...new Set(requested)];
        const known = (op: string) => op in OpSchemas || op in HIGH_LEVEL_SCHEMAS || op in SERVER_TOOL_SCHEMAS;
        const unknown = unique.filter((op) => !known(op));
        if (unknown.length) return errorResult(`Unknown AE op(s): ${unknown.join(", ")}`);
        return textResult({
          ops: unique.map((op) => ({
            name: op,
            description: conciseDescription(op),
            batchSafe: op in OpSchemas ? isBatchSafeOp(op) : false,
            inputSchema: compactSchema(toolInputSchema(op)),
          })),
          usage: "Use run_batch for multiple ops with batchSafe:true. For any other op returned here, call invoke_op with that op name and arguments; specialized server/vision processing is preserved automatically.",
        });
      } catch (e) {
        return errorResult(invalidArgsText(name, e));
      }
    }

    if (name in HIGH_LEVEL_SCHEMAS) {
      try {
        const parsed = HIGH_LEVEL_SCHEMAS[name].parse(rawArgs);
        const stale = await panelGate.check();
        if (stale) return errorResult(stale);
        if (name === "inspect_scene") return textResult(await inspectScene(parsed, bridge));
        if (name === "review_scene") return await reviewScene(parsed, bridge);

        let sceneLease: WriteLease | null = null;
        try {
          sceneLease = await writes.acquire(name, extra?.signal);
          const result = name === "build_scene"
            ? await buildScene(parsed, bridge)
            : await modifyScene(parsed, bridge);
          return textResult(result, sceneLease.wait);
        } finally {
          sceneLease?.release();
        }
      } catch (e) {
        return fail(name, invalidArgsText(name, e));
      }
    }

    if (name in SERVER_TOOL_SCHEMAS) {
      try {
        if (name === "search_motion_knowledge") {
          const a = SearchMotionKnowledgeSchema.parse(rawArgs);
          return textResult({ query: a.query, results: searchMotionKnowledge(a) });
        }
        if (name === "get_motion_technique") {
          const a = GetMotionTechniqueSchema.parse(rawArgs);
          return textResult(getMotionTechnique(a.id));
        }
        if (name === "list_motion_sources") {
          const a = ListMotionSourcesSchema.parse(rawArgs);
          return textResult({ sources: listMotionSources(a) });
        }
      } catch (e) {
        return errorResult(invalidArgsText(name, e));
      }
    }

    if (!(name in OpSchemas) && !SERVER_OPS.has(name)) {
      return errorResult(`Unknown tool: ${name}`);
    }

    // Server-resident ops
    if (SERVER_OPS.has(name)) {
      try {
        if (name === "await_job") {
          const a = AwaitJobSchema.parse(rawArgs);
          // This is the one call that blocks for the job, so it is the one
          // call whose progress a client is still correlating while the job
          // runs — see forwardJobProgress for why run_batch cannot be.
          const forward = progressToken !== undefined ? forwardJobProgress(jobs, a.jobId, progressToken, extra) : null;
          try {
            const st = await jobs.waitFor(a.jobId, a.timeoutMs ?? 600_000);
            return textResult(st);
          } finally {
            // Unbind, then wait for every notification already started to
            // reach the transport. The response is written after this handler
            // returns, so nothing on this token can land behind it — on the
            // timeout path as much as on the success path.
            await forward?.settle();
          }
        }
        if (name === "get_job") {
          const a = GetJobSchema.parse(rawArgs);
          const st = jobs.get(a.jobId);
          return textResult(st ?? null);
        }
        if (name === "cancel_job") {
          const a = CancelJobSchema.parse(rawArgs);
          await bridge.cancel(a.jobId);
          jobs.cancel(a.jobId);
          return textResult({ ok: true });
        }
        // check_setup is told which port ops are going to, so it can say when
        // that disagrees with the port that answers — the state issue #92
        // lived in for a week with every check green.
        // check_setup asks the ports ops would ask, and then the ones a pin
        // keeps ops away from: a wrong AE_MCP_PORT must not hide the panel
        // answering on 7777, or the report sends the user to restart After
        // Effects for a panel that is fine (recipe 43). probeBridge dedups.
        const setupOpts = () => ({ opPort: bridge.port, candidates: [...bridge.candidates(), ...diagnosticPortCandidates()] });
        if (name === "check_setup") {
          return textResult(await checkSetup(setupOpts()));
        }
        if (name === "setup_panel") {
          const a = schemas.SetupPanel.parse(rawArgs);
          const installed = await installPanel({ enableDebugMode: a.enableDebugMode, force: a.force });
          // The panel on disk just changed; whatever was cached about the
          // running one is now the wrong half of the comparison.
          panelGate.invalidate();
          // Re-run the diagnostic so the agent sees the resulting state rather
          // than having to guess whether the install was sufficient.
          return textResult({ ...installed, setup: await checkSetup(setupOpts()) });
        }
        if (name === "init_project") {
          const a = schemas.InitProject.parse(rawArgs);
          const client: ClientKind =
            !a.client || a.client === "auto"
              ? detectClient(server.getClientVersion()?.name)
              : (a.client as ClientKind);
          return textResult(
            scaffold({
              dir: a.dir,
              name: a.name,
              client,
              withMcpConfig: a.withMcpConfig ?? false,
              roots: a.dir ? undefined : await clientRoots(server),
            })
          );
        }
        if (name === "ae_guide") {
          const a = schemas.AeGuide.parse(rawArgs);
          const guide = getGuide(a.topic);
          if (!guide) return errorResult(`Unknown guide topic: ${a.topic}`);
          // Markdown, not JSON: this is prose to be read, and JSON-escaping it
          // would hand the model a wall of \n.
          if (a.topic === "whats-new") {
            // The one topic with a shape a machine can filter — see
            // tools/whatsNew.ts. The version on the first line is the server's
            // own, read from package.json, because the guide cannot know it.
            const rendered = renderWhatsNew(guide.body, { since: a.since, serverVersion: packageVersion() });
            return { content: [{ type: "text" as const, text: rendered.text }] };
          }
          if (a.since !== undefined) {
            // Refused rather than ignored: a filter that silently did not apply
            // is the swallowed error this server refuses everywhere else.
            return errorResult(
              `\`since\` filters the whats-new topic only; the ${a.topic} topic has no release sections to filter. ` +
                `Call ae_guide({topic: "${a.topic}"}) without \`since\`, or ae_guide({topic: "whats-new", since: "${a.since}"}) for what changed.`
            );
          }
          return { content: [{ type: "text" as const, text: guide.body }] };
        }
        if (name === "log_issue") {
          const a = schemas.LogIssue.parse(rawArgs);
          // The project journal stays the default: an entry is about this
          // project's work unless the agent says it is about the tools.
          return textResult(logIssue({ ...a, scope: a.scope ?? "project" }));
        }
        if (name === "list_known_issues") {
          const a = schemas.ListKnownIssues.parse(rawArgs);
          return textResult(
            listIssues({
              status: a.status ?? "all",
              tool: a.tool,
              query: a.query,
              id: a.id,
              // Compact unless asked otherwise: the full corpus is thousands of
              // tokens that stay in the transcript for the rest of the session.
              detail: a.detail ?? "index",
              // Both journals by default — the whole point of the user one is
              // that a fresh project folder does not start ignorant.
              scope: a.scope ?? "all",
              limit: a.limit,
              // Hidden unless asked: an archived entry is one that stopped
              // biting, was superseded by a release, or was retired on purpose.
              includeArchived: a.includeArchived ?? false,
            })
          );
        }
        if (name === "mark_issue_reported") {
          const a = schemas.MarkIssueReported.parse(rawArgs);
          const entry = markReported(a.id, a.url);
          // The scope goes back too: a bare id can name an entry in either
          // journal, and the caller has to be able to say which one moved.
          return textResult({ ok: true, id: entry.id, scope: entry.scope, reported: true, issueUrl: entry.issueUrl });
        }
        if (name === "archive_issue") {
          const a = schemas.ArchiveIssue.parse(rawArgs);
          const entry = archiveIssue(a.id, a.reason);
          return textResult({
            ok: true,
            id: entry.id,
            scope: entry.scope,
            archived: true,
            reason: entry.archivedReason,
            archivedAt: entry.archivedAt,
            note: "The file is kept and can be reopened by a later log_issue with the same title or the same tool and error text.",
          });
        }
      } catch (e) {
        // A zod rejection here is the same class of thing as one below, and gets
        // the same prose treatment; `invalidArgsText` passes anything else
        // through unchanged.
        return fail(name, invalidArgsText(name, e));
      }
    }

    // Validate input against zod schema.
    let args: unknown;
    try {
      args = (OpSchemas[name as keyof typeof OpSchemas] as z.ZodTypeAny).parse(rawArgs);
    } catch (e) {
      return fail(name, invalidArgsText(name, e));
    }

    if (name === "run_batch") {
      try {
        args = prepareBatchArgs(args);
      } catch (e) {
        return fail(name, (e as Error).message);
      }
    }

    // run_jsx can take its script, and its helper libraries, from files rather
    // than from the conversation. The server reads them — see runJsxSource.ts;
    // the short version is that Claude Desktop's agent has no filesystem tools
    // and is exactly the client this saves the most context for.
    if (name === "run_jsx") {
      try {
        args = resolveRunJsxSource(args as RunJsxArgs);
      } catch (e) {
        return fail(name, (e as Error).message);
      }
    }

    // Refuse to forward to a panel that predates this server. Without this the
    // agent gets `Unknown op: …` for anything added since the panel was
    // installed and has no way to know an update is the fix.
    const staleness = await panelGate.check();
    if (staleness) return errorResult(staleness);

    // Serialize writes. Acquiring *before* runOp is what keeps the op timeout
    // honest: `AbortSignal.timeout` is created inside `runOp`, so the clock
    // starts when the call executes and not when it entered the queue. A queued
    // call that timed out having never run would report a bridge failure for a
    // bridge that was working, which is the one way this feature could make
    // things worse than they were.
    let lease: WriteLease | null = null;
    if (isWriteOp(name)) {
      try {
        lease = await writes.acquire(name, extra?.signal);
      } catch (e) {
        // Full, timed out in the queue, or cancelled — all three mean the call
        // never reached After Effects, and all three say so.
        return fail(name, (e as Error).message);
      }
    }
    const wait: QueueWait | null = lease?.wait ?? null;

    // Forward to panel.
    try {
      // Inside this try so the panel's own error mapping — timeouts, AeError,
      // the Unknown-op backstop — applies to the internal ops these forward.
      if (SNAPSHOT_OPS.has(name)) return await runSnapshotOp(name, args, bridge, snapshots);

      // The request's progressToken is deliberately not forwarded. The panel
      // does nothing with it — its WS `progress` events carry a jobId and no
      // token — and progress is delivered on `await_job`, never here; see
      // forwardJobProgress.
      const result = await bridge.runOp(name, args);

      // Async envelope handling for run_batch
      if (ASYNC_OPS.has(name) && isAsyncEnvelope(result)) {
        const env = result as {
          jobId: string; async: true; total: number;
          chunkSize?: number; undoStepsEstimate?: number;
          undoGroupName?: string; note?: string;
        };
        jobs.register(env.jobId, env.total);
        // No progress emitter is bound to this request, and that absence is
        // the fix for issue #82. This handler returns the envelope a few lines
        // down, and a `notifications/progress` sent on this request's token
        // after that response is one a spec-compliant client has already
        // stopped correlating — every message was on the wire and every real
        // client saw nothing. The call that can carry progress is the one
        // that blocks for the job, `await_job`; the note says so.
        //
        // This is the gap the panel's own mutex leaves, and the reason this
        // queue exists at all. `run_batch` handed back a jobId and the panel now
        // drives `_continue_job` chunk by chunk; each chunk is its own turn on
        // the panel's evalScript chain, so releasing the lock here would let the
        // next write land *between* two chunks. That is still wrong even now
        // that each chunk carries its own undo group (issue #69 removed the
        // group that used to span them): the batch is one thing the caller
        // asked for, and another write interleaved into the middle of it runs
        // out of the order it was issued in. Hold the lock until the job
        // reports done.
        //
        // `await_job` is server-resident and never takes this lock, so an agent
        // waiting on the job it queued behind cannot deadlock against it.
        //
        // `waitFor`'s own timeout has to sit at the queue's hold ceiling, not
        // below it — a shorter one here would release the lock mid-batch while
        // a writer that queued at the same moment was still waiting.
        lease?.extendUntil(jobs.waitFor(env.jobId, writes.holdCeilingMs));
        // The undo fields travel with the envelope because this is the only
        // message the agent sees before it starts describing the work to the
        // user; the measured count arrives much later, with the job's result.
        return textResult(
          {
            jobId: env.jobId,
            async: true,
            total: env.total,
            chunkSize: env.chunkSize,
            undoStepsEstimate: env.undoStepsEstimate,
            undoGroupName: env.undoGroupName,
            note: withProgressNote(env.note, env.jobId),
          },
          wait
        );
      }

      // An empty frame is reported, never shipped. The panel found every pixel
      // fully transparent, and the PNG that encodes that is the one decoders
      // reject with "could not process image" — so the useful answer is the
      // sentence, not the picture.
      if (VISION_OPS.has(name) && isEmptyFrameResult(result)) return textResult(result);

      // Vision: package as MCP image content
      if (VISION_OPS.has(name) && isVisionResult(result)) {
        const v = result as {
          width: number; height: number; fullWidth?: number; fullHeight?: number;
          downsample?: number; time: number; compId: number; layerId?: number;
          base64: string; bytes: number; warning?: string;
          converted?: boolean; sourceBitDepth?: number;
          // A contact sheet is the same image content block with a map of what
          // is in it. The per-tile record is the only thing that tells the agent
          // which cell is which time, and which cells are marked blocks rather
          // than frames.
          contactSheet?: boolean; cols?: number; rows?: number;
          cellWidth?: number; cellHeight?: number;
          tiles?: unknown[];
        };
        return imageContent(
          {
            width: v.width,
            height: v.height,
            fullWidth: v.fullWidth,
            fullHeight: v.fullHeight,
            downsample: v.downsample,
            time: v.time,
            compId: v.compId,
            layerId: v.layerId,
            bytes: v.bytes,
            // Present only when the project renders deeper than 8 bits per
            // channel and the panel re-encoded the frame so it would decode.
            converted: v.converted,
            sourceBitDepth: v.sourceBitDepth,
            // Surfaced when a requested downsample could not be applied, so the
            // agent knows it is looking at a full-resolution frame.
            warning: v.warning,
            // Present only for a `times` call. `tiles` is what makes the sheet
            // readable as data as well as a picture — cell rectangle, time and
            // status per tile, in the order they were asked for.
            contactSheet: v.contactSheet,
            cols: v.cols,
            rows: v.rows,
            cellWidth: v.cellWidth,
            cellHeight: v.cellHeight,
            tiles: v.tiles,
          },
          v.base64
        );
      }

      // The style guide is read over the bridge and summarised here: the panel
      // does not update itself, so a summariser shipped in the .jsx bundle would
      // answer `detail: "summary"` with the whole document until the user
      // reinstalled the panel and relaunched AE. See style/summary.ts.
      if (name === "get_house_style") {
        const detail = (args as { detail?: "summary" | "full" }).detail ?? "summary";
        return textResult(applyHouseStyleDetail(result, detail), wait);
      }

      return textResult(result, wait);
    } catch (e) {
      // Checked before BridgeUnreachableError because the remedies are
      // opposites: one says restart After Effects, the other says do not.
      // Every branch below goes through `fail`, so a failure the journal already
      // knows about arrives with its pointer attached — that is the push half of
      // the journal, and the error path is the only place it can live.
      if (e instanceof BridgeTimeoutError) return fail(name, e.message);
      if (e instanceof BridgeUnreachableError) return fail(name, e.message);
      if (e instanceof AeError) {
        // A failure the panel diagnosed itself — a stale render buffer, so far.
        // Those messages are already a complete instruction to the agent, and
        // "AE:" in front of one would read as After Effects having raised it.
        if (e.code) return fail(name, e.message);
        // The gate above should have caught this, but it depends on /health
        // reporting a hash. On a panel too old to do that, this is the backstop
        // — and it is unambiguous, since unknown tool names never get this far.
        if (/^Unknown op: /.test(e.message)) {
          panelGate.invalidate();
          return errorResult(unknownOpMessage(name));
        }
        // The line number on its own counts from something the caller cannot
        // see, so this prints the failing line's text where the handler could
        // map it, and says so plainly where it could not (issue #46).
        return fail(name, aeErrorText(e));
      }
      return fail(name, (e as Error).message);
    } finally {
      // No-op unless a lease was taken, and deferred by `extendUntil` when a
      // long batch is still running behind the envelope we just returned.
      lease?.release();
    }
  });

  return server;
}


async function inspectScene(raw: unknown, bridge: HttpClient) {
  const a = InspectSceneSchema.parse(raw);
  const scene = await bridge.runOp("_inspect_scene", {
    compId: a.compId,
    detail: a.detail ?? "summary",
    layerIds: a.layerIds,
    maxLayers: a.maxLayers ?? 80,
    include: a.include,
    maxKeyframes: a.maxKeyframes ?? 12,
    shapeDepth: a.shapeDepth ?? 2,
  }) as Record<string, unknown>;
  return {
    ...scene,
    idScope: "Composition/layer ids are stable only for the current After Effects process. Re-inspect after restarting AE or reopening a project before reusing ids.",
  };
}

function createOpForLayer(compId: number, layer: z.infer<typeof BuildLayerSchema>) {
  const position = layer.position ?? layer.transform?.position;
  switch (layer.kind) {
    case "text":
      return {
        op: "create_text_layer",
        args: {
          compId, text: layer.text ?? "", name: layer.name, font: layer.font,
          size: layer.size, color: layer.color, tracking: layer.tracking,
          anchorAlign: layer.anchorAlign, position,
        },
      };
    case "shape":
      return {
        op: "create_shape_layer",
        args: {
          compId, name: layer.name, shapes: layer.shapes ?? [], fill: layer.fill,
          stroke: layer.stroke, strokeWidth: layer.strokeWidth, position,
        },
      };
    case "solid":
      if (!layer.color) throw new Error(`Solid layer ${layer.name ? `\"${layer.name}\"` : ""} needs color.`);
      return { op: "create_solid_layer", args: { compId, name: layer.name, color: layer.color, width: layer.width, height: layer.height, duration: layer.duration } };
    case "null":
      return { op: "create_null_layer", args: { compId, name: layer.name } };
    case "adjustment":
      return { op: "create_adjustment_layer", args: { compId, name: layer.name } };
    case "precomp":
      if (layer.sourceCompId === undefined) throw new Error("A precomp layer needs sourceCompId.");
      return { op: "create_precomp_layer", args: { compId, sourceCompId: layer.sourceCompId, position } };
    case "camera":
      return { op: "create_camera_layer", args: { compId, name: layer.name, oneNode: layer.oneNode, position } };
    case "light":
      return { op: "create_light_layer", args: { compId, name: layer.name, lightType: layer.lightType, color: layer.color, intensity: layer.intensity, position } };
    case "duplicate":
      if (layer.sourceLayerId === undefined) throw new Error("A duplicate layer needs sourceLayerId.");
      return { op: "duplicate_layer", args: { compId, layerId: layer.sourceLayerId, count: 1 } };
  }
}

async function runInlineBatches(
  bridge: HttpClient,
  ops: Array<{ op: string; args: unknown }>,
  undoGroupName: string,
  transactional = true
): Promise<Array<Record<string, unknown>>> {
  const batches: Array<Record<string, unknown>> = [];
  for (let offset = 0; offset < ops.length; offset += 450) {
    const chunk = ops.slice(offset, offset + 450);
    const prepared = prepareBatchArgs({ ops: chunk, transactional, undoGroupName: ops.length > 450 ? `${undoGroupName} ${Math.floor(offset / 450) + 1}` : undoGroupName });
    const result = await bridge.runOp("run_batch", prepared);
    if (isAsyncEnvelope(result)) throw new Error("Internal scene batch unexpectedly became asynchronous; reduce the scene batch size.");
    batches.push(result as Record<string, unknown>);
  }
  return batches;
}

async function buildScene(raw: unknown, bridge: HttpClient) {
  const a = BuildSceneSchema.parse(raw);
  if (a.compId === undefined && !a.comp) {
    throw new Error("build_scene needs either compId (existing comp) or comp (create a new comp).");
  }
  let compId = a.compId;
  let compCreated: unknown = null;
  if (compId === undefined) {
    const compArgs = (OpSchemas.create_comp as z.ZodTypeAny).parse({
      name: a.comp?.name, width: a.comp?.width, height: a.comp?.height,
      frameRate: a.comp?.frameRate, duration: a.comp?.duration,
      pixelAspect: a.comp?.pixelAspect, bgColor: a.comp?.bgColor,
    });
    compCreated = await bridge.runOp("create_comp", compArgs);
    compId = Number((compCreated as { id?: unknown })?.id);
    if (!Number.isFinite(compId)) throw new Error("create_comp did not return a comp id.");
    if (a.comp?.activate !== false) await bridge.runOp("set_active_comp", { compId });
  }

  const before = a.verify !== false && a.compId !== undefined
    ? await bridge.runOp("_comp_fingerprint", { compId })
    : null;
  const createOps = a.layers.map((layer) => createOpForLayer(compId!, layer));
  const createBatches = createOps.length
    ? await runInlineBatches(bridge, createOps, "AE AI: build scene", true)
    : [];
  const rawCreated = createBatches.flatMap((batch) => Array.isArray(batch.results) ? batch.results as unknown[] : []);
  if (rawCreated.length !== a.layers.length) {
    throw new Error(`build_scene created ${rawCreated.length} layer result(s) for ${a.layers.length} requested layer(s). Read the comp before retrying.`);
  }
  const created = rawCreated.map((entry, i) => {
    const value = a.layers[i].kind === "duplicate"
      ? (Array.isArray(entry) && entry.length === 1 ? entry[0] : null)
      : entry;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`build_scene layer ${i} returned an unexpected creation result. Read the comp before retrying.`);
    }
    return value as Record<string, unknown>;
  });

  const postOps: Array<{ op: string; args: unknown }> = [];
  let maskCount = 0;
  let effectCount = 0;
  for (let i = 0; i < created.length; i++) {
    const layerId = Number(created[i].id);
    if (!Number.isFinite(layerId)) throw new Error(`build_scene layer ${i} did not return an id.`);
    const spec = a.layers[i];
    // New AE layers spawn at index 1. Reorder by id so the declarative array is
    // front-to-back instead of silently ending up reversed.
    postOps.push({ op: "reorder_layer", args: { compId, layerId, toIndex: i + 1 } });
    if (spec.kind === "duplicate" && spec.name !== undefined) {
      postOps.push({ op: "set_layer", args: { compId, layerId, name: spec.name } });
    }
    if (spec.threeDLayer !== undefined) postOps.push({ op: "set_layer", args: { compId, layerId, threeDLayer: spec.threeDLayer } });
    if (spec.transform || spec.position) {
      const properties = { ...(spec.transform ?? {}) } as Record<string, unknown>;
      const createHandlesPosition = ["text", "shape", "precomp", "camera", "light"].includes(spec.kind);
      if (createHandlesPosition && (spec.position || spec.transform?.position)) delete properties.position;
      if (!createHandlesPosition && spec.position && properties.position === undefined) properties.position = spec.position;
      if (Object.keys(properties).length) postOps.push({ op: "set_transform", args: { compId, layerId, properties } });
    }
    if (spec.parentLayerId !== undefined && spec.parentLayerIndex !== undefined) {
      throw new Error(`build_scene layer ${i}: pass parentLayerId or parentLayerIndex, not both.`);
    }
    let parentLayerId = spec.parentLayerId;
    if (spec.parentLayerIndex !== undefined) {
      if (spec.parentLayerIndex >= created.length || spec.parentLayerIndex === i) {
        throw new Error(`build_scene layer ${i}: parentLayerIndex ${spec.parentLayerIndex} is invalid.`);
      }
      parentLayerId = Number(created[spec.parentLayerIndex].id);
      if (!Number.isFinite(parentLayerId)) throw new Error(`build_scene layer ${i}: parent layer did not return an id.`);
    }
    if (parentLayerId !== undefined) {
      postOps.push({ op: "parent_layer", args: { compId, layerId, parentLayerId, preserveTransform: spec.preserveTransform ?? true } });
    }
    for (const mask of spec.masks ?? []) {
      postOps.push({ op: "add_mask", args: { compId, layerId, ...mask } });
      maskCount += 1;
    }
    for (const effect of spec.effects ?? []) {
      postOps.push({ op: "add_effect", args: { compId, layerId, ...effect } });
      effectCount += 1;
    }
    for (const key of spec.keyframes ?? []) {
      postOps.push({ op: "add_keyframe", args: { compId, layerId, ...key } });
    }
    for (const expression of spec.expressions ?? []) {
      postOps.push({ op: "set_expression", args: { compId, layerId, ...expression } });
    }
  }
  const postBatches = postOps.length ? await runInlineBatches(bridge, postOps, "AE AI: configure scene", true) : [];

  let diff: unknown = undefined;
  if (before) {
    const verified = await bridge.runOp("_comp_diff", { compId, since: before });
    diff = (verified as { diff?: unknown })?.diff;
  }
  const createdRefs = created.map((entry, i) => ({
    id: Number(entry.id),
    kind: a.layers[i].kind,
    name: a.layers[i].name ?? (typeof entry.name === "string" ? entry.name : undefined),
    ...(a.layers[i].kind === "duplicate" ? { sourceLayerId: a.layers[i].sourceLayerId } : {}),
  }));
  return {
    ok: true, compId, compCreated, created: createdRefs,
    layerCount: createdRefs.length,
    maskCount,
    effectCount,
    batches: createBatches.length + postBatches.length,
    diff,
    note: "The `layers` array is treated front-to-back. `duplicate` layers accept sourceLayerId; parentLayerIndex is zero-based into this same array. Masks, effects, keyframes and expressions are configured inside this one MCP call.",
  };
}

async function modifyScene(raw: unknown, bridge: HttpClient) {
  const a = ModifySceneSchema.parse(raw);
  const before = a.verify !== false ? await bridge.runOp("_comp_fingerprint", { compId: a.compId }) : null;
  const ops: Array<{ op: string; args: unknown }> = [];
  let addedMasks = 0;
  for (const change of a.changes) {
    const hasOther = !!(
      change.layer || change.transform || change.text || change.parentLayerId !== undefined ||
      change.masks?.length || change.effects?.length || change.keyframes?.length || change.expressions?.length
    );
    if (change.delete) {
      if (hasOther) throw new Error(`Layer ${change.layerId}: delete cannot be combined with other changes in the same entry.`);
      ops.push({ op: "delete_layer", args: { compId: a.compId, layerId: change.layerId } });
      continue;
    }
    if (change.layer) ops.push({ op: "set_layer", args: { compId: a.compId, layerId: change.layerId, ...change.layer } });
    if (change.parentLayerId !== undefined) {
      ops.push({ op: "parent_layer", args: { compId: a.compId, layerId: change.layerId, parentLayerId: change.parentLayerId, preserveTransform: true } });
    }
    if (change.transform) ops.push({ op: "set_transform", args: { compId: a.compId, layerId: change.layerId, properties: change.transform } });
    if (change.text) {
      const { color, ...text } = change.text as typeof change.text & { color?: number[] };
      ops.push({ op: "set_text", args: { compId: a.compId, layerId: change.layerId, ...text, fillColor: color } });
    }
    for (const mask of change.masks ?? []) {
      if (mask.remove) {
        if (mask.maskIndex === undefined) throw new Error(`Layer ${change.layerId}: removing a mask needs maskIndex.`);
        ops.push({ op: "remove_mask", args: { compId: a.compId, layerId: change.layerId, maskIndex: mask.maskIndex } });
        continue;
      }
      if (mask.maskIndex === undefined) {
        if (!mask.vertices) throw new Error(`Layer ${change.layerId}: adding a mask needs vertices.`);
        const { maskIndex: _maskIndex, remove: _remove, ...add } = mask;
        ops.push({ op: "add_mask", args: { compId: a.compId, layerId: change.layerId, ...add } });
        addedMasks += 1;
        continue;
      }
      const { remove: _remove, ...updates } = mask;
      ops.push({ op: "set_mask", args: { compId: a.compId, layerId: change.layerId, ...updates } });
    }
    for (const effect of change.effects ?? []) {
      if (effect.action === "add") {
        const { action: _action, ...add } = effect;
        ops.push({ op: "add_effect", args: { compId: a.compId, layerId: change.layerId, ...add } });
      } else if (effect.action === "setParam") {
        const { action: _action, ...param } = effect;
        ops.push({ op: "set_effect_param", args: { compId: a.compId, layerId: change.layerId, ...param } });
      } else if (effect.action === "enable") {
        ops.push({ op: "set_effect_enabled", args: { compId: a.compId, layerId: change.layerId, effectIndex: effect.effectIndex, enabled: effect.enabled } });
      } else if (effect.action === "remove") {
        ops.push({ op: "remove_effect", args: { compId: a.compId, layerId: change.layerId, effectIndex: effect.effectIndex } });
      }
    }
    for (const key of change.keyframes ?? []) {
      ops.push({ op: "add_keyframe", args: { compId: a.compId, layerId: change.layerId, ...key } });
    }
    for (const expression of change.expressions ?? []) {
      ops.push({ op: "set_expression", args: { compId: a.compId, layerId: change.layerId, ...expression } });
    }
  }
  if (!ops.length) throw new Error("modify_scene produced no changes.");
  const batches = await runInlineBatches(bridge, ops, "AE AI: modify scene", a.transactional !== false);
  let diff: unknown = undefined;
  if (before) {
    const verified = await bridge.runOp("_comp_diff", { compId: a.compId, since: before });
    diff = (verified as { diff?: unknown })?.diff;
  }
  return {
    ok: true, compId: a.compId, changes: a.changes.length,
    primitiveOps: ops.length, addedMasks, batches: batches.length, diff,
  };
}

interface MotionMapResult {
  compId: number;
  duration: number;
  frameRate: number;
  workAreaStart: number;
  workAreaDuration: number;
  animatedLayerCount: number;
  expressionLayerCount: number;
  totalKeyframes: number;
  keyTimes: number[];
  keyTimeCount: number;
  keyTimesOmitted: number;
  markerTimes: number[];
  animatedLayers: Array<{
    id: number; name: string; type: string; keyframeCount: number;
    expressionCount: number; properties: Array<{ name: string; keys: number }>;
  }>;
  covers: string;
}

function uniqueReviewTimes(values: number[], start: number, end: number, frame: number): number[] {
  const out: number[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    if (!Number.isFinite(raw)) continue;
    const clamped = Math.min(end, Math.max(start, raw));
    // Frame precision is enough for a screenshot and avoids 0.999999/1.0 pairs.
    const t = Math.round(clamped / frame) * frame;
    const key = t.toFixed(6);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out.sort((a, b) => a - b);
}

function reduceReviewTimes(values: number[], limit = 6): number[] {
  if (values.length <= limit) return values;
  const picked: number[] = [];
  for (let i = 0; i < limit; i++) {
    const idx = Math.round((i * (values.length - 1)) / (limit - 1));
    picked.push(values[idx]);
  }
  return [...new Set(picked)];
}

function uniformReviewTimes(start: number, end: number, frame: number): number[] {
  if (end <= start + frame / 2) return [start];
  const span = end - start;
  return uniqueReviewTimes([start, start + span / 3, start + (span * 2) / 3, end], start, end, frame);
}

function motionAwareReviewTimes(motion: MotionMapResult, start: number, end: number, frame: number): number[] {
  const keys = uniqueReviewTimes([...(motion.keyTimes ?? []), ...(motion.markerTimes ?? [])], start, end, frame);
  if (!keys.length) return uniformReviewTimes(start, end, frame);

  const candidates: number[] = [];
  const first = keys[0];
  const last = keys[keys.length - 1];
  // Show the state immediately before/at an isolated event where possible.
  if (first > start + frame) candidates.push(Math.max(start, first - frame));
  candidates.push(first);
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i];
    const b = keys[i + 1];
    if (b - a > frame * 1.5) candidates.push(a + (b - a) / 2);
    candidates.push(b);
  }
  // One hold-state frame after the animated range helps reveal whether an exit
  // or final composition breaks after motion has finished, without spending a
  // slot on a distant static end for every animation.
  if (last < end - frame) candidates.push(Math.min(end, last + frame));
  const compact = uniqueReviewTimes(candidates, start, end, frame);
  return reduceReviewTimes(compact, 6);
}

async function reviewScene(raw: unknown, bridge: HttpClient) {
  const a = ReviewSceneSchema.parse(raw);
  const scene = await bridge.runOp("_inspect_scene", {
    compId: a.compId,
    detail: "summary",
    maxLayers: a.maxLayers ?? 60,
    includeMotion: true,
    motionMaxTimes: 120,
  }) as {
    compId: number; comp: Record<string, unknown>; layers: Array<Record<string, unknown>>;
    layerCount: number; layersOmitted: number; motion: MotionMapResult;
  };
  const compId = scene.compId;
  const comp = scene.comp;
  const motion = scene.motion;
  const allLayers = scene.layers ?? [];
  const duration = Math.max(0, Number(comp.duration ?? motion.duration ?? 0));
  const frameRate = Math.max(1, Number(comp.frameRate ?? motion.frameRate ?? 30));
  const frame = 1 / frameRate;
  const workStart = Math.max(0, Number(comp.workAreaStart ?? motion.workAreaStart ?? 0));
  const workDuration = Math.max(0, Number(comp.workAreaDuration ?? motion.workAreaDuration ?? duration));
  const end = Math.max(workStart, Math.min(duration, workStart + workDuration) - frame);

  let times = a.times;
  let samplingMode: "explicit" | "motion" | "uniform" = "explicit";
  let samplingReason = "Times were supplied by the caller.";
  if (!times) {
    const requested = a.sampling ?? "auto";
    const hasMotionSignal = motion.totalKeyframes > 0 || motion.markerTimes?.length > 0;
    if (requested === "motion" || (requested === "auto" && hasMotionSignal)) {
      times = motionAwareReviewTimes(motion, workStart, end, frame);
      samplingMode = hasMotionSignal ? "motion" : "uniform";
      samplingReason = hasMotionSignal
        ? `Placed frames around ${motion.totalKeyframes} keyframe(s) across ${motion.animatedLayerCount} animated layer(s), plus comp markers.`
        : "No keyframe/marker times were found, so motion sampling fell back to uniform frames.";
    } else {
      times = uniformReviewTimes(workStart, end, frame);
      samplingMode = "uniform";
      samplingReason = requested === "uniform"
        ? "Uniform sampling was explicitly requested."
        : (motion.expressionLayerCount > 0
            ? `No discrete key times were found, but ${motion.expressionLayerCount} layer(s) use expressions; uniform samples are safer for continuous motion.`
            : "No discrete motion signal was found; sampled the work area uniformly.");
    }
  }
  times = uniqueReviewTimes(times ?? [workStart], workStart, end, frame);
  if (times.length > 6) times = reduceReviewTimes(times, 6);

  const shotArgs = times.length >= 2
    ? { compId, times, downsample: a.downsample }
    : { compId, time: times[0] ?? workStart, downsample: a.downsample };
  const visual = await bridge.runOp("screenshot_frame", shotArgs);
  const context = {
    phase: 5,
    purpose: "visual review",
    compId,
    comp,
    idScope: "Composition/layer ids are stable only for the current After Effects process. Omit compId to review the active comp after an AE restart.",
    sampling: {
      mode: samplingMode,
      times,
      reason: samplingReason,
      motion: {
        animatedLayerCount: motion.animatedLayerCount,
        expressionLayerCount: motion.expressionLayerCount,
        totalKeyframes: motion.totalKeyframes,
        keyTimeCount: motion.keyTimeCount,
        keyTimesOmitted: motion.keyTimesOmitted,
        animatedLayers: motion.animatedLayers.slice(0, 24),
        animatedLayersOmitted: Math.max(0, motion.animatedLayers.length - 24),
        covers: motion.covers,
      },
    },
    layers: allLayers,
    layerCount: scene.layerCount,
    layersOmitted: scene.layersOmitted,
    instruction: "Analyze the image/contact sheet for hierarchy, spacing, clipping, alignment, consistency and motion continuity. Use the sampling metadata to distinguish a genuinely static scene from a missed animation. Correct concrete issues with modify_scene; use primitive tools only when the high-level editor cannot express the fix.",
  };
  if (isEmptyFrameResult(visual)) return textResult({ ...context, visual });
  if (!isVisionResult(visual)) return textResult({ ...context, visual });
  const v = visual as Record<string, unknown> & { base64: string };
  const { base64, ...visualMeta } = v;
  return {
    content: [
      { type: "text" as const, text: JSON.stringify({ ...context, visual: visualMeta }) },
      { type: "image" as const, data: base64, mimeType: "image/png" },
    ],
  };
}

/**
 * Forward a job's progress to the request that is waiting on it, as
 * `notifications/progress` on that request's own token.
 *
 * Bound by `await_job` and by nothing else. `run_batch` has answered with its
 * `{jobId}` envelope before the first chunk runs, and a notification sent on a
 * request's token after that request's response is one a spec-compliant client
 * has already stopped listening for — the SDK client drops its progress
 * handler the moment the response arrives. Until 0.5.0 every progress message
 * for a long batch went out that way: plainly visible on the raw wire, and
 * seen by no real client at all (issue #82).
 *
 * `extra.sendNotification` is the SDK's request-scoped sender, and it is used
 * on purpose over `server.notification`: it tags each message with the request
 * id, so a Streamable HTTP transport delivers it on that request's own stream,
 * and it silently drops anything sent after the request has been cancelled.
 *
 * `settle()` unbinds first and then waits for every send already started. The
 * SDK writes the response after the handler returns, so awaiting this before
 * returning is what puts every notification ahead of the response on the wire
 * — on the timeout path, where the emitter would otherwise outlive the call,
 * as much as on the success path.
 */
function forwardJobProgress(
  jobs: JobManager,
  jobId: string,
  progressToken: string | number,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>
) {
  const inFlight = new Set<Promise<void>>();
  const unbind = jobs.bindProgressEmitter(jobId, (_jid, progress, total, message) => {
    const p = extra
      .sendNotification({ method: "notifications/progress", params: { progressToken, progress, total, message } })
      .catch((e) => logger.warn(`progress notification for job ${jobId} was not sent: ${(e as Error).message}`));
    inFlight.add(p);
    void p.finally(() => inFlight.delete(p));
  });
  return {
    async settle(): Promise<void> {
      unbind();
      await Promise.all(inFlight);
    },
  };
}

/**
 * The sentence on a long batch's envelope that says where its progress goes.
 *
 * Appended here rather than written in `batch.jsx`, because it describes this
 * server and not After Effects: the panel does not update itself, and a note
 * authored there would go on describing whatever the server did when that
 * panel was installed.
 */
function withProgressNote(note: string | undefined, jobId: string): string {
  const progress =
    `Follow it with await_job({jobId: "${jobId}"}), which blocks until the batch finishes and returns its result. ` +
    `Progress is delivered on THAT call: send it with a progressToken and notifications/progress arrive while it ` +
    `waits, every one before its response. None can ride on this run_batch call — its response is already back ` +
    `before the first chunk runs. get_job({jobId: "${jobId}"}) reads the same state without a token.`;
  return note ? `${note} ${progress}` : progress;
}

/**
 * `snapshot_comp` and `diff_comp`.
 *
 * The split is the point: the panel gathers a fingerprint because only it can
 * read After Effects, and the server keeps it because a snapshot must not be
 * written into the user's project (see snapshots/store.ts). Neither tool sends
 * the fingerprint back unless asked — returning it by default would reintroduce
 * exactly the context cost the snapshot exists to avoid, since a tool result is
 * re-sent on every later request for the rest of the session.
 */
async function runSnapshotOp(
  name: string,
  args: unknown,
  bridge: HttpClient,
  snapshots: SnapshotStore
) {
  if (name === "snapshot_comp") {
    const a = args as { compId: number; includeFingerprint?: boolean };
    const fingerprint = (await bridge.runOp("_comp_fingerprint", { compId: a.compId })) as CompFingerprint;
    const snap = snapshots.store(fingerprint);
    return textResult({
      snapshotId: snap.id,
      compId: snap.compId,
      compName: snap.compName,
      layers: snap.layerCount,
      takenAt: new Date(snap.takenAt).toISOString(),
      next: `Do the work, then diff_comp({ since: "${snap.id}" }).`,
      lifetime:
        "Held in this MCP server's memory for the length of the session, not written into the After Effects project.",
      covers: SNAPSHOT_COVERS,
      fingerprint: a.includeFingerprint ? fingerprint : undefined,
    });
  }

  const d = args as { since: string; compId?: number; includeFingerprint?: boolean };
  const previous = snapshots.get(d.since);
  if (!previous) return errorResult(snapshots.missingMessage(d.since));
  if (d.compId !== undefined && d.compId !== previous.compId) {
    return errorResult(
      `Snapshot ${d.since} is of comp ${previous.compId} ("${previous.compName}"), not comp ${d.compId}. ` +
        `A diff only means anything against a snapshot of the same comp — omit compId, or snapshot_comp(${d.compId}) first.`
    );
  }
  const res = (await bridge.runOp("_comp_diff", {
    compId: previous.compId,
    since: previous.fingerprint,
  })) as { diff: Record<string, unknown>; fingerprint: CompFingerprint };
  // The fresh fingerprint becomes a snapshot of its own, so a verify-as-you-go
  // loop can keep diffing forward without a second call per step.
  const next = snapshots.store(res.fingerprint);
  return textResult({
    ...res.diff,
    since: d.since,
    snapshotId: next.id,
    fingerprint: d.includeFingerprint ? res.fingerprint : undefined,
  });
}

/**
 * What a snapshot is and is not, quoted back on every one taken. A diff can
 * only report a field it records, so "no differences" has to be readable as
 * "none of these moved" and never as "identical" — the same rule that makes
 * every other scoped read here name what it left out.
 */
const SNAPSHOT_COVERS =
  "Records layer id/name/index/type, in/out/start, parent, enabled, keyframe counts, expression count and " +
  "effect count, plus comp size/duration/frame rate/work area/markers. Property values, expression text, " +
  "effect parameters and shape contents are not recorded.";

/**
 * Caches the panel-version verdict so it costs one /health per session rather
 * than one per tool call.
 *
 * Only a *stale* verdict is remembered indefinitely — that state cannot resolve
 * itself without a restart of After Effects, which drops the bridge and clears
 * the cache anyway. A healthy verdict is re-checked periodically so a panel that
 * gets replaced mid-session is noticed. An unreachable bridge caches nothing:
 * that is `runOp`'s error to report, with a much better message than this.
 */
function createPanelGate(bridge: HttpClient) {
  const RECHECK_MS = 60_000;
  let verdict: string | null = null;
  let checkedAt = 0;

  // A verdict is about the panel on one port. When the bridge moves, whatever
  // was decided about the old one — stale or healthy — says nothing about the
  // panel now answering, so the next call has to ask again.
  bridge.onPortChange(() => {
    verdict = null;
    checkedAt = 0;
  });

  return {
    /** The message to return instead of forwarding, or null to proceed. */
    async check(): Promise<string | null> {
      if (verdict !== null) return verdict;
      if (Date.now() - checkedAt < RECHECK_MS) return null;
      try {
        const health = await bridge.health();
        // The gate is what every failed call quotes, so it has to know whether
        // the files on disk are internally consistent. Without this it tells the
        // user to restart After Effects for a half-updated install, which no
        // number of restarts can resolve.
        const installed = installedPanelDir();
        const source = panelSourceDir();
        const assessment = assessPanel(health.bundleHash, installedBundleHash(installed), {
          installComplete: source ? panelInstallDiff(source, installed).length === 0 : undefined,
          runningPanelHash: health.panelHash,
          installedPanelHash: installedPanelHash(installed),
        });
        checkedAt = Date.now();
        verdict = assessment.state === "current" || assessment.state === "unknown" ? null : assessment.message;
        // "unknown" covers a panel too old to report a hash. Its message is a
        // warning rather than a certainty, so it is logged, not enforced — the
        // Unknown-op backstop catches it the moment it actually matters.
        if (assessment.state === "unknown" && assessment.message) logger.warn(assessment.message);
        return verdict;
      } catch {
        return null;
      }
    },
    invalidate() {
      verdict = null;
      checkedAt = 0;
    },
  };
}

/**
 * Folders the client says it is working in, best first.
 *
 * Only some clients declare the `roots` capability, and asking one that has not
 * declared it is a protocol error rather than an empty answer — so check first,
 * and treat any failure as "no roots" instead of failing the scaffold. The
 * caller has a further fallback after this one.
 */
async function clientRoots(server: Server): Promise<string[] | undefined> {
  if (!server.getClientCapabilities()?.roots) return undefined;
  try {
    const { roots } = await server.listRoots();
    return roots
      .map((r) => r.uri)
      .filter((uri) => uri.startsWith("file://"))
      .map((uri) => fileURLToPath(uri));
  } catch (e) {
    logger.warn(`Client advertised roots but listing them failed: ${(e as Error).message}`);
    return undefined;
  }
}

/**
 * `wait` is present only when the call actually sat in the write queue, so the
 * ordinary result is byte-identical to what it has always been.
 *
 * It is folded into the result object where there is one — which is every
 * writing op but `run_jsx`, whose result is whatever the caller's script
 * returned. Arrays and bare numbers get a second text block instead: rewrapping
 * them would change what every existing caller reads, and #43 is the standing
 * reminder that changing what a `run_jsx` answer looks like is expensive.
 * Vision results never come through here with a wait — screenshots are reads
 * and are never queued — so the image envelope cannot be touched by this.
 */
function textResult(value: unknown, wait?: QueueWait | null) {
  const json = (v: unknown) => ({
    type: "text" as const,
    text: JSON.stringify(v, null, toolProfile() === "work" ? 0 : 2),
  });
  if (!wait) return { content: [json(value)] };
  const merged = mergeWait(value, wait);
  if (merged) return { content: [json(merged)] };
  return { content: [json(value), json(wait)] };
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

/** The dialect these schemas are, and the one the Anthropic API reads them as. */
export const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";

// Rewrite a JSON Schema (draft-07 output from zod-to-json-schema) into draft 2020-12.
// The Anthropic API validates tool input_schema against draft 2020-12, which rejects
// the draft-07 tuple form `{ type: "array", items: [<schemas>] }` — that shape is
// only valid in 2020-12 as `prefixItems`, with `items` (singular) covering trailing
// positions. We also drop the legacy `additionalItems` keyword (renamed to `items`).
//
// The `$schema` rewrite is part of the same correction and not cosmetic.
// zod-to-json-schema stamps the draft-07 URI, which after this pass is a false
// claim: `prefixItems` does not exist in draft-07, and `items: false` means
// something else entirely there ("no array items at all"). A consumer that
// honoured the declared dialect would reject every tuple in these schemas —
// every colour, every 2D point. It works today only because the API reads tool
// schemas as 2020-12 whatever they say about themselves. Saying so makes the
// document self-describing and lets a validator check what actually ships.
function toDraft2020(node: any): any {
  if (Array.isArray(node)) return node.map(toDraft2020);
  if (!node || typeof node !== "object") return node;
  const out: any = {};
  for (const k of Object.keys(node)) out[k] = toDraft2020(node[k]);
  if (out.type === "array" && Array.isArray(out.items)) {
    out.prefixItems = out.items;
    if ("additionalItems" in out) {
      out.items = out.additionalItems;
      delete out.additionalItems;
    } else {
      out.items = false;
    }
  }
  if (typeof out.$schema === "string") out.$schema = JSON_SCHEMA_DIALECT;
  return out;
}

/**
 * Put a schema's cross-field rules — "exactly one of these three" — into the
 * JSON Schema the model is shown.
 *
 * `zod-to-json-schema` drops refinements, so without this pass the rule exists
 * only on the server and the only way to learn it is to break it. See the
 * cross-field section of `schemas.ts` for the vocabulary; the shapes injected
 * are `oneOf` / `anyOf` / `not` over `required`, which is plain composition and
 * valid in every draft.
 *
 * **Nothing is injected silently, and nothing here throws.** The enforcement
 * point for a rule that cannot be surfaced is `tests/unit/schema-constraints.mjs`,
 * which fails the build. At runtime this logs and carries on, for the same
 * reason `isWriteOp()` falls back to `"write"` rather than raising: `tools/list`
 * is the one call every session begins with, so a throw here would replace one
 * under-specified tool with *no tools at all*. Fail the build loudly; fail the
 * session towards the behaviour that shipped before.
 */
function withCrossFieldConstraints(zodSchema: unknown, jsonSchema: any, opName: string): any {
  for (const { path, rule } of schemas.crossFieldRulesIn(zodSchema)) {
    const where = path.join(".") || "(root)";
    if (!rule) {
      logger.warn(
        `${opName} carries a refinement at ${where} that is not a declared cross-field rule. ` +
          `It is enforced on every call and absent from the schema the model is shown, so an agent ` +
          `can only learn it by having a call rejected. Declare it with crossField() in ` +
          `packages/shared/src/schemas.ts.`
      );
      continue;
    }
    let node = jsonSchema;
    for (const step of path) {
      node = step === schemas.ARRAY_ELEMENT ? node?.items : node?.properties?.[step];
      if (!node || typeof node !== "object") break;
    }
    if (!node || typeof node !== "object") {
      logger.warn(
        `${opName}: the cross-field rule at ${where} has no matching node in the emitted JSON ` +
          `Schema, so it ships enforced but invisible.`
      );
      continue;
    }
    const fragment = schemas.crossFieldJsonSchema(rule);
    // Merge only where nothing is being overwritten; anything else goes under
    // `allOf`, which composes without either rule losing.
    const collides = Object.keys(fragment).some((k) => k in node);
    if (collides) (node.allOf ??= []).push(fragment);
    else Object.assign(node, fragment);
  }
  return jsonSchema;
}

/**
 * The `inputSchema` one tool ships with. Exported so
 * `tests/unit/schema-constraints.mjs` validates the exact document the client
 * receives rather than a reconstruction of it.
 */
export function toolInputSchema(opName: string): Record<string, unknown> {
  const schema = HIGH_LEVEL_SCHEMAS[opName] ?? SERVER_TOOL_SCHEMAS[opName] ?? (OpSchemas[opName as keyof typeof OpSchemas] as z.ZodTypeAny);
  if (!schema) throw new Error(`No schema for tool ${opName}`);
  const jsonSchema = withCrossFieldConstraints(
    schema,
    toDraft2020(zodToJsonSchema(schema, { target: "jsonSchema7", $refStrategy: "none" })),
    opName
  );
  // build_scene intentionally lives in this server rather than shared/schemas.
  // Its one cross-field rule is still surfaced to the model: either address an
  // existing comp or describe a new one. Keeping this in JSON Schema avoids a
  // hidden refinement that can only be learned by failing a call.
  if (opName === "build_scene") {
    (jsonSchema as any).anyOf = [{ required: ["compId"] }, { required: ["comp"] }];
  }
  return jsonSchema;
}

function isAsyncEnvelope(v: unknown): boolean {
  return !!(v && typeof v === "object" && "async" in v && (v as any).async === true && "jobId" in v);
}
function isVisionResult(v: unknown): boolean {
  return !!(v && typeof v === "object" && "base64" in v && "width" in v);
}
function isEmptyFrameResult(v: unknown): boolean {
  return !!(v && typeof v === "object" && (v as { empty?: unknown }).empty === true && !("base64" in v));
}
