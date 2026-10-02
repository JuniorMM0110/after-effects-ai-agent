import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
let fakeNow = Date.now();
class FakeDate extends Date {
  constructor(...args) { super(...(args.length ? args : [fakeNow])); }
  static now() { return fakeNow; }
}
let nextIntervalId = 1;
const fakeIntervals = new Map();
function fakeSetInterval(fn) { const id = nextIntervalId++; fakeIntervals.set(id, fn); return id; }
function fakeClearInterval(id) { fakeIntervals.delete(id); }
function fireFakeIntervals() { for (const fn of [...fakeIntervals.values()]) fn(); }

const source = fs.readFileSync(path.join(root, "packages", "ae-panel", "client", "ae-ai.js"), "utf8");
const enhancementsSource = fs.readFileSync(path.join(root, "packages", "ae-panel", "client", "chat-enhancements.js"), "utf8");
const indexSource = fs.readFileSync(path.join(root, "packages", "ae-panel", "client", "index.html"), "utf8");
const stylesSource = fs.readFileSync(path.join(root, "packages", "ae-panel", "client", "styles.css"), "utf8");

class MockNode {
  constructor(id = "") {
    this.id = id;
    this.textContent = "";
    this.className = "";
    this.disabled = false;
    this.hidden = false;
    this.value = "";
    this.childNodes = [];
    this.listeners = {};
    this.options = [];
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.checked = false;
    this.src = "";
    this.alt = "";
    this.files = [];
    this.clickCount = 0;
  }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  fire(type, event = {}) {
    for (const fn of this.listeners[type] ?? []) fn({ preventDefault() {}, ...event });
  }
  click() { this.clickCount += 1; this.fire("click"); }
  appendChild(node) { this.childNodes.push(node); this.scrollHeight = this.childNodes.length; }
  focus() {}
  set innerHTML(value) { this.childNodes = []; this._innerHTML = value; }
  get innerHTML() { return this._innerHTML ?? ""; }
}

function createMockElement(tag) {
  const node = new MockNode();
  if (tag === "canvas") {
    node.width = 0;
    node.height = 0;
    node.getContext = () => ({ drawImage() {} });
    node.toDataURL = () => "data:image/jpeg;base64," + Buffer.from("fake-jpeg").toString("base64");
  }
  if (tag === "video") {
    node.videoWidth = 640;
    node.videoHeight = 360;
    node.duration = 8;
    node.pause = () => {};
    node.load = () => setTimeout(() => node.onloadedmetadata && node.onloadedmetadata(), 0);
    let currentTime = 0;
    Object.defineProperty(node, "currentTime", {
      get() { return currentTime; },
      set(value) {
        currentTime = value;
        setTimeout(() => node.onseeked && node.onseeked(), 0);
      }
    });
  }
  return node;
}

const ids = [
  "prompt", "model", "runButton", "cancelButton", "improvePromptButton", "output", "chatScroll",
  "runState", "history", "clearHistoryButton", "chatgptState", "chatgptDot",
  "connectButton", "charCount", "codexPath", "sessionSelect", "sessionList", "appShell", "sidebarToggleButton", "newSessionButton",
  "deleteSessionButton", "preset", "template", "autoReferences", "referenceSection", "referenceQuery",
  "searchReferencesButton", "referenceState", "referenceResults", "selectedReference",
  "attachReferenceButton", "referenceFileInput", "updateState", "updateVersion", "updateButton", "updateBadge"
];
const nodes = Object.fromEntries(ids.map((id) => [id, new MockNode(id)]));
const pageScroll = new MockNode("pageScroll");
pageScroll.scrollHeight = 1200;
nodes.model.options = [
  { value: "", disabled: false },
  { value: "gpt-5.6-sol", disabled: false },
  { value: "gpt-6-astra", disabled: true }
];
nodes.preset.value = "balanced";
nodes.template.value = "";

const storage = new Map();
storage.set("ae-ai.references-auto.v1", "0");
const localStorage = {
  getItem(key) { return storage.has(key) ? storage.get(key) : null; },
  setItem(key, value) { storage.set(key, String(value)); },
  removeItem(key) { storage.delete(key); }
};

