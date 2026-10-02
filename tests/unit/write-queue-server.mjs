// The write queue as the agent actually meets it: through tools/call.
//
// tests/unit/write-queue.mjs covers the queue itself. This one covers the
// wiring, which is the half that would fail silently — a `wait` not threaded to
// one of the three return sites, or `acquire` called on the wrong side of the
// panel gate, leaves the queue working perfectly and reporting nothing.
//
// It drives the real MCP server over an in-memory transport against a stub
// bridge on an ephemeral port. There is no After Effects here and none is
// needed: everything asserted is server-side.
//
//   node tests/unit/write-queue-server.mjs

import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = (...p) =>
  pathToFileURL(path.join(root, "packages", "mcp-server", "dist", ...p)).href;

const { sourceBundleHash, sourcePanelHash } = await import(dist("setup", "panelVersion.js"));

// ---------------------------------------------------------------------------
// Stub bridge. Never port 7777 — a real panel may hold that on this machine.
// ---------------------------------------------------------------------------

/** op -> how long the stub takes, and what it answers. */
const behaviour = new Map();
/** Every op the stub saw, with the moment it entered and left. */
const seen = [];

const bridge = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.setHeader("content-type", "application/json");
    // Report the hash this server ships so the panel-version gate is a no-op
    // rather than a variable of whatever is installed on the test machine.
    res.end(JSON.stringify({ ok: true, port: 0, bundleLoaded: true, bundleHash: sourceBundleHash(), panelHash: sourcePanelHash() }));
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    const parsed = JSON.parse(body || "{}");
    const { op, args } = parsed;
    const b = behaviour.get(op) ?? { ms: 5, result: { ok: true, op } };
    const entry = { op, args, enteredAt: Date.now() };
    seen.push(entry);
    await new Promise((r) => setTimeout(r, b.ms));
    entry.leftAt = Date.now();
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, result: b.result }));
  });
});
const wss = new WebSocketServer({ server: bridge, path: "/events" });
await new Promise((r) => bridge.listen(0, "127.0.0.1", r));
const port = bridge.address().port;
assert.notEqual(port, 7777, "must not bind the panel's port");
process.env.AE_MCP_PORT = String(port);

// Imported only after AE_MCP_PORT is set: HttpClient resolves the port in its
// constructor, which runs inside createServer().
const { createServer } = await import(dist("server.js"));
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const server = createServer();
const client = new Client({ name: "write-queue-test", version: "0" }, { capabilities: {} });
const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
}
async function call(name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  if (res.isError) throw new Error(`${name} failed: ${res.content[0]?.text}`);
  return res;
}
const payload = (res, i = 0) => JSON.parse(res.content[i].text);
const overlapped = (a, b) => {
  const x = seen.find((s) => s.op === a);
  const y = seen.find((s) => s.op === b);
  return x.enteredAt < y.leftAt && y.enteredAt < x.leftAt;
};

// ---------------------------------------------------------------------------

await check("two concurrent writes reach the bridge one at a time", async () => {
  seen.length = 0;
  behaviour.set("set_transform", { ms: 120, result: { ok: true, which: "set_transform" } });
  behaviour.set("add_keyframe", { ms: 5, result: { ok: true, which: "add_keyframe" } });

  const [first, second] = await Promise.all([
    call("set_transform", { compId: 1, layerId: 1, properties: { opacity: 50 } }),
    call("add_keyframe", { compId: 1, layerId: 1, propertyPath: ["Position"], time: 0, value: [0, 0] }),
  ]);

  assert.deepEqual(seen.map((s) => s.op), ["set_transform", "add_keyframe"]);
  assert.equal(overlapped("set_transform", "add_keyframe"), false, "the two writes overlapped at the bridge");

  // The one that went straight through says nothing about the queue…
  const a = payload(first);
  assert.equal("queuedBehind" in a, false);
  assert.equal("waitedMs" in a, false);
  // …and the one that waited names what it waited behind.
  const b = payload(second);
  assert.equal(b.queuedBehind, "set_transform");
  assert.ok(b.waitedMs >= 80, `waitedMs was ${b.waitedMs}`);
  assert.equal(b.which, "add_keyframe", "the op's own result must survive the annotation");
});

