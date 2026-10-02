(function () {
  "use strict";

  var output = document.getElementById("output");
  var discover = document.querySelector(".discover-section");
  var runButton = document.getElementById("runButton");
  var prompt = document.getElementById("prompt");
  var runState = document.getElementById("runState");
  var selectedReference = document.getElementById("selectedReference");
  var composerShell = document.querySelector(".composer-shell");
  var sessionSelect = document.getElementById("sessionSelect");
  var newSessionButton = document.getElementById("newSessionButton");
  var clearButton = document.getElementById("clearButton");
  if (!output || !discover || !runButton || !prompt || !runState) return;

  var SESSIONS_KEY = "ae-ai.sessions.v1";
  var CURRENT_SESSION_KEY = "ae-ai.current-session.v1";
  var pendingRun = null;
  var state = {
    running: false, percent: 0, activity: 0, completedTools: 0,
    toolRows: {}, toolSeq: 0, pendingByTool: {}
  };

  function createElement(tag, className, text) {
    var el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function installStyles() {
    var style = document.createElement("style");
    style.textContent = [
      ".ae-progress{width:min(760px,calc(100% - 44px));margin:14px auto 0;padding:12px 13px;background:rgba(18,25,36,.96);border:1px solid #2c3850;border-radius:13px}",
      ".ae-progress[hidden]{display:none!important}",
      ".ae-progress-head{display:flex;align-items:center;justify-content:space-between;gap:12px}",
      ".ae-progress-copy{display:grid;gap:1px;min-width:0}",
      ".ae-progress-copy strong{font-size:10px;color:#e8edf7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".ae-progress-copy span{font-size:8px;color:#758197}",
      ".ae-progress-percent{font-size:9px;color:#69d7ff;text-transform:uppercase;letter-spacing:.06em}",
      ".ae-progress-track{height:4px;margin-top:8px;overflow:hidden;background:#0b1018;border-radius:99px}",
      ".ae-progress-fill{height:100%;width:34%;background:linear-gradient(90deg,#7568ff,#56cfff);border-radius:99px;transform:translateX(-120%);animation:ae-progress-sweep 1.35s ease-in-out infinite}",
      "@keyframes ae-progress-sweep{0%{transform:translateX(-120%)}55%{transform:translateX(210%)}100%{transform:translateX(210%)}}",
      ".ae-activity{margin-top:7px;border-top:1px solid #222d3e}",
      ".ae-activity>summary{display:flex;align-items:center;gap:7px;padding-top:7px;color:#8793a7;cursor:pointer;list-style:none;font-size:8px}",
      ".ae-activity>summary::-webkit-details-marker{display:none}",
      ".ae-activity-count{margin-left:auto}",
      ".ae-activity-log{display:grid;gap:4px;max-height:120px;overflow:auto;padding-top:7px}",
      ".ae-activity-row{padding:5px 7px;color:#91a0b6;background:#101722;border-radius:7px;font-size:8px}",
      ".turn-reference-attachment{align-self:flex-end;display:flex;align-items:center;gap:9px;max-width:72%;margin:4px 0 9px auto;padding:7px 9px;overflow:hidden;background:#111a27;border:1px solid #34435a;border-radius:11px}",
      ".turn-reference-attachment img{width:46px;height:36px;flex:0 0 46px;object-fit:cover;border-radius:7px;background:#0b1018}",
      ".turn-reference-copy{min-width:0;display:grid;flex:1 1 auto;gap:1px}",
      ".turn-reference-copy strong{font-size:8px;color:#6ddca8}",
      ".turn-reference-copy span{font-size:9px;color:#dce5f2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".composer-reference{grid-column:2;grid-row:1;display:flex;align-items:center;gap:7px;width:100%;min-width:0;padding:7px 9px;background:rgba(73,217,152,.08);border:1px solid rgba(73,217,152,.22);border-radius:10px;overflow:hidden}",
      ".composer-reference[hidden]{display:none!important}",
      ".composer-reference img{width:34px;height:28px;flex:0 0 34px;object-fit:cover;border-radius:6px;background:#0b1018}",
      ".composer-reference-copy{min-width:0;display:grid;flex:1 1 auto;gap:1px}",
      ".composer-reference-copy strong{font-size:8px;color:#6ddca8}",
      ".composer-reference-copy span{font-size:8px;color:#dce5f2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".composer-reference-remove{display:grid;width:22px;height:22px;flex:0 0 22px;place-items:center;padding:0;color:#9ba7b8;background:transparent;border:1px solid #34435a;border-radius:50%;cursor:pointer;font-size:12px}",
      ".composer-reference-remove:hover{color:#fff;border-color:#66758d;background:rgba(255,255,255,.05)}",
      ".selected-reference{display:none!important}",
      "@media(max-width:760px){.ae-progress{width:100%}.turn-reference-attachment{max-width:82%}}"
    ].join("");
    document.head.appendChild(style);
  }

  function installProgressPanel() {
    var panel = createElement("section", "ae-progress");
    panel.id = "aeProgressPanel";
    panel.hidden = true;
    var head = createElement("div", "ae-progress-head");
    var copy = createElement("div", "ae-progress-copy");
    var stage = createElement("strong", "", "Preparando la tarea…");
    stage.id = "aeProgressStage";
    copy.appendChild(stage);
    copy.appendChild(createElement("span", "", "Actividad en tiempo real · puedes cancelar la tarea en cualquier momento"));
    var percent = createElement("strong", "ae-progress-percent", "En curso");
    percent.id = "aeProgressPercent";
    head.appendChild(copy);
    head.appendChild(percent);
    var track = createElement("div", "ae-progress-track");
    var fill = createElement("div", "ae-progress-fill");
    fill.id = "aeProgressFill";
    track.appendChild(fill);
    panel.appendChild(head);
    panel.appendChild(track);
    discover.parentNode.insertBefore(panel, discover);
    return panel;
  }

  var progressPanel = installProgressPanel();
  var activity = document.createElement("details");
  activity.className = "ae-activity";
  var activitySummary = document.createElement("summary");
  activitySummary.appendChild(createElement("span", "", "Actividad técnica"));
  var activityCount = createElement("span", "ae-activity-count", "0 acciones");
  activitySummary.appendChild(activityCount);
  var activityLog = createElement("div", "ae-activity-log");
  activity.appendChild(activitySummary);
  activity.appendChild(activityLog);
  progressPanel.appendChild(activity);

  var progressStage = document.getElementById("aeProgressStage");
  var progressPercent = document.getElementById("aeProgressPercent");
  var progressFill = document.getElementById("aeProgressFill");
  var composerReference = createElement("div", "composer-reference");
  composerReference.hidden = true;
  if (composerShell) composerShell.insertBefore(composerReference, composerShell.firstChild);

  function setProgress(percent, stage) {
    percent = Math.max(0, Math.min(100, Math.round(percent)));
    state.percent = Math.max(state.percent, percent);
    progressPanel.hidden = false;
    progressPercent.textContent = "En curso";
    progressFill.style.width = "34%";
    if (stage) progressStage.textContent = stage;
  }

  function resetProgress() {
    state.running = true;
    state.percent = 0;
    state.activity = 0;
    state.completedTools = 0;
    state.toolRows = {};
    state.toolSeq = 0;
    state.pendingByTool = {};
    activityLog.innerHTML = "";
    activityCount.textContent = "0 acciones";
    activity.open = false;
    progressStage.textContent = "Trabajando en After Effects…";
    progressPercent.textContent = "En curso";
    progressFill.style.width = "34%";
    progressPanel.hidden = true;
  }

  function hideProgress() {
    state.running = false;
    state.percent = 0;
    progressPanel.hidden = true;
    progressFill.style.width = "0%";
  }

  function toolNameFromText(text) {
    var match = String(text || "").match(/(?:After Effects:\s*|Completado:\s*)([^\s]+)/i);
    return match ? match[1] : "";
  }

  function stageForTool(tool) {
    tool = String(tool || "").toLowerCase();
    if (/screenshot|snapshot|diff/.test(tool)) return "Verificando el resultado…";
    if (/create|set_|add_|remove|delete|animate|run_jsx|run_batch|import|reorder|parent|duplicate/.test(tool)) return "Aplicando cambios en After Effects…";
    if (/get_|list_|find_|guide|summary|style/.test(tool)) return "Inspeccionando el proyecto…";
    return "Trabajando en After Effects…";
  }

  function recordActivity(text, meta) {
    text = String(text || "").trim();
    if (!text) return;
    meta = meta || {};
    var tool = meta.tool || toolNameFromText(text);
    var isStart = meta.event === "started" || /^Ejecutando en After Effects:/i.test(text);
    var isDone = meta.event === "completed" || /^Completado:/i.test(text);
    var callId = String(meta.callId || "");
    var key = "";
    var pending = tool ? (state.pendingByTool[tool] || (state.pendingByTool[tool] = [])) : [];

    if (isStart && tool) {
      key = callId ? "id:" + callId : "seq:" + (++state.toolSeq);
      var row = state.toolRows[key];
      if (!row) {
        row = createElement("div", "ae-activity-row", "… " + tool);
        state.toolRows[key] = row;
        pending.push(key);
        activityLog.appendChild(row);
        state.activity += 1;
        activityCount.textContent = state.activity + (state.activity === 1 ? " acción" : " acciones");
      }
      row.textContent = "… " + tool;
    } else if (isDone && tool) {
      key = callId ? "id:" + callId : (pending.length ? pending[0] : "");
      var doneRow = key ? state.toolRows[key] : null;
      if (!doneRow) {
        // A completed event without its corresponding started event is still a
        // real MCP call. Count it once rather than losing it from the UI.
        key = key || "seq:" + (++state.toolSeq);
        doneRow = createElement("div", "ae-activity-row", "✓ " + tool);
        state.toolRows[key] = doneRow;
        activityLog.appendChild(doneRow);
        state.activity += 1;
        activityCount.textContent = state.activity + (state.activity === 1 ? " acción" : " acciones");
      }
      doneRow.textContent = "✓ " + tool;
      var at = pending.indexOf(key);
      if (at >= 0) pending.splice(at, 1);
    } else {
      return;
    }

    while (activityLog.childNodes.length > 40) activityLog.removeChild(activityLog.firstChild);
    activityLog.scrollTop = activityLog.scrollHeight;

    if (isDone) {
      state.completedTools += 1;
      setProgress(Math.min(92, Math.max(state.percent + 4, 18 + state.completedTools * 6)), stageForTool(tool));
    } else if (isStart) {
      var floor = /screenshot|snapshot|diff|review_scene/i.test(tool) ? 78 : (/create|set_|add_|run_|animate|import|reorder|build_scene|modify_scene/i.test(tool) ? 44 : 18);
      setProgress(Math.min(88, Math.max(state.percent + 2, floor)), stageForTool(tool));
    }
  }

  function compactProgressMessages() {
    var nodes = output.querySelectorAll("p.progress");
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var get = typeof node.getAttribute === "function" ? function (name) { return node.getAttribute(name) || ""; } : function () { return ""; };
      recordActivity(node.textContent, {
        callId: node.__aeToolCallId || get("data-tool-call-id"),
        tool: node.__aeToolName || get("data-tool-name"),
        event: node.__aeToolEvent || get("data-tool-event")
      });
      if (node.parentNode) node.parentNode.removeChild(node);
    }
  }

  function readSessions() {
    try {
      var parsed = JSON.parse(localStorage.getItem(SESSIONS_KEY) || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) { return []; }
  }

  function currentSessionData() {
    var id = localStorage.getItem(CURRENT_SESSION_KEY);
    var list = readSessions();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function snapshotReference() {
    var session = currentSessionData();
    if (!session || !session.reference) return null;
    var ref = session.reference;
    return {
      title: ref.title || "Referencia",
      imageUrl: ref.imageUrl || "",
      sourceUrl: ref.sourceUrl || "",
      license: ref.license || "",
      mime: ref.mime || "",
      localPath: ref.localPath || "",
      kind: ref.kind || "image",
      origin: ref.origin || "discover",
      framePaths: Array.isArray(ref.framePaths) ? ref.framePaths.slice() : []
    };
  }

  function captureRunContext() {
    pendingRun = { prompt: String(prompt.value || "").trim() };
    if (pendingRun.prompt) resetProgress();
  }

  function referenceCard(ref, turnId) {
    var card = createElement("div", "turn-reference-attachment");
    if (turnId) card.setAttribute("data-turn-reference", turnId);
    if (ref.imageUrl) {
      var img = document.createElement("img");
      img.src = ref.imageUrl;
      img.alt = ref.title || "Referencia";
      card.appendChild(img);
    }
    var copy = createElement("div", "turn-reference-copy");
    copy.appendChild(createElement("strong", "", "✓ Referencia usada en esta tarea"));
    copy.appendChild(createElement("span", "", ref.title || "Referencia"));
    card.appendChild(copy);
    return card;
  }

  function decorateTurnReferences() {
    var session = currentSessionData();
    if (!session) return;
    var turns = Array.isArray(session.turns) ? session.turns : [];
    var messages = output.querySelectorAll("p.user-message");
    for (var i = 0; i < messages.length && i < turns.length; i++) {
      var turn = turns[i];
      if (!turn.reference) continue;
      var key = turn.id || ("turn-" + i);
      if (output.querySelector('[data-turn-reference="' + key.replace(/"/g, "") + '"]')) continue;
      var card = referenceCard(turn.reference, key);
      if (messages[i].nextSibling) output.insertBefore(card, messages[i].nextSibling);
      else output.appendChild(card);
    }
  }

  function clearComposerReference() {
    var currentId = localStorage.getItem(CURRENT_SESSION_KEY);
    var list = readSessions();
    var changed = false;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id !== currentId || !list[i].reference) continue;
      list[i].reference = null;
      list[i].updatedAt = new Date().toISOString();
      changed = true;
      break;
    }
    if (changed) localStorage.setItem(SESSIONS_KEY, JSON.stringify(list));
    if (selectedReference) {
      selectedReference.hidden = true;
      selectedReference.textContent = "";
    }
    var selectedCards = document.querySelectorAll(".reference-card.selected");
    for (var j = 0; j < selectedCards.length; j++) selectedCards[j].className = selectedCards[j].className.replace(/\s*selected\b/g, "");
    composerReference.innerHTML = "";
    composerReference.hidden = true;
  }

  function refreshComposerReference() {
    if (!composerReference) return;
    var ref = snapshotReference();
    composerReference.innerHTML = "";
    if (!ref) {
      composerReference.hidden = true;
      return;
    }
    if (ref.imageUrl) {
      var img = document.createElement("img");
      img.src = ref.imageUrl;
      img.alt = ref.title || "Referencia";
      composerReference.appendChild(img);
    }
    var copy = createElement("div", "composer-reference-copy");
    copy.appendChild(createElement("strong", "", "Referencia activa"));
    copy.appendChild(createElement("span", "", ref.title || "Referencia"));
    composerReference.appendChild(copy);
    var remove = createElement("button", "composer-reference-remove", "×");
    remove.type = "button";
    remove.title = "Quitar referencia";
    if (remove.setAttribute) remove.setAttribute("aria-label", "Quitar referencia");
    remove.addEventListener("click", clearComposerReference);
    composerReference.appendChild(remove);
    composerReference.hidden = false;
  }

  function refreshSelectedReferenceLabel() {
    refreshComposerReference();
    if (!selectedReference || selectedReference.hidden) return;
    var text = String(selectedReference.textContent || "");
    if (text.indexOf("Referencia activa") === 0) return;
    text = text.replace(/^Seleccionada:\s*/i, "");
    selectedReference.textContent = "Referencia activa · se adjunta al ejecutar: " + text;
  }

  function updateRunState() {
    var text = String(runState.textContent || "").toLowerCase();
    if (text.indexOf("trabajando") >= 0 || text.indexOf("cancelando") >= 0 || text.indexOf("mejorando") >= 0 ||
        text.indexOf("recuperando") >= 0 || text.indexOf("cambiando") >= 0 || text.indexOf("deteniendo") >= 0) {
      state.running = true;
      return;
    }
    if (text.indexOf("completada") >= 0 || text.indexOf("error") >= 0 || text.indexOf("cancelada") >= 0 || text.indexOf("prompt mejorado") >= 0) {
      hideProgress();
    }
  }

  var outputObserver = new MutationObserver(function () {
    compactProgressMessages();
    decorateTurnReferences();
  });
  outputObserver.observe(output, { childList: true, subtree: true });

  var stateObserver = new MutationObserver(updateRunState);
  stateObserver.observe(runState, { childList: true, characterData: true, subtree: true });

  if (selectedReference) {
    var referenceObserver = new MutationObserver(refreshSelectedReferenceLabel);
    referenceObserver.observe(selectedReference, { childList: true, characterData: true, attributes: true, subtree: true });
  }

  runButton.addEventListener("click", captureRunContext, true);
  prompt.addEventListener("keydown", function (event) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) captureRunContext();
  }, true);

  if (sessionSelect) sessionSelect.addEventListener("change", function () {
    pendingRun = null;
    hideProgress();
    setTimeout(decorateTurnReferences, 0);
  });
  if (newSessionButton) newSessionButton.addEventListener("click", function () {
    pendingRun = null;
    hideProgress();
  });
  if (clearButton) clearButton.addEventListener("click", function () {
    if (!state.running) hideProgress();
  });

  installStyles();
  compactProgressMessages();
  decorateTurnReferences();
  refreshSelectedReferenceLabel();
  updateRunState();
})();