let execArgs = null;
let promptSent = null;
let openedUrl = null;
let openedSystemUrl = null;
let fakeLoggedIn = true;
const children = [];
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end(text) { promptSent = text; } };
  child.killed = false;
  child.kill = function () {
    if (this.killed) return;
    this.killed = true;
    this.emit("close", null, "SIGTERM");
  };
  children.push(child);
  return child;
}
const fakeCp = {
  execFile(binary, args, options, callback) {
    if (binary === "/usr/bin/open") {
      openedSystemUrl = args?.at(-1) || null;
      callback(null, "", "");
      return;
    }
    if (args?.[0] === "login" && args?.[1] === "status") {
      if (fakeLoggedIn) callback(null, "Logged in using ChatGPT\n", "");
      else callback(new Error("not logged in"), "", "Not logged in");
      return;
    }
    callback(null, "Logged in using ChatGPT\n", "");
  },
  spawn(binary, args, options) {
    execArgs = { binary, args, options };
    return fakeChild();
  }
};
const fakeFiles = new Set([
  "/Users/test/Library/Application Support/AE AI/bin/codex",
  "/Users/test/Library/Application Support/AE AI/bin/after-effects-mcp",
  "/Users/test/.local/bin/codex",
  "/tmp/cat-reference.png",
  "/tmp/motion-reference.mp4"
]);
const fakeFs = {
  statSync(candidate) {
    if (fakeFiles.has(candidate)) return { isFile: () => true };
    throw new Error("missing");
  },
  mkdirSync() {},
  writeFileSync(candidate) { fakeFiles.add(candidate); },
  copyFileSync(source, target) {
    if (!fakeFiles.has(source)) throw new Error("missing source");
    fakeFiles.add(target);
  },
  readFileSync(candidate) {
    if (String(candidate).endsWith("install-info.txt")) return "version=0.5.0\narchitecture=x86_64\n";
    throw new Error("missing");
  }
};
const referencePayload = JSON.stringify({ query: { pages: [
  { index: 1, title: "File:Coraline circus.jpg", imageinfo: [{ mime: "image/jpeg", thumburl: "https://img.test/1.jpg", descriptionurl: "https://commons.test/1", extmetadata: { LicenseShortName: { value: "CC BY-SA" } } }] },
  { index: 2, title: "File:Vintage circus poster.png", imageinfo: [{ mime: "image/png", thumburl: "https://img.test/2.png", descriptionurl: "https://commons.test/2", extmetadata: { LicenseShortName: { value: "Public domain" } } }] },
  { index: 3, title: "File:Circus lights.webp", imageinfo: [{ mime: "image/webp", thumburl: "https://img.test/3.webp", descriptionurl: "https://commons.test/3", extmetadata: { LicenseShortName: { value: "CC0" } } }] }
] } });
const releaseManifestPayload = JSON.stringify({
  schema: 1, product: "AE AI", version: "0.5.0", publishedAt: "2026-09-16T00:00:00Z",
  assets: [
    { name: "AE-AI-0.5.0-macOS-Intel.dmg", kind: "ae-ai-installer", target: "macos-x64", bytes: 100, sha256: "a".repeat(64) },
    { name: "AE-AI-0.5.0-macOS-Apple-Silicon.dmg", kind: "ae-ai-installer", target: "macos-arm64", bytes: 101, sha256: "b".repeat(64) },
    { name: "AE-AI-0.5.0-Windows-x64.zip", kind: "ae-ai-installer", target: "windows-x64", bytes: 102, sha256: "c".repeat(64) }
  ]
});
let httpsCalls = 0;
let manifestStatusCode = 200;
const fakeHttps = {
  get(url, options, callback) {
    httpsCalls++;
    const req = new EventEmitter();
    const res = new EventEmitter();
    res.statusCode = String(url).includes("ae-ai-release.json") ? manifestStatusCode : 200;
    res.headers = {};
    res.resume = function () {};
    callback(res);
    setTimeout(() => {
      const body = String(url).includes("ae-ai-release.json")
        ? Buffer.from(releaseManifestPayload)
        : (String(url).includes("commons.wikimedia.org") ? Buffer.from(referencePayload) : Buffer.from("fake-image"));
      res.emit("data", body);
      res.emit("end");
    }, 0);
    return req;
  }
};
const sandbox = {
  console,
  Buffer,
  Date: FakeDate,
  JSON,
  Array,
  String,
  RegExp,
  setTimeout,
  clearTimeout,
  setInterval: fakeSetInterval,
  clearInterval: fakeClearInterval,
  window: {
    innerWidth: 1000,
    innerHeight: 600,
    addEventListener() {},
    __aeMcpCancelActiveJobs: () => ({ then(resolve) { resolve(); } })
  },
  process: { platform: "darwin", arch: "x64", env: { PATH: "/usr/bin" } },
  localStorage,
  document: {
    scrollingElement: pageScroll,
    documentElement: { clientHeight: 600 },
    body: pageScroll,
    getElementById(id) { return nodes[id] ?? null; },
    createElement(tag) { return createMockElement(tag); }
  },
  SystemPath: { EXTENSION: "extension" },
  CSInterface: function () {
    this.getSystemPath = () => path.join(root, "packages", "ae-panel");
    this.getHostEnvironment = () => ({ appName: "AEFT", appVersion: "26.3" });
    this.openURLInDefaultBrowser = (url) => { openedUrl = url; };
  },
  require(id) {
    if (id === "path") return path;
    if (id === "fs") return fakeFs;
    if (id === "os") return { homedir: () => "/Users/test" };
    if (id === "child_process") return fakeCp;
    if (id === "https") return fakeHttps;
    if (id === "url") return { pathToFileURL };
    if (id === "crypto") return crypto;
    throw new Error("Unexpected require: " + id);
  }
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: "ae-ai.js" });