await check("a read issued behind a slow write is not made to wait for it", async () => {
  seen.length = 0;
  behaviour.set("run_jsx", { ms: 150, result: { ok: true } });
  behaviour.set("list_comps", { ms: 5, result: [] });

  const [, read] = await Promise.all([
    call("run_jsx", { code: "return 1" }),
    call("list_comps", {}),
  ]);

  assert.equal(overlapped("run_jsx", "list_comps"), true, "the read should have run during the write");
  // A read never queues, so it never carries a queue note.
  assert.equal(read.content.length, 1);
  assert.deepEqual(payload(read), []);
});

await check("a run_jsx result that is not an object keeps its shape", async () => {
  // #43's lesson: what a run_jsx answer looks like is load-bearing. An array
  // cannot absorb the queue note, so it arrives as a second content block and
  // the first block is byte-for-byte what it would have been.
  seen.length = 0;
  behaviour.set("set_text", { ms: 120, result: { ok: true } });
  behaviour.set("run_jsx", { ms: 5, result: ["a", "b"] });

  const [, jsx] = await Promise.all([
    call("set_text", { compId: 1, layerId: 1, text: "x" }),
    call("run_jsx", { code: "return ['a','b']" }),
  ]);

  assert.equal(jsx.content.length, 2, "the note must not be folded into an array");
  assert.deepEqual(payload(jsx, 0), ["a", "b"]);
  assert.equal(payload(jsx, 1).queuedBehind, "set_text");
});

await check("an uncontended write is byte-identical to what it always was", async () => {
  seen.length = 0;
  behaviour.set("create_comp", { ms: 5, result: { id: 42, name: "t" } });
  const res = await call("create_comp", { name: "t", width: 1920, height: 1080, frameRate: 30, duration: 5 });
  assert.equal(res.content.length, 1);
  assert.deepEqual(payload(res), { id: 42, name: "t" });
});

await check("a long batch holds the queue until the job finishes", async () => {
  // The gap the panel's own evalScript mutex leaves, and the whole reason for
  // this queue: run_batch answers with a jobId and the panel goes on driving
  // _continue_job in the background. A write let through here would land in the
  // middle of the batch, out of the order the agent issued it in.
  seen.length = 0;
  behaviour.set("run_batch", {
    ms: 5,
    result: {
      jobId: "j_test_1", async: true, total: 600,
      chunkSize: 25, undoStepsEstimate: 24, undoGroupName: "AE MCP Batch",
      note: "about 24 undo steps, NOT one",
    },
  });
  behaviour.set("set_layer", { ms: 5, result: { ok: true } });

  const batch = await call("run_batch", { ops: [{ op: "create_null_layer", args: { compId: 1 } }] });
  // The undo fields have to survive the envelope: this is the only message the
  // agent sees before it starts telling the user how to undo the work.
  const { note, ...env } = payload(batch);
  assert.deepEqual(env, {
    jobId: "j_test_1", async: true, total: 600,
    chunkSize: 25, undoStepsEstimate: 24, undoGroupName: "AE MCP Batch",
  });
  // The panel's note survives too, with the server's own sentence about where
  // progress goes appended — tests/unit/job-progress.mjs covers that sentence.
  assert.ok(note.startsWith("about 24 undo steps, NOT one "), note);

  let landed = false;
  const queued = call("set_layer", { compId: 1, layerId: 1, name: "n" }).then((r) => { landed = true; return r; });

  await new Promise((r) => setTimeout(r, 120));
  assert.equal(landed, false, "a write reached the bridge while the batch was still running");
  assert.equal(seen.some((s) => s.op === "set_layer"), false);

  // What the panel broadcasts over /events when the batch finishes.
  for (const ws of wss.clients) ws.send(JSON.stringify({ type: "complete", jobId: "j_test_1", result: { results: [] } }));

  const res = await queued;
  assert.equal(payload(res).queuedBehind, "run_batch");
  assert.ok(payload(res).waitedMs >= 100);
});