assert.equal(nodes.chatgptState.textContent, "Conectado con ChatGPT");
assert.equal(nodes.codexPath.textContent, "/Users/test/Library/Application Support/AE AI/bin/codex");
assert.equal(nodes.runButton.disabled, false);
assert.doesNotMatch(nodes.appShell.className, /sidebar-collapsed/);
nodes.sidebarToggleButton.fire("click");
assert.match(nodes.appShell.className, /sidebar-collapsed/);
assert.equal(storage.get("ae-ai.sidebar-collapsed.v1"), "1");
nodes.sidebarToggleButton.fire("click");
assert.doesNotMatch(nodes.appShell.className, /sidebar-collapsed/);
assert.equal(storage.get("ae-ai.sidebar-collapsed.v1"), "0");
await new Promise((resolve) => setTimeout(resolve, 10));
assert.equal(nodes.updateState.textContent, "AE AI está actualizado.");
assert.match(nodes.updateVersion.textContent, /Instalada: 0\.5\.0 · al día/);
assert.equal(nodes.updateButton.textContent, "Comprobar");
assert.equal(pageScroll.scrollTop, pageScroll.scrollHeight, "opening AE AI should land at the bottom of the conversation");
assert.ok(storage.get("ae-ai.sessions.v1"), "a default session is persisted");
assert.equal(nodes.sessionSelect.childNodes.length, 1);
manifestStatusCode = 404;
nodes.updateButton.fire("click");
await new Promise((resolve) => setTimeout(resolve, 10));
assert.match(nodes.updateState.textContent, /todavía no tiene una versión publicada/);
assert.equal(nodes.updateButton.textContent, "Comprobar");
manifestStatusCode = 200;

nodes.template.value = "title";
nodes.template.fire("change");
assert.match(nodes.prompt.value, /Anima el título principal/);
assert.equal(nodes.template.value, "");

nodes.preset.value = "safe";
nodes.preset.fire("change");
assert.equal(storage.get("ae-ai.preset.v1"), "safe");

nodes.newSessionButton.fire("click");
assert.equal(nodes.sessionSelect.childNodes.length, 2);
assert.equal(nodes.deleteSessionButton.disabled, false);
assert.match(nodes.chatScroll.className, /empty-chat/, "a brand-new empty chat should not expose a useless scrollbar");

nodes.prompt.value = "Crea una capa de texto inspirada en un circo oscuro Coraline";
nodes.referenceQuery.value = "coraline circus";
nodes.searchReferencesButton.fire("click");
await new Promise((resolve) => setTimeout(resolve, 10));
assert.equal(nodes.referenceResults.childNodes.length, 3);
assert.match(nodes.referenceState.textContent, /3 opciones/);
nodes.referenceResults.childNodes[1].fire("click");
await new Promise((resolve) => setTimeout(resolve, 10));
assert.equal(nodes.selectedReference.hidden, false);
assert.match(nodes.selectedReference.textContent, /Vintage circus poster/);