await check("await_job does not deadlock against the batch holding the lock", async () => {
  seen.length = 0;
  behaviour.set("run_batch", { ms: 5, result: { jobId: "j_test_2", async: true, total: 600 } });
  await call("run_batch", { ops: [{ op: "create_null_layer", args: { compId: 1 } }] });

  // await_job is server-resident: it takes no lease, so it can still be
  // answered while the batch's lease is held. If it queued, this would hang.
  const awaited = call("await_job", { jobId: "j_test_2", timeoutMs: 5000 });
  await new Promise((r) => setTimeout(r, 50));
  for (const ws of wss.clients) ws.send(JSON.stringify({ type: "complete", jobId: "j_test_2", result: { results: [1] } }));

  const state = payload(await awaited);
  assert.equal(state.status, "completed");
});

await check("a singleUndo batch releases the queue when its call returns", async () => {
  // singleUndo runs the whole batch inside one evalScript, so it answers with a
  // result and never with a jobId. The lease has to be released by the call's
  // own `finally`; extending it here would park the queue on a job that will
  // never complete, and every write for the rest of the session would wait out
  // the hold ceiling. There is no async envelope to detect, so the guard is
  // that the *next* write answers at all.
  seen.length = 0;
  behaviour.set("run_batch", {
    ms: 20,
    result: { results: [], errors: [], total: 600, undoSteps: 1, undoGroupName: "All at once" },
  });
  behaviour.set("set_layer", { ms: 5, result: { ok: true } });

  const batch = await call("run_batch", {
    ops: [{ op: "create_null_layer", args: { compId: 1 } }],
    singleUndo: true,
  });
  assert.equal(payload(batch).undoSteps, 1);

  const after = await Promise.race([
    call("set_layer", { compId: 1, layerId: 1, name: "n" }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("the write after a singleUndo batch never ran — the lease was not released")), 3000)
    ),
  ]);
  assert.equal(payload(after).ok, true);
  assert.equal(seen.map((s) => s.op).join(","), "run_batch,set_layer");
});


await check("compact tool surface stays small without removing capability", async () => {
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name);
  for (const name of ["inspect_scene", "review_scene", "describe_ops", "invoke_op"]) {
    assert.ok(names.includes(name), `${name} missing from compact tools/list`);
  }
  assert.ok(names.length <= 14, `compact tools/list unexpectedly grew to ${names.length} tools`);
  for (const hidden of ["build_scene", "modify_scene", "export_mogrt", "run_jsx", "screenshot_frame", "list_comps"]) {
    assert.equal(names.includes(hidden), false, `${hidden} should stay lazy behind invoke_op`);
  }
});

await check("describe_ops exposes lazy high-level and specialized operations", async () => {
  const high = payload(await call("describe_ops", { names: ["build_scene", "modify_scene"] }));
  assert.deepEqual(high.ops.map((op) => op.name), ["build_scene", "modify_scene"]);
  assert.ok(high.ops.every((op) => op.batchSafe === false));
  assert.ok(high.ops.every((op) => op.inputSchema && typeof op.inputSchema === "object"));

  const res = await call("describe_ops", { category: "project" });
  const catalog = payload(res);
  const mogrt = catalog.ops.find((op) => op.name === "export_mogrt");
  const create = catalog.ops.find((op) => op.name === "create_comp");
  assert.equal(mogrt.batchSafe, false);
  assert.equal(create.batchSafe, true);
  assert.match(catalog.usage, /batchSafe:true/);
  assert.match(catalog.usage, /invoke_op/);
});

await check("invoke_op reaches hidden operations through the normal validation and queue path", async () => {
  seen.length = 0;
  behaviour.set("set_layer", { ms: 5, result: { ok: true, renamed: true } });
  const res = await call("invoke_op", { op: "set_layer", args: { compId: 1, layerId: 1, name: "via invoke_op" } });
  assert.equal(payload(res).renamed, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].op, "set_layer");
  assert.equal(seen[0].args.name, "via invoke_op");
});

await check("run_batch validates every inner op before the bridge", async () => {
  seen.length = 0;
  const invalid = await client.callTool({
    name: "run_batch",
    arguments: { ops: [{ op: "set_transform", args: {} }] },
  });
  assert.equal(invalid.isError, true);
  assert.match(invalid.content[0].text, /op\[0\].*set_transform/i);
  assert.equal(seen.length, 0, "invalid batch reached the panel");

  const specialized = await client.callTool({
    name: "run_batch",
    arguments: { ops: [{ op: "export_mogrt", args: { compId: 1, path: "/tmp/x.mogrt" } }] },
  });
  assert.equal(specialized.isError, true);
  assert.match(specialized.content[0].text, /not batch-safe/);
  assert.equal(seen.length, 0, "specialized op reached the panel through run_batch");
});

await check("inspect_scene uses one structural bridge read", async () => {
  seen.length = 0;
  behaviour.set("_inspect_scene", { ms: 1, result: {
    compId: 7,
    comp: { id: 7, name: "Main", width: 1080, height: 1920, duration: 10, frameRate: 30 },
    layerCount: 1,
    layersOmitted: 0,
    layers: [{ id: 11, index: 1, name: "Title", sourceType: "text" }],
    detail: "summary",
  } });
  const res = await call("inspect_scene", {});
  const scene = payload(res);
  assert.equal(scene.compId, 7);
  assert.equal(scene.layerCount, 1);
  assert.equal(scene.layers[0].id, 11);
  assert.deepEqual(seen.map((x) => x.op), ["_inspect_scene"], "inspect_scene regressed to multiple bridge reads");
});

await check("build_scene can duplicate, parent, mask and animate layers in one MCP call", async () => {
  seen.length = 0;
  behaviour.set("run_batch", {
    ms: 1,
    result: { results: [[{ id: 71, name: "Copy" }], { id: 72, name: "CTRL" }], errors: [], total: 2, undoSteps: 1 },
  });
  const res = await call("build_scene", {
    compId: 7,
    verify: false,
    layers: [
      {
        kind: "duplicate",
        sourceLayerId: 11,
        name: "FG",
        threeDLayer: true,
        transform: { scale: [120, 120, 120] },
        parentLayerIndex: 1,
        masks: [{
          vertices: [[0, 0], [100, 0], [100, 100], [0, 100]],
          expansion: 2,
        }],
        effects: [{
          matchName: "ADBE Gaussian Blur 2",
          params: [{ paramMatchName: "ADBE Gaussian Blur 2-0001", value: 12 }],
        }],
        keyframes: [
          { propertyPath: ["Transform", "Position"], time: 0, value: [100, 100, 0] },
          { propertyPath: ["Transform", "Position"], time: 1, value: [120, 100, -50] },
        ],
        expressions: [
          { propertyPath: ["Transform", "Opacity"], expression: "100" },
        ],
      },
      { kind: "null", name: "CTRL" },
    ],
  });

  const result = payload(res);
  assert.equal(result.layerCount, 2);
  assert.equal(result.maskCount, 1);
  assert.equal(result.effectCount, 1);
  assert.deepEqual(result.created[0], { id: 71, kind: "duplicate", name: "FG", sourceLayerId: 11 });
  assert.equal("threeDLayer" in result.created[0], false, "created summary must not claim stale pre-configuration flags");

  const batches = seen.filter((x) => x.op === "run_batch");
  assert.equal(batches.length, 2);
  assert.deepEqual(batches[0].args.ops.map((x) => x.op), ["duplicate_layer", "create_null_layer"]);
  const configured = batches[1].args.ops;
  assert.ok(configured.some((x) => x.op === "set_layer" && x.args.layerId === 71 && x.args.name === "FG"));
  assert.ok(configured.some((x) => x.op === "set_layer" && x.args.layerId === 71 && x.args.threeDLayer === true));
  assert.ok(configured.some((x) => x.op === "parent_layer" && x.args.layerId === 71 && x.args.parentLayerId === 72));
  const addedMask = configured.find((x) => x.op === "add_mask");
  assert.ok(addedMask, "build_scene did not batch add_mask");
  assert.equal(addedMask.args.layerId, 71);
  assert.equal(addedMask.args.expansion, 2);
  assert.deepEqual(addedMask.args.vertices, [[0, 0], [100, 0], [100, 100], [0, 100]]);
  const addedEffect = configured.find((x) => x.op === "add_effect");
  assert.ok(addedEffect, "build_scene did not batch add_effect");
  assert.equal(addedEffect.args.matchName, "ADBE Gaussian Blur 2");
  assert.equal(addedEffect.args.params[0].paramMatchName, "ADBE Gaussian Blur 2-0001");
  assert.equal(addedEffect.args.params[0].value, 12);
  assert.equal(configured.filter((x) => x.op === "add_keyframe").length, 2);
  assert.ok(configured.some((x) => x.op === "set_expression"));
  assert.equal(seen.some((x) => x.op === "add_mask"), false, "mask creation escaped the transactional batch");
});