const callsBeforeAuto = httpsCalls;
nodes.autoReferences.checked = true;
nodes.autoReferences.fire("change");
nodes.prompt.value = "Quiero un cartel de circo vintage rojo";
nodes.prompt.fire("input");
await new Promise((resolve) => setTimeout(resolve, 1050));
assert.ok(httpsCalls > callsBeforeAuto, "auto reference search should run after typing pauses");
assert.equal(nodes.referenceResults.childNodes.length, 3);

nodes.prompt.value = "Crea una capa de texto de prueba";
nodes.referenceSection.open = true;
nodes.runButton.fire("click");
assert.doesNotMatch(nodes.chatScroll.className, /empty-chat/, "the chat should become scrollable once it has a real turn");
assert.equal(nodes.prompt.value, "", "prompt should clear immediately after Ejecutar");
assert.equal(nodes.referenceSection.open, false, "the reference block should collapse immediately after Ejecutar");
assert.equal(nodes.selectedReference.hidden, true, "one-shot reference should clear from the composer after Ejecutar");
const sessionAfterReferenceSubmit = JSON.parse(storage.get("ae-ai.sessions.v1"))[0];
const submittedTurn = sessionAfterReferenceSubmit.turns[sessionAfterReferenceSubmit.turns.length - 1];
assert.equal(submittedTurn.reference.title, "Vintage circus poster.png", "collapsing the reference UI must not drop the turn attachment");
assert.equal(sessionAfterReferenceSubmit.reference, null, "the one-shot reference should move from composer state into the submitted turn");
assert.equal(execArgs.binary, "/Users/test/Library/Application Support/AE AI/bin/codex");
assert.equal(execArgs.options.env.CODEX_HOME, "/Users/test/Library/Application Support/AE AI/codex");
assert.ok(execArgs.args.includes("--json"));
assert.ok(execArgs.args.includes("--sandbox"));
assert.ok(execArgs.args.includes("read-only"));
assert.ok(execArgs.args.includes("--skip-git-repo-check"));
assert.ok(execArgs.args.includes("--image"));
const imageIndex = execArgs.args.indexOf("--image");
assert.match(execArgs.args[imageIndex + 1], /runtime\/references\/.*\.png$/);
assert.equal(execArgs.args.at(-1), "-");
assert.match(promptSent, /Prioriza cambios mínimos y reversibles/);
assert.match(promptSent, /REFERENCIA ACTIVA OBLIGATORIA: Vintage circus poster/);
assert.match(promptSent, /entrada visual real al modelo/);
assert.match(promptSent, /no te bases solo en el nombre del archivo/);
assert.match(promptSent, /ENTORNO DETECTADO: After Effects 26\.3 \(2026\)/);
assert.match(promptSent, /PRIORIZA RESULTADOS EDITABLES Y ROBUSTOS/);
assert.match(promptSent, /puedes usar cualquier técnica, renderer, plugin o herramienta disponible/);
assert.match(promptSent, /Puedes usar Cinema 4D, Cineware, renderers 3D u otras herramientas externas/);
assert.match(promptSent, /abandona esa vía tras un intento razonable/);
assert.match(promptSent, /PREFLIGHT DE CONOCIMIENTO/);
assert.match(promptSent, /DEBES llamar search_motion_knowledge antes del primer write/);
assert.match(promptSent, /EJECUCIÓN COMPACTA/);
assert.match(promptSent, /duplicar capas existentes, parenting.*máscaras, efectos configurables, transforms, keyframes y expresiones/);
assert.match(promptSent, /JERARQUÍA Y CONTROLADORES/);
assert.match(promptSent, /anima el padre una sola vez/);
assert.match(promptSent, /No dupliques keyframes idénticos capa por capa/);
assert.match(promptSent, /FASE 5 — REVISIÓN VISUAL/);
assert.match(promptSent, /termina la primera pasada con review_scene/);
assert.match(promptSent, /Corrige solo problemas concretos.*modify_scene/);
assert.match(promptSent, /Clasificación de intención: edit/);
assert.match(promptSent, /una sola review_scene final/);
assert.match(promptSent, /Petición del usuario:\nCrea una capa de texto de prueba/);
assert.equal(nodes.cancelButton.disabled, false);