await check("modify_scene expands compact changes into one validated primitive batch", async () => {
  seen.length = 0;
  behaviour.set("run_batch", { ms: 1, result: { results: [{ ok: true }, { ok: true }], errors: [], total: 2, undoSteps: 1 } });
  const res = await call("modify_scene", {
    compId: 7,
    verify: false,
    changes: [{ layerId: 11, transform: { opacity: 55 }, text: { text: "Nuevo" } }],
  });
  const result = payload(res);
  assert.equal(result.primitiveOps, 2);
  const sent = seen.find((x) => x.op === "run_batch");
  assert.ok(sent, "modify_scene never reached run_batch");
  assert.deepEqual(sent.args.ops.map((step) => step.op), ["set_transform", "set_text"]);
  assert.equal(sent.args.ops[0].args.properties.opacity, 55);
  assert.equal(sent.args.ops[1].args.text, "Nuevo");
});


await check("modify_scene can add/update masks plus keyframes and expressions", async () => {
  seen.length = 0;
  behaviour.set("run_batch", {
    ms: 1,
    result: { results: [{ ok: true }, { ok: true }, { ok: true }], errors: [], total: 3, undoSteps: 1 },
  });
  const res = await call("modify_scene", {
    compId: 7,
    verify: false,
    changes: [{
      layerId: 11,
      masks: [
        { maskIndex: 1, expansion: 5 },
        { vertices: [[0, 0], [80, 0], [80, 80], [0, 80]], feather: [2, 2] },
      ],
      keyframes: [
        { propertyPath: ["Transform", "Scale"], time: 0.5, value: [110, 110, 110] },
      ],
      expressions: [
        { propertyPath: ["Transform", "Opacity"], expression: "100" },
      ],
    }],
  });

  const result = payload(res);
  assert.equal(result.primitiveOps, 4);
  assert.equal(result.addedMasks, 1);
  const batch = seen.find((x) => x.op === "run_batch");
  assert.ok(batch);
  assert.deepEqual(batch.args.ops.map((x) => x.op), ["set_mask", "add_mask", "add_keyframe", "set_expression"]);
  const addedMask = batch.args.ops.find((x) => x.op === "add_mask");
  assert.ok(addedMask);
  assert.equal(addedMask.args.layerId, 11);
  assert.deepEqual(addedMask.args.feather, [2, 2]);
  assert.equal(seen.some((x) => x.op === "add_mask"), false, "modify_scene mask creation escaped the transactional batch");
});