const first = children[0];
first.stdout.emit("data", Buffer.from(
  JSON.stringify({ type: "item.started", item: { type: "mcp_tool_call", tool: "create_text" } }) + "\n" +
  JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Texto creado." } }) + "\n"
));
first.emit("close", 0, null);
assert.equal(nodes.runState.textContent, "Completada");
assert.ok(nodes.output.childNodes.some((node) => node.textContent === "Texto creado."));
assert.match(storage.get("ae-ai.history.v1"), /Crea una capa de texto de prueba/);
assert.match(storage.get("ae-ai.sessions.v1"), /Texto creado/);

nodes.prompt.value = "Cámbialo para que entre más rápido";
nodes.runButton.fire("click");
assert.match(promptSent, /Contexto reciente de esta sesión:/);
assert.match(promptSent, /Usuario: Crea una capa de texto de prueba/);
assert.match(promptSent, /Asistente: Texto creado\./);
assert.match(promptSent, /Petición del usuario:\nCámbialo para que entre más rápido/);
const second = children[1];
nodes.cancelButton.fire("click");
assert.equal(second.killed, true);
assert.equal(nodes.runState.textContent, "Cancelada");

const firstReferencePath = JSON.parse(storage.get("ae-ai.sessions.v1"))[0].turns[0].reference.localPath;
nodes.referenceResults.childNodes[0].fire("click");
await new Promise((resolve) => setTimeout(resolve, 10));
const nextReferencePath = JSON.parse(storage.get("ae-ai.sessions.v1"))[0].reference.localPath;
assert.notEqual(nextReferencePath, firstReferencePath, "each reference selection must get a unique local file so old turns cannot delete or overwrite newer references");

nodes.attachReferenceButton.fire("click");
assert.equal(nodes.referenceFileInput.clickCount, 1);
nodes.referenceFileInput.files = [{ path: "/tmp/cat-reference.png", name: "cat-reference.png", type: "image/png" }];
nodes.referenceFileInput.fire("change");
assert.match(nodes.selectedReference.textContent, /cat-reference\.png/);
assert.match(nodes.selectedReference.textContent, /Propia/);
assert.match(storage.get("ae-ai.sessions.v1"), /"origin":"user"/);

nodes.referenceFileInput.files = [{ path: "/tmp/motion-reference.mp4", name: "motion-reference.mp4", type: "video/mp4" }];
nodes.referenceFileInput.fire("change");
await new Promise((resolve) => setTimeout(resolve, 30));
const videoReference = JSON.parse(storage.get("ae-ai.sessions.v1"))[0].reference;
assert.equal(videoReference.kind, "video");
assert.equal(videoReference.framePaths.length, 4, "video references should produce four model-visible frames without requiring ffmpeg");
assert.ok(videoReference.framePaths.every((frame) => fakeFiles.has(frame)));
assert.match(nodes.selectedReference.textContent, /Video/);