await check("modify_scene batches effect add/update/enable/remove actions", async () => {
  seen.length = 0;
  behaviour.set("run_batch", {
    ms: 1,
    result: { results: [{ ok: true }, { ok: true }, { ok: true }, { ok: true }], errors: [], total: 4, undoSteps: 1 },
  });

  const res = await call("modify_scene", {
    compId: 7,
    verify: false,
    changes: [{
      layerId: 11,
      effects: [
        {
          action: "add",
          matchName: "ADBE Gaussian Blur 2",
          params: [{ paramMatchName: "ADBE Gaussian Blur 2-0001", value: 18 }],
        },
        {
          action: "setParam",
          effectIndex: 2,
          paramName: "Threshold",
          value: 55,
        },
        {
          action: "enable",
          effectIndex: 2,
          enabled: false,
        },
        {
          action: "remove",
          effectIndex: 3,
        },
      ],
    }],
  });

  const result = payload(res);
  assert.equal(result.primitiveOps, 4);
  const batch = seen.find((x) => x.op === "run_batch");
  assert.ok(batch);
  assert.deepEqual(batch.args.ops.map((x) => x.op), [
    "add_effect", "set_effect_param", "set_effect_enabled", "remove_effect",
  ]);
  assert.equal(batch.args.ops[0].args.params[0].value, 18);
  assert.equal(batch.args.ops[1].args.paramName, "Threshold");
  assert.equal(batch.args.ops[2].args.enabled, false);
  assert.equal(batch.args.ops[3].args.effectIndex, 3);
});


await check("review_scene spends its screenshot budget around real keyframe activity", async () => {
  seen.length = 0;
  behaviour.set("_inspect_scene", { ms: 1, result: {
    compId: 7,
    comp: { id: 7, name: "Motion", width: 960, height: 540, duration: 10, frameRate: 30, workAreaStart: 0, workAreaDuration: 10 },
    layerCount: 1, layersOmitted: 0,
    layers: [{ id: 11, index: 1, name: "Card", sourceType: "shape" }],
    motion: {
      compId: 7, duration: 10, frameRate: 30, workAreaStart: 0, workAreaDuration: 10,
      animatedLayerCount: 1, expressionLayerCount: 0, totalKeyframes: 3,
      keyTimes: [0, 1, 2], keyTimeCount: 3, keyTimesOmitted: 0, markerTimes: [],
      animatedLayers: [{ id: 11, name: "Card", type: "shape", keyframeCount: 3, expressionCount: 0, properties: [{ name: "Position", keys: 3 }] }],
      covers: "test",
    },
  } });
  behaviour.set("screenshot_frame", { ms: 1, result: {
    width: 100, height: 50, fullWidth: 960, fullHeight: 540, downsample: 4,
    time: 0, compId: 7, mimeType: "image/png", base64: "AA==", bytes: 1,
    contactSheet: true, cols: 3, rows: 2, tiles: [],
  } });

  const res = await call("review_scene", { compId: 7 });
  const meta = JSON.parse(res.content.find((x) => x.type === "text").text);
  assert.equal(meta.sampling.mode, "motion");
  assert.equal(meta.sampling.motion.totalKeyframes, 3);
  const shot = seen.find((x) => x.op === "screenshot_frame");
  assert.ok(shot?.args?.times?.length >= 3, "review_scene did not request a motion contact sheet");
  assert.ok(Math.max(...shot.args.times) < 2.1, `sampling wasted a frame on the static tail: ${shot.args.times}`);
  assert.equal(res.content.filter((x) => x.type === "image").length, 1, "review_scene should return one image block");
  assert.deepEqual(seen.map((x) => x.op), ["_inspect_scene", "screenshot_frame"], "review_scene should be one structural read plus one visual read");
});

console.log(`write-queue-server: ${passed} checks passed`);
// Settle before exiting: `process.exit()` straight after a `fetch` crashes
// Node 24 on Windows with a libuv assertion (nodejs/node#56645; the note in
// issue-journal.mjs). The server's WS client reconnects on a timer it owns, so
// the process cannot simply be left to drain.
await new Promise((r) => setTimeout(r, 200));
process.exit(0);