fakeLoggedIn = false;
nodes.connectButton.fire("click");
const login = children[2];
const esc = String.fromCharCode(27);
login.stdout.emit("data", Buffer.from(
  esc + "[94mhttps://auth.openai.com/codex/device" + esc + "[0m\n" +
  esc + "[94mEQSP-H6IQ8" + esc + "[0m"
));
const loginText = nodes.output.childNodes.map((node) => node.textContent).join("\n");
assert.doesNotMatch(loginText, /\[(?:90|94|0)m/);
const loginCard = nodes.output.childNodes.find((node) => node.className === "login-help-card");
assert.ok(loginCard, "device auth should render a visible login help card");
const codeRow = loginCard.childNodes.find((node) => node.className === "login-help-code-row");
const codeNode = codeRow?.childNodes.find((node) => node.className === "login-help-code");
assert.equal(codeNode?.textContent, "EQSP-H6IQ8");
assert.equal(openedSystemUrl, "https://auth.openai.com/codex/device");
fakeLoggedIn = true;
fireFakeIntervals();
assert.equal(nodes.chatgptState.textContent, "Conectado con ChatGPT");

// Intent routing: casual/general prompts must not touch AE or attach stale visual context.
const callsBeforeKnowledgeTyping = httpsCalls;
nodes.prompt.value = "¿Para qué sirve Gaussian Blur?";
nodes.prompt.fire("input");
await new Promise((resolve) => setTimeout(resolve, 1050));
assert.equal(httpsCalls, callsBeforeKnowledgeTyping, "general questions must not trigger automatic reference searches");

nodes.prompt.value = "¡Hola!";
nodes.runButton.fire("click");
assert.equal(nodes.output.childNodes.filter((node) => node.className === "progress").length, 0, "casual chat must not render a technical/running bubble");
assert.match(promptSent, /Clasificación de intención: chat/);
assert.match(promptSent, /NO llames ninguna herramienta MCP/);
assert.ok(!execArgs.args.includes("--image"), "chat must not attach the active visual reference");
let intentChild = children.at(-1);
intentChild.stdout.emit("data", Buffer.from(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "¡Hola!" } }) + "\n"));
intentChild.emit("close", 0, null);
assert.ok(JSON.parse(storage.get("ae-ai.sessions.v1"))[0].reference, "casual chat must preserve a pending visual reference for a later AE task");

nodes.prompt.value = "¿Cómo puedo centrar un texto en After Effects?";
nodes.runButton.fire("click");
assert.match(promptSent, /Clasificación de intención: knowledge/);
assert.match(promptSent, /responde sin inspeccionar ni modificar After Effects/);
assert.match(promptSent, /search_motion_knowledge\/get_motion_technique/);
intentChild = children.at(-1);
intentChild.stdout.emit("data", Buffer.from(JSON.stringify({ type: "item.started", item: { type: "mcp_tool_call", tool: "search_motion_knowledge", id: "knowledge-1" } }) + "\n"));
assert.equal(nodes.output.childNodes.filter((node) => node.className === "progress").length, 0, "knowledge retrieval must not render as an After Effects action");
intentChild.stdout.emit("data", Buffer.from(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Usa Align." } }) + "\n"));
intentChild.emit("close", 0, null);

nodes.prompt.value = "Haz un parallax cinematográfico y revisa el resultado al terminar.";
nodes.runButton.fire("click");
assert.match(promptSent, /Clasificación de intención: edit/);
assert.match(promptSent, /MODO EDICIÓN/);
assert.doesNotMatch(promptSent, /ESTRICTAMENTE SOLO LECTURA/);
intentChild = children.at(-1);
intentChild.stdout.emit("data", Buffer.from(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Parallax creado y revisado." } }) + "\n"));
intentChild.emit("close", 0, null);

nodes.prompt.value = "Mejora esta composición y luego revísala para corregir cualquier problema.";
nodes.runButton.fire("click");
assert.match(promptSent, /Clasificación de intención: edit/);
intentChild = children.at(-1);
intentChild.stdout.emit("data", Buffer.from(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Composición mejorada." } }) + "\n"));
intentChild.emit("close", 0, null);

nodes.prompt.value = "¿Cómo mejorarías esta composición?";
nodes.runButton.fire("click");
assert.match(promptSent, /Clasificación de intención: scene-read/);
assert.match(promptSent, /ESTRICTAMENTE SOLO LECTURA/);
intentChild = children.at(-1);
intentChild.stdout.emit("data", Buffer.from(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Sugerencias." } }) + "\n"));
intentChild.emit("close", 0, null);

nodes.prompt.value = "¿Qué opinas de esta composición?";
nodes.runButton.fire("click");
assert.match(promptSent, /Clasificación de intención: scene-read/);
assert.match(promptSent, /ESTRICTAMENTE SOLO LECTURA/);
assert.match(promptSent, /no uses build_scene, modify_scene/i);
intentChild = children.at(-1);
intentChild.stdout.emit("data", Buffer.from(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "La jerarquía puede mejorar." } }) + "\n"));
intentChild.emit("close", 0, null);

nodes.prompt.value = "¿Puedes centrar el logo?";
nodes.runButton.fire("click");
assert.match(promptSent, /Clasificación de intención: edit/);
intentChild = children.at(-1);
intentChild.stdout.emit("data", Buffer.from(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Logo centrado." } }) + "\n"));
intentChild.emit("close", 0, null);

// Long user prompts stay compact in the transcript until explicitly expanded.
nodes.prompt.value = "Reorganiza esta composición manteniendo la identidad visual. " + "Usa mejor el espacio y conserva las animaciones originales. ".repeat(8);
nodes.runButton.fire("click");
const collapsedPrompt = nodes.output.childNodes.find((node) => /user-message.*long-message.*collapsed/.test(node.className));
assert.ok(collapsedPrompt, "long prompts should render collapsed");
assert.equal(collapsedPrompt.childNodes.at(-1).textContent, "Ver más");
intentChild = children.at(-1);
intentChild.stdout.emit("data", Buffer.from(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Composición reorganizada." } }) + "\n"));
intentChild.emit("close", 0, null);

// A stalled tool gets one automatic recovery attempt with a different-strategy prompt.
const beforeRecoveryChildren = children.length;
nodes.prompt.value = "Crea un objeto 3D usando la técnica que mejor funcione";
nodes.runButton.fire("click");
const stalledChild = children.at(-1);
stalledChild.stdout.emit("data", Buffer.from(JSON.stringify({ type: "item.started", item: { type: "mcp_tool_call", tool: "Cineware" } }) + "\n"));
fakeNow += 160001;
fireFakeIntervals();
assert.equal(stalledChild.killed, true, "stalled attempt should be terminated");
assert.equal(children.length, beforeRecoveryChildren + 2, "a stalled first attempt should launch exactly one recovery attempt");
assert.match(promptSent, /RECUPERACIÓN AUTOMÁTICA/);
assert.match(promptSent, /No repitas inmediatamente la misma vía bloqueada/);
assert.match(promptSent, /Cineware/);
const recoveryChild = children.at(-1);
recoveryChild.stdout.emit("data", Buffer.from(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Continué con una técnica alternativa." } }) + "\n"));
recoveryChild.emit("close", 0, null);
assert.equal(nodes.runState.textContent, "Completada");
assert.match(storage.get("ae-ai.sessions.v1"), /Continué con una técnica alternativa/);

// Prompt improver may inspect read-only context but must never modify the composition.
nodes.prompt.value = "Quiero una mejor composición";
nodes.improvePromptButton.fire("click");
assert.match(promptSent, /Mejora la instrucción del usuario/);
assert.match(promptSent, /NO hagas cambios en After Effects/);
assert.match(promptSent, /inspect_scene/);
assert.match(promptSent, /No uses herramientas de escritura/);
const improveChild = children.at(-1);
improveChild.stdout.emit("data", Buffer.from(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Analiza la composición activa y mejora su jerarquía, equilibrio y uso del espacio manteniendo su identidad visual." } }) + "\n"));
improveChild.emit("close", 0, null);
assert.match(nodes.prompt.value, /mejora su jerarquía/);
assert.equal(nodes.runState.textContent, "Prompt mejorado · revisa y pulsa Ejecutar");

assert.match(source, /tool_call_id/);
assert.match(source, /__aeToolCallId/);
assert.match(source, /RECUPERACIÓN AUTOMÁTICA/);
assert.match(source, /launchAttempt\(recoveryPrompt\(blockedTool\), 1\)/);
assert.match(source, /stallLimitMs/);
assert.match(enhancementsSource, /pendingByTool/);
assert.doesNotMatch(enhancementsSource, /persistReferenceOnLatestTurn/);
assert.match(enhancementsSource, /"id:" \+ callId/);
assert.match(enhancementsSource, /progressPanel\.hidden = true/);
assert.doesNotMatch(enhancementsSource, /setProgress\(100, "Completado"\)/);
assert.match(enhancementsSource, /hideProgress\(\);/);
assert.match(indexSource, /<details id="referenceSection" class="discover-section">/);
assert.doesNotMatch(indexSource, /<section class="discover-section">/);
assert.match(indexSource, /<details class="composer-settings">/);
assert.ok(indexSource.indexOf('class="composer-settings"') < indexSource.indexOf('history-section'), "history belongs inside hidden composer settings");
assert.match(stylesSource, /\.discover-section\[open\] \.discover-chevron/);

console.log("ae-ai-ui: intent routing, compact UI, prompt UX and existing assertions passed");
