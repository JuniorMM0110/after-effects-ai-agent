(function () {
  "use strict";

  var path = require("path");
  var fs = require("fs");
  var os = require("os");
  var cp = require("child_process");
  var https = require("https");
  var urlTools = require("url");
  var crypto = require("crypto");

  var cs = new CSInterface();
  var extDir = cs.getSystemPath(SystemPath.EXTENSION);
  var $ = function (id) { return document.getElementById(id); };
  var ui = {
    prompt: $("prompt"),
    model: $("model"),
    run: $("runButton"),
    cancel: $("cancelButton"),
    improve: $("improvePromptButton"),
    output: $("output"),
    chatScroll: $("chatScroll"),
    runState: $("runState"),
    history: $("history"),
    clearHistory: $("clearHistoryButton"),
    chatgpt: $("chatgptState"),
    chatgptDot: $("chatgptDot"),
    connect: $("connectButton"),
    charCount: $("charCount"),
    codexPath: $("codexPath"),
    session: $("sessionSelect"),
    sessionList: $("sessionList"),
    appShell: $("appShell"),
    sidebarToggle: $("sidebarToggleButton"),
    newSession: $("newSessionButton"),
    deleteSession: $("deleteSessionButton"),
    preset: $("preset"),
    template: $("template"),
    autoReferences: $("autoReferences"),
    referenceSection: $("referenceSection"),
    referenceQuery: $("referenceQuery"),
    searchReferences: $("searchReferencesButton"),
    referenceState: $("referenceState"),
    referenceResults: $("referenceResults"),
    selectedReference: $("selectedReference"),
    attachReference: $("attachReferenceButton"),
    referenceFile: $("referenceFileInput"),
    updateState: $("updateState"),
    updateVersion: $("updateVersion"),
    updateButton: $("updateButton"),
    updateBadge: $("updateBadge")
  };

  var HISTORY_KEY = "ae-ai.history.v1";
  var MODEL_KEY = "ae-ai.model.v1";
  var SESSIONS_KEY = "ae-ai.sessions.v1";
  var CURRENT_SESSION_KEY = "ae-ai.current-session.v1";
  var PRESET_KEY = "ae-ai.preset.v1";
  var AUTO_REFERENCES_KEY = "ae-ai.references-auto.v1";
  var SIDEBAR_KEY = "ae-ai.sidebar-collapsed.v1";
  var UPDATE_MANIFEST_URL = "https://github.com/Engine-Room-Games/after-effects-mcp/releases/latest/download/ae-ai-release.json";
  var UPDATE_ASSET_BASE = "https://github.com/Engine-Room-Games/after-effects-mcp/releases/latest/download/";
  var pendingUpdateAsset = null;
  var downloadedUpdatePath = "";
  var PRESETS = {
    balanced: "Equilibra calidad y velocidad. Conserva el diseño existente salvo que el usuario pida cambiarlo.",
    safe: "Prioriza cambios mínimos y reversibles. Inspecciona antes de escribir y evita reemplazar trabajo existente.",
    creative: "Propón decisiones visuales más expresivas cuando el usuario deje libertad creativa, sin romper la intención original.",
    fast: "Prioriza una solución directa con pocas operaciones. Evita exploraciones innecesarias y verifica solo lo esencial."
  };
  var TEMPLATES = {
    analyze: "Analiza la composición activa. Describe su estructura, jerarquía visual, ritmo y posibles problemas. No modifiques nada todavía.",
    title: "Anima el título principal de la composición activa con una entrada suave y profesional. Conserva tipografía, color, escala base y posición final.",
    reel: "Crea una composición vertical para Reel de 1080x1920, 30 fps y 15 segundos. Organiza una estructura inicial editable y no elimines composiciones existentes.",
    improve: "Analiza la composición activa y mejora su claridad, jerarquía y dinamismo sin cambiar innecesariamente su identidad visual. Explica brevemente qué corregiste.",
    reference: "Usa la referencia seleccionada como guía visual. Analiza composición, color, ritmo, tipografía y tratamiento gráfico; adapta esos principios al proyecto sin copiar elementos protegidos literalmente."
  };
  var active = null;
  var loginProcess = null;
  var loginOpened = false;
  var loginPollTimer = null;
  var loginExpiryTimer = null;
  var loginHelpCard = null;
  var referenceTimer = null;
  var lastAutoReferenceQuery = "";
  var referenceRequestSeq = 0;
  var referenceRequests = {};
  var referenceSelectionSeq = 0;
  var referenceSelections = {};

  function isFile(p) {
    try { return fs.statSync(p).isFile(); } catch (e) { return false; }
  }

  function appDataRoot() {
    if (process.platform === "darwin") {
      return path.join(os.homedir(), "Library", "Application Support", "AE AI");
    }
    if (process.platform === "win32") {
      return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "AE AI");
    }
    return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "AE AI");
  }

  function codexHome() {
    return path.join(appDataRoot(), "codex");
  }

  function defaultCodexHome() {
    return path.join(os.homedir(), ".codex");
  }

  function defaultCodexEnvironment() {
    var env = {};
    for (var key in process.env) env[key] = process.env[key];
    try { delete env.CODEX_HOME; } catch (e) { env.CODEX_HOME = ""; }
    return env;
  }

  function codexEnvironment() {
    var env = {};
    for (var key in process.env) env[key] = process.env[key];
    env.CODEX_HOME = codexHome();
    return env;
  }

  function mcpBinaryPath() {
    return path.join(appDataRoot(), "bin", process.platform === "win32" ? "after-effects-mcp.exe" : "after-effects-mcp");
  }

  function ensureManagedBridgeRuntime() {
    var mcp = mcpBinaryPath();
    if (!isFile(mcp)) return { ready: false, reason: "Falta el Bridge/MCP instalado." };
    try {
      fs.mkdirSync(codexHome(), { recursive: true });
      var configPath = path.join(codexHome(), "config.toml");
      var expectedCommand = "command = " + JSON.stringify(mcp);
      var current = "";
      try { current = fs.readFileSync(configPath, "utf8"); } catch (e) {}
      if (current.indexOf("[mcp_servers.after-effects]") < 0 || current.indexOf(expectedCommand) < 0) {
        fs.writeFileSync(configPath, [
          "# Administrado por AE AI. La autenticación se guarda por separado.",
          'cli_auth_credentials_store = "auto"',
          "",
          "[mcp_servers.after-effects]",
          expectedCommand,
          "args = []",
          'default_tools_approval_mode = "approve"',
          ""
        ].join("\n"), "utf8");
      }
      return { ready: true, path: mcp };
    } catch (e2) {
      return { ready: false, reason: "No se pudo preparar el Bridge/MCP: " + e2.message };
    }
  }

  function executableCandidates() {
    var home = os.homedir();
    var items = [];
    if (process.env.AE_AI_CODEX_PATH) items.push(process.env.AE_AI_CODEX_PATH);
    if (process.platform !== "win32") items.push(path.join(appDataRoot(), "bin", "codex"));
    if (process.platform === "win32") {
      if (process.env.LOCALAPPDATA) {
        items.push(path.join(process.env.LOCALAPPDATA, "Programs", "ChatGPT", "resources", "codex.exe"));
        items.push(path.join(process.env.LOCALAPPDATA, "Programs", "ChatGPT", "resources", "app", "codex.exe"));
        items.push(path.join(process.env.LOCALAPPDATA, "Programs", "codex", "codex.exe"));
      }
      if (process.env.PROGRAMFILES) {
        items.push(path.join(process.env.PROGRAMFILES, "ChatGPT", "resources", "codex.exe"));
        items.push(path.join(process.env.PROGRAMFILES, "ChatGPT", "resources", "app", "codex.exe"));
      }
      if (process.env.APPDATA) items.push(path.join(process.env.APPDATA, "npm", "codex.cmd"));
    } else {
      items.push(path.join(home, ".local", "bin", "codex"));
      items.push("/usr/local/bin/codex");
      items.push("/opt/homebrew/bin/codex");
    }
    var names = process.platform === "win32" ? ["codex.exe", "codex.cmd", "codex"] : ["codex"];
    var dirs = String(process.env.PATH || "").split(path.delimiter);
    for (var i = 0; i < dirs.length; i++) {
      for (var j = 0; j < names.length; j++) items.push(path.join(dirs[i], names[j]));
    }
    if (process.platform === "win32") items.push(path.join(appDataRoot(), "bin", "codex.exe"));
    return items;
  }

  function findCodex() {
    var candidates = executableCandidates();
    for (var i = 0; i < candidates.length; i++) {
      if (isFile(candidates[i])) return candidates[i];
    }
    return null;
  }

  function runtimeDirectory() {
    var dir = path.join(appDataRoot(), "runtime");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  function findExecutable(name) {
    var names = process.platform === "win32" ? [name + ".exe", name + ".cmd", name] : [name];
    var dirs = String(process.env.PATH || "").split(path.delimiter);
    if (process.platform !== "win32") dirs = ["/usr/local/bin", "/opt/homebrew/bin"].concat(dirs);
    for (var i = 0; i < dirs.length; i++) {
      for (var j = 0; j < names.length; j++) {
        var candidate = path.join(dirs[i], names[j]);
        if (isFile(candidate)) return candidate;
      }
    }
    return null;
  }

  function localFileUrl(filePath) {
    try { return urlTools.pathToFileURL(filePath).href; }
    catch (e) { return "file://" + encodeURI(filePath); }
  }

  function setConnection(text, klass, canConnect) {
    ui.chatgpt.textContent = text;
    ui.chatgpt.className = klass || "";
    ui.chatgptDot.className = "status-dot " + (klass || "");
    ui.connect.hidden = !canConnect;
  }

  function setSidebarCollapsed(collapsed, persist) {
    if (!ui.appShell || !ui.sidebarToggle) return;
    var className = String(ui.appShell.className || "").replace(/\s*sidebar-collapsed\b/g, "");
    ui.appShell.className = className + (collapsed ? " sidebar-collapsed" : "");
    ui.sidebarToggle.textContent = collapsed ? "☰" : "‹";
    ui.sidebarToggle.setAttribute && ui.sidebarToggle.setAttribute("aria-label", collapsed ? "Abrir chats" : "Plegar chats");
    ui.sidebarToggle.title = collapsed ? "Abrir chats" : "Plegar chats";
    if (persist !== false) localStorage.setItem(SIDEBAR_KEY, collapsed ? "1" : "0");
  }

  function initializeSidebar() {
    if (!ui.appShell || !ui.sidebarToggle) return;
    var stored = localStorage.getItem(SIDEBAR_KEY);
    var compact = typeof window !== "undefined" && window.innerWidth && window.innerWidth <= 760;
    setSidebarCollapsed(stored === null ? compact : stored === "1", false);
    ui.sidebarToggle.addEventListener("click", function () {
      setSidebarCollapsed(!/(?:^|\s)sidebar-collapsed(?:\s|$)/.test(ui.appShell.className));
    });
  }

  function setRunning(running, state) {
    ui.run.disabled = running;
    ui.cancel.disabled = !running;
    if (ui.improve) ui.improve.disabled = running;
    ui.prompt.disabled = running;
    ui.model.disabled = running;
    ui.session.disabled = running;
    ui.preset.disabled = running;
    ui.template.disabled = running;
    ui.newSession.disabled = running;
    ui.deleteSession.disabled = running || readSessions().length <= 1;
    ui.searchReferences.disabled = running;
    ui.referenceQuery.disabled = running;
    ui.autoReferences.disabled = running;
    if (ui.attachReference) ui.attachReference.disabled = running;
    if (ui.referenceFile) ui.referenceFile.disabled = running;
    ui.runState.textContent = state || (running ? "Trabajando…" : "Esperando instrucciones");
  }

  var followConversation = true;

  function scrollingElement() {
    return document.scrollingElement || document.documentElement || document.body || null;
  }

  function isNearConversationBottom() {
    var el = scrollingElement();
    if (!el) return true;
    var viewport = (typeof window !== "undefined" && window.innerHeight) || (document.documentElement && document.documentElement.clientHeight) || 0;
    return el.scrollHeight - (el.scrollTop + viewport) < 90;
  }

  function scrollConversationBottom(force) {
    if (!force && !followConversation) return;
    var el = scrollingElement();
    if (!el) return;
    setTimeout(function () {
      el.scrollTop = el.scrollHeight;
      followConversation = true;
    }, 0);
  }

  if (typeof window !== "undefined" && window.addEventListener) {
    window.addEventListener("scroll", function () { followConversation = isNearConversationBottom(); });
  }

  function clearOutput() {
    ui.output.innerHTML = "";
    loginHelpCard = null;
  }

  function copyLoginText(text, callback) {
    text = String(text || "");
    if (!text) { if (callback) callback(false); return; }
    try {
      var command = process.platform === "darwin" ? "/usr/bin/pbcopy" : (process.platform === "win32" ? "clip.exe" : "xclip");
      var args = process.platform === "linux" ? ["-selection", "clipboard"] : [];
      var child = cp.spawn(command, args, { env: process.env });
      var done = false;
      function finish(ok) { if (done) return; done = true; if (callback) callback(ok); }
      child.on("error", function () { finish(false); });
      child.on("close", function (code) { finish(code === 0); });
      child.stdin.end(text);
    } catch (e) {
      if (callback) callback(false);
    }
  }

  function removeLoginHelp() {
    if (loginHelpCard && loginHelpCard.parentNode) loginHelpCard.parentNode.removeChild(loginHelpCard);
    loginHelpCard = null;
  }

  function renderLoginHelp(url, code) {
    url = String(url || "").trim();
    code = String(code || "").trim();
    if (!url && !code) return;
    if (!loginHelpCard) {
      var card = document.createElement("div");
      card.className = "login-help-card";
      var title = document.createElement("strong");
      title.className = "login-help-title";
      title.textContent = "Conecta tu cuenta de ChatGPT";
      card.appendChild(title);
      var note = document.createElement("div");
      note.className = "login-help-note";
      note.textContent = "Si la página queda en blanco, recárgala o desactiva temporalmente VPN/bloqueadores para auth.openai.com. También puedes copiar el enlace y abrirlo manualmente.";
      card.appendChild(note);
      var codeRow = document.createElement("div");
      codeRow.className = "login-help-code-row";
      var codeLabel = document.createElement("span");
      codeLabel.className = "login-help-code-label";
      codeLabel.textContent = "Código";
      var codeValue = document.createElement("code");
      codeValue.className = "login-help-code";
      codeValue.textContent = code || "—";
      codeRow.appendChild(codeLabel);
      codeRow.appendChild(codeValue);
      card.appendChild(codeRow);
      var actions = document.createElement("div");
      actions.className = "login-help-actions";
      var reopen = document.createElement("button");
      reopen.type = "button";
      reopen.className = "login-help-button primary";
      reopen.textContent = "Abrir de nuevo";
      reopen.addEventListener("click", function () {
        var target = card.__loginUrl || "";
        if (target) openExternalUrl(target);
      });
      var copyCode = document.createElement("button");
      copyCode.type = "button";
      copyCode.className = "login-help-button";
      copyCode.textContent = "Copiar código";
      copyCode.addEventListener("click", function () {
        var value = card.__loginCode || "";
        copyLoginText(value, function (ok) { copyCode.textContent = ok ? "Código copiado ✓" : "No se pudo copiar"; });
      });
      var copyLink = document.createElement("button");
      copyLink.type = "button";
      copyLink.className = "login-help-button";
      copyLink.textContent = "Copiar enlace";
      copyLink.addEventListener("click", function () {
        var value = card.__loginUrl || "";
        copyLoginText(value, function (ok) { copyLink.textContent = ok ? "Enlace copiado ✓" : "No se pudo copiar"; });
      });
      actions.appendChild(reopen);
      actions.appendChild(copyCode);
      actions.appendChild(copyLink);
      card.appendChild(actions);
      card.__codeValue = codeValue;
      card.__copyCode = copyCode;
      ui.output.appendChild(card);
      loginHelpCard = card;
    }
    loginHelpCard.__loginUrl = url || loginHelpCard.__loginUrl || "";
    loginHelpCard.__loginCode = code || loginHelpCard.__loginCode || "";
    if (loginHelpCard.__codeValue) loginHelpCard.__codeValue.textContent = loginHelpCard.__loginCode || "—";
    if (loginHelpCard.__copyCode) loginHelpCard.__copyCode.disabled = !loginHelpCard.__loginCode;
    scrollConversationBottom(true);
  }

  function stripTerminalCodes(text) {
    // Codex colors terminal output with ANSI CSI sequences (for example ESC[94m).
    // CEP renders those bytes as visible `94m` text, so remove them at the UI boundary.
    return String(text || "").replace(/\x1B\[[0-?]*[ -\/]*[@-~]/g, "");
  }

  function appendOutput(text, kind, meta) {
    text = stripTerminalCodes(text);
    if (!text) return;
    var p = document.createElement("p");
    var baseClass = kind || "";
    var longUserMessage = kind === "user-message" && (text.length > 320 || text.split(/\r?\n/).length > 4);
    p.className = baseClass + (longUserMessage ? " long-message collapsed" : "");
    if (longUserMessage) {
      var body = document.createElement("span");
      body.className = "message-text";
      body.textContent = text;
      var toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "message-toggle";
      toggle.textContent = "Ver más";
      toggle.addEventListener("click", function () {
        var collapsed = /(?:^|\s)collapsed(?:\s|$)/.test(p.className);
        p.className = baseClass + " long-message " + (collapsed ? "expanded" : "collapsed");
        toggle.textContent = collapsed ? "Ver menos" : "Ver más";
        if (!collapsed) scrollConversationBottom(false);
      });
      p.appendChild(body);
      p.appendChild(toggle);
    } else {
      p.textContent = text;
    }
    if (meta) {
      p.__aeToolCallId = meta.callId || "";
      p.__aeToolName = meta.tool || "";
      p.__aeToolEvent = meta.event || "";
      if (typeof p.setAttribute === "function") {
        if (meta.callId) p.setAttribute("data-tool-call-id", meta.callId);
        if (meta.tool) p.setAttribute("data-tool-name", meta.tool);
        if (meta.event) p.setAttribute("data-tool-event", meta.event);
      }
    }
    ui.output.appendChild(p);
    scrollConversationBottom(false);
  }

  function friendlyError(raw) {
    var text = String(raw || "Error desconocido");
    if (/model.*not found|unknown model|does not have access|model.*not supported/i.test(text)) {
      return "Ese modelo no está disponible para esta cuenta. Elige Automático y vuelve a intentarlo.";
    }
    if (/not logged in|login required|authentication/i.test(text)) {
      return "La cuenta de ChatGPT no está conectada. Pulsa Conectar.";
    }
    if (/mcp.*after-effects|bridge.*unreachable|ECONNREFUSED/i.test(text)) {
      return "Codex no pudo comunicarse con After Effects. Revisa que Bridge indique ready.";
    }
    return text;
  }


  function readSessions() {
    try {
      var parsed = JSON.parse(localStorage.getItem(SESSIONS_KEY) || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) { return []; }
  }

  function writeSessions(list) {
    var kept = list.slice(0, 20);
    var dropped = list.slice(20);
    for (var i = 0; i < dropped.length; i++) cleanupSessionReferenceFiles(dropped[i]);
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(kept));
  }

  function makeSession() {
    var now = new Date().toISOString();
    return { id: "s-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7), title: "Nueva sesión", createdAt: now, updatedAt: now, turns: [] };
  }

  function ensureSessions() {
    var list = readSessions();
    if (!list.length) {
      list = [makeSession()];
      writeSessions(list);
      localStorage.setItem(CURRENT_SESSION_KEY, list[0].id);
    }
    var current = localStorage.getItem(CURRENT_SESSION_KEY);
    if (!list.some(function (item) { return item.id === current; })) {
      current = list[0].id;
      localStorage.setItem(CURRENT_SESSION_KEY, current);
    }
    return list;
  }

  function currentSession() {
    var current = localStorage.getItem(CURRENT_SESSION_KEY);
    var list = ensureSessions();
    for (var i = 0; i < list.length; i++) if (list[i].id === current) return list[i];
    return list[0];
  }

  function sessionTimestamp(item) {
    var date = new Date(item.updatedAt || item.createdAt || Date.now());
    var now = new Date();
    var sameDay = date.toDateString() === now.toDateString();
    var yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    var time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    if (sameDay) return "Hoy, " + time;
    if (date.toDateString() === yesterday.toDateString()) return "Ayer, " + time;
    return date.toLocaleDateString();
  }

  function selectSessionById(id) {
    localStorage.setItem(CURRENT_SESSION_KEY, id);
    ui.session.value = id;
    renderSessions();
    renderSessionTranscript();
    renderReferenceResults();
  }

  function renderSessions() {
    var list = ensureSessions();
    var current = localStorage.getItem(CURRENT_SESSION_KEY);
    ui.session.innerHTML = "";
    if (ui.sessionList) ui.sessionList.innerHTML = "";
    list.forEach(function (item) {
      var option = document.createElement("option");
      option.value = item.id;
      option.textContent = item.title;
      ui.session.appendChild(option);
      if (ui.sessionList) {
        var button = document.createElement("button");
        button.type = "button";
        button.className = "session-item" + (item.id === current ? " active" : "");
        var title = document.createElement("span");
        title.className = "session-item-title";
        title.textContent = item.title;
        var meta = document.createElement("small");
        meta.className = "session-item-meta";
        meta.textContent = sessionTimestamp(item);
        button.appendChild(title);
        button.appendChild(meta);
        button.addEventListener("click", function () { if (!active) selectSessionById(item.id); });
        ui.sessionList.appendChild(button);
      }
    });
    ui.session.value = current;
    ui.deleteSession.disabled = list.length <= 1;
  }

  function createSession() {
    var list = readSessions();
    var session = makeSession();
    list.unshift(session);
    writeSessions(list);
    localStorage.setItem(CURRENT_SESSION_KEY, session.id);
    renderSessions();
    renderReferenceResults();
    ui.prompt.value = "";
    updateCount();
    renderSessionTranscript();
  }

  function removeCurrentSession() {
    var current = localStorage.getItem(CURRENT_SESSION_KEY);
    var existing = readSessions();
    for (var i = 0; i < existing.length; i++) if (existing[i].id === current) cleanupSessionReferenceFiles(existing[i]);
    var list = existing.filter(function (item) { return item.id !== current; });
    if (!list.length) list = [makeSession()];
    writeSessions(list);
    localStorage.setItem(CURRENT_SESSION_KEY, list[0].id);
    renderSessions();
    renderReferenceResults();
  }

  function startSessionTurn(prompt, referenceForTurn) {
    var current = localStorage.getItem(CURRENT_SESSION_KEY);
    var list = ensureSessions();
    var turnId = "t-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7);
    var turnReference = referenceForTurn ? JSON.parse(JSON.stringify(referenceForTurn)) : null;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id !== current) continue;
      list[i].turns = Array.isArray(list[i].turns) ? list[i].turns : [];
      list[i].turns.push({ id: turnId, prompt: prompt, answer: "", status: "running", at: new Date().toISOString(), reference: turnReference });
      if (list[i].turns.length > 12) {
        var discardedTurns = list[i].turns.slice(0, list[i].turns.length - 12);
        for (var d = 0; d < discardedTurns.length; d++) cleanupReferenceFiles(discardedTurns[d] && discardedTurns[d].reference);
        list[i].turns = list[i].turns.slice(-12);
      }
      // References are one-shot attachments only for turns that actually use
      // scene context. Casual/general chat must not consume a reference that the
      // user intended for a later After Effects task.
      if (turnReference) list[i].reference = null;
      list[i].updatedAt = new Date().toISOString();
      if (list[i].title === "Nueva sesión") list[i].title = prompt.length > 42 ? prompt.slice(0, 39) + "…" : prompt;
      break;
    }
    writeSessions(list);
    renderSessions();
    return turnId;
  }

  function finishSessionTurn(sessionId, turnId, answer, status) {
    var list = ensureSessions();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id !== sessionId) continue;
      var turns = Array.isArray(list[i].turns) ? list[i].turns : [];
      for (var j = turns.length - 1; j >= 0; j--) {
        if (turns[j].id !== turnId) continue;
        turns[j].answer = answer || "";
        turns[j].status = status || "done";
        break;
      }
      list[i].updatedAt = new Date().toISOString();
      break;
    }
    writeSessions(list);
  }

  function setChatEmptyState(empty) {
    if (!ui.chatScroll) return;
    var base = String(ui.chatScroll.className || "chat-scroll").replace(/(?:^|\s)empty-chat(?=\s|$)/g, " ").replace(/\s+/g, " ").trim();
    if (!base) base = "chat-scroll";
    ui.chatScroll.className = base + (empty ? " empty-chat" : "");
  }

  function renderSessionTranscript() {
    var session = currentSession();
    var turns = Array.isArray(session.turns) ? session.turns : [];
    clearOutput();
    setChatEmptyState(!turns.length);
    if (!turns.length) {
      appendOutput("Esta sesión todavía no tiene mensajes.", "muted");
      return;
    }
    turns.forEach(function (turn) {
      appendOutput(turn.prompt, "user-message");
      if (turn.answer) appendOutput(turn.answer, "answer");
      else if (turn.status === "cancelled") appendOutput("Tarea cancelada.", "error");
      else if (turn.status === "error") appendOutput("La tarea anterior terminó con error.", "error");
    });
    scrollConversationBottom(true);
  }

  function sessionContext() {
    var session = currentSession();
    var turns = (session.turns || []).slice(-6);
    if (!turns.length) return "";
    var lines = ["Contexto reciente de esta sesión:"];
    turns.forEach(function (turn) {
      lines.push("Usuario: " + turn.prompt);
      if (turn.answer) lines.push("Asistente: " + turn.answer);
    });
    return lines.join("\n");
  }

  function updateSessionById(sessionId, mutator) {
    var list = ensureSessions();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id !== sessionId) continue;
      mutator(list[i]);
      list[i].updatedAt = new Date().toISOString();
      break;
    }
    writeSessions(list);
  }

  function updateCurrentSession(mutator) {
    updateSessionById(localStorage.getItem(CURRENT_SESSION_KEY), mutator);
  }

  function referenceQueryFromPrompt(text) {
    var stop = {
      que:1, para:1, por:1, una:1, uno:1, unos:1, unas:1, con:1, sin:1, del:1, las:1, los:1,
      este:1, esta:1, esto:1, como:1, quiero:1, crea:1, crear:1, haz:1, hacer:1, dame:1, pon:1,
      composicion:1, composición:1, activa:1, after:1, effects:1, imagen:1, referencia:1, referencias:1,
      estilo:1, visual:1, animacion:1, animación:1, pero:1, algo:1, desde:1, sobre:1, tiene:1, tenga:1
    };
    var words = String(text || "")
      .replace(/https?:\/\/\S+/g, " ")
      .match(/[A-Za-zÀ-ÿ0-9][A-Za-zÀ-ÿ0-9_-]*/g) || [];
    var picked = [];
    for (var i = 0; i < words.length; i++) {
      var word = words[i];
      var key = word.toLowerCase();
      if (key.length < 3 || stop[key]) continue;
      if (picked.indexOf(key) >= 0) continue;
      picked.push(key);
      if (picked.length >= 8) break;
    }
    return picked.join(" ");
  }

  function requestBuffer(url, callback, redirects) {
    redirects = redirects || 0;
    if (redirects > 4) return callback(new Error("Demasiadas redirecciones al buscar la referencia."));
    var done = false;
    var req;
    function finish(error, bytes) {
      if (done) return;
      done = true;
      callback(error || null, bytes);
    }
    req = https.get(url, { headers: { "User-Agent": "AE-AI/0.5.0 reference-discovery" } }, function (res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        done = true;
        res.resume();
        return requestBuffer(urlTools.resolve(url, res.headers.location), callback, redirects + 1);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return finish(new Error("La búsqueda respondió con HTTP " + res.statusCode + "."));
      }
      var chunks = [];
      var bytes = 0;
      var maxBytes = 16 * 1024 * 1024;
      res.on("data", function (chunk) {
        if (done) return;
        bytes += chunk.length;
        if (bytes > maxBytes) {
          done = true;
          try { req.destroy(); } catch (e) {}
          callback(new Error("La referencia supera el límite de 16 MB."));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      res.on("end", function () { if (!done) finish(null, Buffer.concat(chunks)); });
      res.on("error", function (error) { finish(error); });
    });
    if (req.setTimeout) req.setTimeout(15000, function () { req.destroy(new Error("La descarga de la referencia agotó 15 s.")); });
    req.on("error", function (error) { finish(error); });
  }

  function currentReference() {
    var session = currentSession();
    return session.reference || null;
  }

  function modelVisualPaths(reference) {
    if (!reference) return [];
    if (reference.kind === "video" && Array.isArray(reference.framePaths)) {
      return reference.framePaths.filter(function (candidate) { return candidate && isFile(candidate); });
    }
    var source = reference.localPath;
    if (!source || !isFile(source)) return [];
    var ext = path.extname(source).toLowerCase();
    if (/\.(gif|webp)$/i.test(ext)) {
      var ffmpeg = findExecutable("ffmpeg");
      var converted = source.replace(/\.[^.]+$/, "") + "-vision.jpg";
      try {
        if (!isFile(converted) && ffmpeg) {
          cp.execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-i", source, "-frames:v", "1", "-vf", "scale=w='min(1280,iw)':h=-2", converted], { timeout: 30000 });
        }
        if (!isFile(converted) && process.platform === "darwin") {
          var sips = findExecutable("sips");
          if (sips) cp.execFileSync(sips, ["-s", "format", "jpeg", source, "--out", converted], { timeout: 30000 });
        }
        if (isFile(converted)) return [converted];
      } catch (e) {}
    }
    return [source];
  }

  function saveReferenceDiscovery(sessionId, query, results) {
    updateSessionById(sessionId, function (session) {
      session.referenceQuery = query;
      session.references = results;
      // A new automatic search must never deselect a reference the user already
      // chose. Selection changes only when the user chooses/attaches another one.
    });
  }

  function collapseReferencePanel() {
    if (ui.referenceSection) ui.referenceSection.open = false;
  }

  function renderReferenceResults() {
    var session = currentSession();
    var results = Array.isArray(session.references) ? session.references.slice(0, 3) : [];
    var selected = session.reference || null;
    ui.referenceResults.innerHTML = "";
    ui.referenceQuery.value = session.referenceQuery || "";
    results.forEach(function (ref, index) {
      var card = document.createElement("button");
      card.type = "button";
      card.className = "reference-card" + (selected && selected.sourceUrl === ref.sourceUrl ? " selected" : "");
      var img = document.createElement("img");
      img.src = ref.imageUrl;
      img.alt = ref.title;
      var title = document.createElement("span");
      title.textContent = (index + 1) + ". " + ref.title;
      var meta = document.createElement("small");
      meta.textContent = ref.license || "Wikimedia Commons";
      card.appendChild(img);
      card.appendChild(title);
      card.appendChild(meta);
      card.addEventListener("click", function () { selectReference(ref); });
      ui.referenceResults.appendChild(card);
    });
    if (selected) {
      ui.selectedReference.hidden = false;
      var refType = selected.kind === "video" ? " · Video" : " · Imagen";
      var refOrigin = selected.origin === "user" ? " · Propia" : "";
      ui.selectedReference.textContent = "Seleccionada: " + selected.title + refType + refOrigin + (selected.license ? " · " + selected.license : "");
    } else {
      ui.selectedReference.hidden = true;
      ui.selectedReference.textContent = "";
    }
  }

  function parseReferenceResults(payload) {
    var pages = payload && payload.query && Array.isArray(payload.query.pages) ? payload.query.pages : [];
    pages.sort(function (a, b) { return (a.index || 9999) - (b.index || 9999); });
    var allowed = /^(?:image\/(?:jpeg|png|webp|gif))$/i;
    var results = [];
    for (var i = 0; i < pages.length && results.length < 3; i++) {
      var info = pages[i].imageinfo && pages[i].imageinfo[0];
      if (!info || !allowed.test(info.mime || "")) continue;
      var license = info.extmetadata && info.extmetadata.LicenseShortName && info.extmetadata.LicenseShortName.value;
      results.push({
        title: String(pages[i].title || "Referencia").replace(/^File:/i, ""),
        imageUrl: info.thumburl || info.url,
        sourceUrl: info.descriptionurl || info.url,
        mime: info.mime,
        license: license || "Wikimedia Commons"
      });
    }
    return results;
  }

  function referenceApiUrl(query) {
    return "https://commons.wikimedia.org/w/api.php?action=query&generator=search" +
      "&gsrnamespace=6&gsrlimit=12&gsrsearch=" + encodeURIComponent(query) +
      "&prop=imageinfo&iiprop=url%7Cmime%7Cextmetadata&iiurlwidth=420&format=json&formatversion=2&origin=*";
  }

  function referenceFallbackQueries(query) {
    var words = query.split(/\s+/).filter(Boolean);
    var list = [query];
    for (var i = 0; i < words.length - 1; i++) {
      var pair = words[i] + " " + words[i + 1];
      if (list.indexOf(pair) < 0) list.push(pair);
    }
    words.forEach(function (word) {
      if (list.indexOf(word) < 0) list.push(word);
    });
    return list.slice(0, 6);
  }

  function discoverReferences(query) {
    var targetSessionId = localStorage.getItem(CURRENT_SESSION_KEY);
    var requestId = ++referenceRequestSeq;
    referenceRequests[targetSessionId] = requestId;
    query = String(query || referenceQueryFromPrompt(ui.prompt.value)).trim();
    if (query.length < 2) {
      ui.referenceState.textContent = "Escribe una petición más descriptiva para buscar referencias.";
      return;
    }
    ui.referenceQuery.value = query;
    ui.referenceState.textContent = "Buscando referencias…";
    var candidates = referenceFallbackQueries(query);
    var merged = [];
    var seen = {};

    function next(index) {
      if (merged.length >= 3 || index >= candidates.length) {
        if (referenceRequests[targetSessionId] !== requestId) return;
        var results = merged.slice(0, 3);
        saveReferenceDiscovery(targetSessionId, query, results);
        if (localStorage.getItem(CURRENT_SESSION_KEY) === targetSessionId) renderReferenceResults();
        ui.referenceState.textContent = results.length === 3
          ? "3 opciones encontradas. Elige una para adjuntarla a la tarea."
          : (results.length ? results.length + " opciones encontradas." : "No encontré imágenes útiles. Prueba otros términos.");
        return;
      }
      requestBuffer(referenceApiUrl(candidates[index]), function (error, bytes) {
        if (!error) {
          try {
            parseReferenceResults(JSON.parse(bytes.toString("utf8"))).forEach(function (ref) {
              if (!seen[ref.sourceUrl]) {
                seen[ref.sourceUrl] = true;
                merged.push(ref);
              }
            });
          } catch (e) {}
        }
        next(index + 1);
      });
    }
    next(0);
  }

  function extensionForMime(mime) {
    if (mime === "image/png") return ".png";
    if (mime === "image/webp") return ".webp";
    if (mime === "image/gif") return ".gif";
    return ".jpg";
  }

  function referenceKind(filePath, mime) {
    var ext = path.extname(filePath || "").toLowerCase();
    if (/^video\//i.test(mime || "") || /\.(mp4|mov|m4v|webm|avi|mkv)$/i.test(ext)) return "video";
    if (/^image\//i.test(mime || "") || /\.(png|jpe?g|webp|gif)$/i.test(ext)) return "image";
    return "";
  }

  function writeCanvasJpeg(canvas, target) {
    try {
      var dataUrl = canvas.toDataURL("image/jpeg", 0.9);
      var comma = dataUrl.indexOf(",");
      if (comma < 0) return false;
      fs.writeFileSync(target, Buffer.from(dataUrl.slice(comma + 1), "base64"));
      return isFile(target);
    } catch (e) { return false; }
  }

  function normalizeImageWithBrowser(filePath, target, callback) {
    if (typeof Image === "undefined" || !document || typeof document.createElement !== "function") return callback(false);
    var canvas = document.createElement("canvas");
    if (!canvas || typeof canvas.getContext !== "function" || typeof canvas.toDataURL !== "function") return callback(false);
    var image = new Image();
    var done = false;
    var timer = setTimeout(function () { if (!done) { done = true; callback(false); } }, 15000);
    image.onload = function () {
      if (done) return;
      try {
        var maxWidth = 1280;
        var scale = image.width > maxWidth ? maxWidth / image.width : 1;
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        var ctx = canvas.getContext("2d");
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        var ok = writeCanvasJpeg(canvas, target);
        done = true;
        clearTimeout(timer);
        callback(ok);
      } catch (e) {
        done = true;
        clearTimeout(timer);
        callback(false);
      }
    };
    image.onerror = function () { if (!done) { done = true; clearTimeout(timer); callback(false); } };
    image.src = localFileUrl(filePath);
  }

  function normalizeImageForVision(filePath, mime, callback) {
    var ext = path.extname(filePath || "").toLowerCase();
    if (!/\.(gif|webp)$/i.test(ext) && !/image\/(gif|webp)/i.test(mime || "")) {
      return callback(null, filePath, []);
    }
    var target = filePath.replace(/\.[^.]+$/, "") + "-vision.jpg";
    normalizeImageWithBrowser(filePath, target, function (browserOk) {
      if (browserOk) return callback(null, target, [filePath]);
      var ffmpeg = findExecutable("ffmpeg");
      if (ffmpeg) {
        return cp.execFile(ffmpeg, [
          "-hide_banner", "-loglevel", "error", "-y", "-i", filePath,
          "-frames:v", "1", "-vf", "scale=w='min(1280,iw)':h=-2", target
        ], { timeout: 30000 }, function (error) {
          if (!error && isFile(target)) return callback(null, target, [filePath]);
          var sipsFallback = process.platform === "darwin" ? findExecutable("sips") : null;
          if (!sipsFallback) return callback(null, filePath, []);
          cp.execFile(sipsFallback, ["-s", "format", "jpeg", filePath, "--out", target], { timeout: 30000 }, function (sipsError) {
            callback(null, !sipsError && isFile(target) ? target : filePath, !sipsError && isFile(target) ? [filePath] : []);
          });
        });
      }
      var sips = process.platform === "darwin" ? findExecutable("sips") : null;
      if (!sips) return callback(null, filePath, []);
      cp.execFile(sips, ["-s", "format", "jpeg", filePath, "--out", target], { timeout: 30000 }, function (error) {
        callback(null, !error && isFile(target) ? target : filePath, !error && isFile(target) ? [filePath] : []);
      });
    });
  }

  function safeReferenceName(name) {
    return String(name || "reference").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "reference";
  }

  function cleanupReferenceFiles(ref) {
    if (!ref) return;
    var root = path.resolve(runtimeDirectory(), "references") + path.sep;
    var candidates = [];
    if (ref.localPath) candidates.push(ref.localPath);
    if (Array.isArray(ref.framePaths)) candidates = candidates.concat(ref.framePaths);
    candidates.forEach(function (candidate) {
      try {
        var resolved = path.resolve(candidate);
        if (resolved.indexOf(root) !== 0) return;
        if (typeof fs.unlinkSync === "function" && isFile(resolved)) fs.unlinkSync(resolved);
      } catch (e) {}
    });
  }

  function cleanupSessionReferenceFiles(session) {
    if (!session) return;
    cleanupReferenceFiles(session.reference);
    var turns = Array.isArray(session.turns) ? session.turns : [];
    for (var i = 0; i < turns.length; i++) cleanupReferenceFiles(turns[i] && turns[i].reference);
    try {
      if (session.id && typeof fs.rmSync === "function") {
        fs.rmSync(path.join(runtimeDirectory(), "references", safeReferenceName(session.id)), { recursive: true, force: true });
      }
    } catch (e) {}
  }

  function userReferenceDirectory(sessionId) {
    sessionId = sessionId || currentSession().id;
    var dir = path.join(runtimeDirectory(), "references", safeReferenceName(sessionId));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  function extractVideoFramesWithBrowser(videoPath, dir, callback) {
    if (!document || typeof document.createElement !== "function") return callback(new Error("CEF video no disponible."));
    var video = document.createElement("video");
    var canvas = document.createElement("canvas");
    if (!video || !canvas || typeof canvas.getContext !== "function" || typeof canvas.toDataURL !== "function") {
      return callback(new Error("CEF video no disponible."));
    }
    var done = false;
    var frames = [];
    var timer = setTimeout(function () {
      if (!done) { done = true; callback(new Error("La lectura nativa del video agotó el tiempo.")); }
    }, 45000);
    function finish(error) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { video.pause(); } catch (e) {}
      video.src = "";
      callback(error || null, error ? [] : frames);
    }
    function captureAt(times, index) {
      if (index >= times.length) return frames.length ? finish(null) : finish(new Error("No pude extraer fotogramas del video."));
      video.onseeked = function () {
        if (done) return;
        try {
          var vw = Number(video.videoWidth) || 0;
          var vh = Number(video.videoHeight) || 0;
          if (!(vw > 0 && vh > 0)) throw new Error("El video no expuso dimensiones válidas.");
          var scale = vw > 960 ? 960 / vw : 1;
          canvas.width = Math.max(1, Math.round(vw * scale));
          canvas.height = Math.max(1, Math.round(vh * scale));
          canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
          var frame = path.join(dir, "video-frame-" + (index + 1 < 10 ? "0" : "") + (index + 1) + ".jpg");
          if (writeCanvasJpeg(canvas, frame)) frames.push(frame);
          captureAt(times, index + 1);
        } catch (e) { finish(e); }
      };
      try { video.currentTime = times[index]; }
      catch (e) { finish(e); }
    }
    video.onerror = function () { finish(new Error("El motor visual de AE AI no pudo decodificar este video.")); };
    video.onloadedmetadata = function () {
      if (done) return;
      var duration = Number(video.duration) || 0;
      if (!(duration > 0)) return finish(new Error("No pude leer la duración del video."));
      var safeEnd = Math.max(0.01, duration - Math.min(0.08, duration * 0.02));
      var times = [0.12, 0.37, 0.62, 0.87].map(function (ratio) {
        return Math.min(safeEnd, Math.max(0, duration * ratio));
      });
      captureAt(times, 0);
    };
    video.preload = "metadata";
    video.muted = true;
    video.src = localFileUrl(videoPath);
    try { if (typeof video.load === "function") video.load(); } catch (e) {}
  }

  function extractVideoFramesWithFfmpeg(videoPath, dir, callback) {
    var ffmpeg = findExecutable("ffmpeg");
    var ffprobe = findExecutable("ffprobe");
    if (!ffmpeg || !ffprobe) return callback(new Error("No hay decodificador externo disponible."));
    cp.execFile(ffprobe, [
      "-v", "error", "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1", videoPath
    ], { encoding: "utf8", timeout: 15000 }, function (probeError, stdout) {
      if (probeError) return callback(probeError);
      var duration = parseFloat(String(stdout || "").trim());
      if (!(duration > 0)) return callback(new Error("No pude leer la duración del video."));
      var prefix = path.join(dir, "video-frame-%02d.jpg");
      var fps = Math.max(0.01, 4 / duration);
      cp.execFile(ffmpeg, [
        "-hide_banner", "-loglevel", "error", "-y", "-i", videoPath,
        "-vf", "fps=" + fps + ",scale=w='min(960,iw)':h=-2",
        "-frames:v", "4", prefix
      ], { timeout: 60000 }, function (ffmpegError) {
        if (ffmpegError) return callback(ffmpegError);
        var frames = [];
        for (var i = 1; i <= 4; i++) {
          var frame = path.join(dir, "video-frame-" + (i < 10 ? "0" : "") + i + ".jpg");
          if (isFile(frame)) frames.push(frame);
        }
        callback(frames.length ? null : new Error("No pude extraer fotogramas del video."), frames);
      });
    });
  }

  function extractVideoReferenceFrames(videoPath, dir, callback) {
    extractVideoFramesWithBrowser(videoPath, dir, function (browserError, browserFrames) {
      if (!browserError && browserFrames && browserFrames.length) return callback(null, browserFrames);
      extractVideoFramesWithFfmpeg(videoPath, dir, function (ffmpegError, ffmpegFrames) {
        if (!ffmpegError && ffmpegFrames && ffmpegFrames.length) return callback(null, ffmpegFrames);
        callback(new Error("No pude leer este video de referencia. AE AI intentó su decodificador integrado" +
          (findExecutable("ffmpeg") ? " y el respaldo FFmpeg." : ". Si el códec es poco común, conviértelo a MP4 H.264 o MOV compatible.")));
      });
    });
  }

  function selectReference(ref) {
    var targetSessionId = localStorage.getItem(CURRENT_SESSION_KEY);
    var selectionId = ++referenceSelectionSeq;
    referenceSelections[targetSessionId] = selectionId;
    ui.referenceState.textContent = "Preparando la referencia seleccionada…";
    requestBuffer(ref.imageUrl, function (error, bytes) {
      if (referenceSelections[targetSessionId] !== selectionId) return;
      if (error) {
        ui.referenceState.textContent = "No se pudo descargar esa referencia: " + error.message;
        return;
      }
      try {
        var dir = userReferenceDirectory(targetSessionId);
        var file = path.join(dir, Date.now() + "-" + safeReferenceName(ref.title) + extensionForMime(ref.mime));
        fs.writeFileSync(file, bytes);
        normalizeImageForVision(file, ref.mime, function (_normalizeError, visionFile, extraPaths) {
          if (referenceSelections[targetSessionId] !== selectionId) {
            cleanupReferenceFiles({ localPath: visionFile, framePaths: extraPaths });
            return;
          }
          try {
            updateSessionById(targetSessionId, function (item) {
              cleanupReferenceFiles(item.reference);
              item.reference = {
                title: ref.title, imageUrl: ref.imageUrl, sourceUrl: ref.sourceUrl,
                mime: ref.mime, license: ref.license, localPath: visionFile,
                kind: "image", origin: "discover", framePaths: extraPaths || []
              };
            });
            if (localStorage.getItem(CURRENT_SESSION_KEY) === targetSessionId) renderReferenceResults();
            ui.referenceState.textContent = "Referencia visual lista y adjunta para la próxima tarea.";
          } catch (normalizeCommitError) {
            ui.referenceState.textContent = "No se pudo guardar la referencia: " + normalizeCommitError.message;
          }
        });
      } catch (e) {
        ui.referenceState.textContent = "No se pudo guardar la referencia: " + e.message;
      }
    });
  }

  function attachUserReference(fileObject) {
    var targetSessionId = localStorage.getItem(CURRENT_SESSION_KEY);
    var sourcePath = fileObject && (fileObject.path || fileObject.name);
    var mime = fileObject && fileObject.type ? String(fileObject.type) : "";
    if (!sourcePath || !isFile(sourcePath)) {
      ui.referenceState.textContent = "No pude acceder al archivo seleccionado.";
      return;
    }
    var kind = referenceKind(sourcePath, mime);
    if (!kind) {
      ui.referenceState.textContent = "Ese archivo no es una imagen o video compatible.";
      return;
    }
    var dir;
    var target;
    try {
      ui.referenceState.textContent = kind === "video" ? "Analizando el video de referencia…" : "Adjuntando tu referencia…";
      dir = userReferenceDirectory(targetSessionId);
      target = path.join(dir, Date.now() + "-" + safeReferenceName(path.basename(sourcePath)));
      fs.copyFileSync(sourcePath, target);
    } catch (e) {
      ui.referenceState.textContent = "No se pudo preparar la referencia: " + e.message;
      if (ui.referenceFile) ui.referenceFile.value = "";
      return;
    }

    function commit(frames, visionPath) {
      visionPath = visionPath || target;
      var preview = kind === "video" ? frames[0] : visionPath;
      updateSessionById(targetSessionId, function (item) {
        cleanupReferenceFiles(item.reference);
        item.reference = {
          title: path.basename(sourcePath), imageUrl: localFileUrl(preview), sourceUrl: "",
          mime: mime, license: "Referencia del usuario", localPath: visionPath,
          kind: kind, origin: "user", framePaths: frames
        };
      });
      if (localStorage.getItem(CURRENT_SESSION_KEY) === targetSessionId) renderReferenceResults();
      ui.referenceState.textContent = kind === "video"
        ? "Video adjunto. Sus fotogramas se usarán automáticamente como referencia en la próxima tarea."
        : "Tu imagen está adjunta y se usará automáticamente como referencia en la próxima tarea.";
      if (ui.referenceFile) ui.referenceFile.value = "";
    }

    if (kind === "video") {
      extractVideoReferenceFrames(target, dir, function (error, frames) {
        if (error) {
          try { if (typeof fs.unlinkSync === "function" && isFile(target)) fs.unlinkSync(target); } catch (e) {}
          ui.referenceState.textContent = "No se pudo preparar la referencia: " + error.message;
          if (ui.referenceFile) ui.referenceFile.value = "";
          return;
        }
        commit(frames);
      });
    } else {
      normalizeImageForVision(target, mime, function (_normalizeError, visionFile, extraPaths) {
        commit(extraPaths || [], visionFile);
      });
    }
  }

  function scheduleReferenceSearch() {
    if (referenceTimer) clearTimeout(referenceTimer);
    if (!ui.autoReferences.checked || ui.prompt.value.trim().length < 12) return;
    if (classifyIntent(ui.prompt.value) !== "edit") return;
    referenceTimer = setTimeout(function () {
      var query = referenceQueryFromPrompt(ui.prompt.value);
      var queryKey = localStorage.getItem(CURRENT_SESSION_KEY) + ":" + query;
      if (!query || queryKey === lastAutoReferenceQuery) return;
      lastAutoReferenceQuery = queryKey;
      discoverReferences(query);
    }, 1000);
  }

  function currentAeAiVersion() {
    try {
      var info = fs.readFileSync(path.join(appDataRoot(), "install-info.txt"), "utf8");
      var match = String(info).match(/^version=(.+)$/m);
      if (match) return match[1].trim();
    } catch (e) {}
    try {
      var manifest = fs.readFileSync(path.join(extDir, "CSXS", "manifest.xml"), "utf8");
      var version = String(manifest).match(/ExtensionBundleVersion="([^"]+)"/);
      if (version) return version[1];
    } catch (e2) {}
    return "0.0.0";
  }

  function compareSemver(a, b) {
    function nums(v) { return String(v || "").replace(/^v/, "").split("-")[0].split(".").map(function (n) { return parseInt(n, 10) || 0; }); }
    var aa = nums(a), bb = nums(b);
    for (var i = 0; i < 3; i++) {
      if ((aa[i] || 0) !== (bb[i] || 0)) return (aa[i] || 0) < (bb[i] || 0) ? -1 : 1;
    }
    return 0;
  }

  function targetName() {
    if (process.platform === "darwin") return process.arch === "arm64" ? "macos-arm64" : (process.arch === "x64" ? "macos-x64" : "");
    if (process.platform === "win32" && process.arch === "x64") return "windows-x64";
    return "";
  }

  function validateUpdateManifest(manifest) {
    if (!manifest || manifest.schema !== 1 || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(manifest.version || "")) || !Array.isArray(manifest.assets)) {
      throw new Error("El manifiesto de actualización no es válido.");
    }
    for (var i = 0; i < manifest.assets.length; i++) {
      var a = manifest.assets[i];
      if (!a || !a.name || path.basename(a.name) !== a.name || /[\\/]/.test(a.name) || !/^[a-f0-9]{64}$/.test(String(a.sha256 || "")) || !(a.bytes > 0) || a.bytes > 1024 * 1024 * 1024) throw new Error("El manifiesto contiene un asset inválido.");
    }
    return manifest;
  }

  function setUpdateUi(message, buttonText, disabled) {
    if (ui.updateState) ui.updateState.textContent = message;
    if (ui.updateButton) {
      ui.updateButton.textContent = buttonText || "Comprobar";
      ui.updateButton.disabled = !!disabled;
    }
  }

  function checkForUpdates() {
    if (!ui.updateState || !ui.updateButton) return;
    pendingUpdateAsset = null;
    downloadedUpdatePath = "";
    var current = currentAeAiVersion();
    if (ui.updateVersion) ui.updateVersion.textContent = "Instalada: " + current;
    setUpdateUi("Buscando una versión nueva…", "Comprobando…", true);
    requestBuffer(UPDATE_MANIFEST_URL, function (error, bytes) {
      if (error) {
        if (/HTTP 404|respondió con HTTP 404/i.test(String(error.message || error))) {
          if (ui.updateVersion) ui.updateVersion.textContent = "Instalada: " + current;
          return setUpdateUi("El canal de actualizaciones todavía no tiene una versión publicada. Puedes seguir usando esta instalación normalmente.", "Comprobar", false);
        }
        return setUpdateUi("No se pudo comprobar la actualización: " + error.message, "Reintentar", false);
      }
      try {
        var manifest = validateUpdateManifest(JSON.parse(bytes.toString("utf8")));
        var target = targetName();
        var asset = null;
        for (var i = 0; i < manifest.assets.length; i++) {
          if (manifest.assets[i].kind === "ae-ai-installer" && manifest.assets[i].target === target) { asset = manifest.assets[i]; break; }
        }
        if (!asset) return setUpdateUi("Esta plataforma no tiene un instalador de actualización compatible.", "Comprobar", false);
        if (compareSemver(manifest.version, current) <= 0) {
          if (ui.updateVersion) ui.updateVersion.textContent = "Instalada: " + current + " · al día";
          return setUpdateUi("AE AI está actualizado.", "Comprobar", false);
        }
        pendingUpdateAsset = asset;
        if (ui.updateVersion) ui.updateVersion.textContent = "Instalada: " + current + " · disponible: " + manifest.version;
        setUpdateUi("Hay una actualización disponible. Se verificará antes de abrirla.", "Descargar", false);
      } catch (e) {
        setUpdateUi("No se pudo validar la actualización: " + e.message, "Reintentar", false);
      }
    });
  }

  function downloadVerifiedUpdate(asset) {
    var downloads = path.join(os.homedir(), "Downloads");
    var target = path.join(downloads, asset.name);
    var temp = target + ".download-" + Date.now();
    var url = UPDATE_ASSET_BASE + encodeURIComponent(asset.name);
    var redirects = 0;
    var finished = false;
    var hash = crypto.createHash("sha256");
    var bytes = 0;
    fs.mkdirSync(downloads, { recursive: true });
    setUpdateUi("Descargando y verificando…", "Descargando…", true);

    function failUpdate(error) {
      if (finished) return;
      finished = true;
      try { fs.unlinkSync(temp); } catch (e) {}
      setUpdateUi("No se pudo descargar la actualización: " + error.message, "Reintentar", false);
    }
    function fetchToFile(nextUrl) {
      var file = fs.createWriteStream(temp);
      var req = https.get(nextUrl, { headers: { "User-Agent": "AE-AI/0.5.0 updater" } }, function (res) {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.destroy(); try { fs.unlinkSync(temp); } catch (e) {}
          if (++redirects > 5) return failUpdate(new Error("Demasiadas redirecciones."));
          return fetchToFile(urlTools.resolve(nextUrl, res.headers.location));
        }
        if (res.statusCode !== 200) { res.resume(); file.destroy(); return failUpdate(new Error("HTTP " + res.statusCode)); }
        res.on("data", function (chunk) {
          bytes += chunk.length;
          var maxBytes = Math.min(asset.bytes + 1024 * 1024, 1024 * 1024 * 1024);
          if (bytes > maxBytes) {
            req.destroy(new Error("La descarga excedió el tamaño esperado.")); return;
          }
          hash.update(chunk);
        });
        res.pipe(file);
        file.on("finish", function () {
          file.close(function () {
            if (finished) return;
            var digest = hash.digest("hex");
            if (bytes !== asset.bytes || digest !== asset.sha256) return failUpdate(new Error("La verificación SHA-256/tamaño no coincide."));
            try { fs.renameSync(temp, target); }
            catch (e) { return failUpdate(e); }
            finished = true;
            downloadedUpdatePath = target;
            setUpdateUi("Descarga verificada. Guarda tu proyecto y cierra After Effects antes de instalar.", "Abrir instalador", false);
          });
        });
      });
      req.setTimeout(30000, function () { req.destroy(new Error("La descarga agotó 30 s.")); });
      req.on("error", failUpdate);
      file.on("error", failUpdate);
    }
    fetchToFile(url);
  }

  function handleUpdateButton() {
    if (downloadedUpdatePath && isFile(downloadedUpdatePath)) {
      try { cs.openURLInDefaultBrowser(localFileUrl(downloadedUpdatePath)); }
      catch (e) { setUpdateUi("No pude abrir el instalador: " + e.message, "Abrir instalador", false); }
      return;
    }
    if (pendingUpdateAsset) return downloadVerifiedUpdate(pendingUpdateAsset);
    checkForUpdates();
  }

  function readHistory() {
    try {
      var parsed = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) { return []; }
  }

  function saveHistory(prompt) {
    var list = readHistory();
    list = list.filter(function (entry) { return entry.prompt !== prompt; });
    list.unshift({ prompt: prompt, at: new Date().toISOString() });
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, 8)));
    renderHistory();
  }

  function renderHistory() {
    var list = readHistory();
    ui.history.innerHTML = "";
    if (!list.length) {
      var empty = document.createElement("p");
      empty.className = "muted";
      empty.textContent = "Todavía no hay tareas.";
      ui.history.appendChild(empty);
      return;
    }
    list.forEach(function (entry) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "history-item";
      var title = document.createElement("span");
      title.textContent = entry.prompt.length > 80 ? entry.prompt.slice(0, 77) + "…" : entry.prompt;
      var meta = document.createElement("small");
      meta.textContent = new Date(entry.at).toLocaleString();
      button.appendChild(title);
      button.appendChild(meta);
      button.addEventListener("click", function () {
        ui.prompt.value = entry.prompt;
        updateCount();
        ui.prompt.focus();
      });
      ui.history.appendChild(button);
    });
  }

  function normalizeIntentText(text) {
    return String(text || "").toLowerCase()
      .replace(/[áàäâ]/g, "a").replace(/[éèëê]/g, "e")
      .replace(/[íìïî]/g, "i").replace(/[óòöô]/g, "o")
      .replace(/[úùüû]/g, "u").replace(/ñ/g, "n");
  }

  function classifyIntent(text) {
    var t = normalizeIntentText(text).trim();
    if (!t) return "chat";
    var bare = t.replace(/^[¡¿\s]+/, "").replace(/[!?.,\s]+$/, "");
    if (/^(hola|hey|buenas|buenos dias|buenas tardes|buenas noches|gracias|ok|okay|perfecto|genial|que tal)$/.test(bare)) return "chat";

    var sceneWords = /(esta|mi|la) (composicion|escena|animacion|intro|layout|diseno)|lo que tengo|proyecto activo|composicion activa|escena activa|esto que ves|lo que ves|esto de aqui/;

    // Explicit edit commands win over later review/advice language. This keeps
    // "mejora esto y revisa el resultado" in edit mode while preserving
    // questions such as "¿cómo mejorarías esta composición?" as read-only.
    var strongEditWords = /\b(crea|haz|mueve|centra|cambia|modifica|elimina|borra|duplica|anima|agrega|anade|ajusta|reorganiza|mejora|corrige|pon|quita|reduce|aumenta|convierte|aplica|reemplaza|recorta|alinea|distribuye)\b/;
    if (strongEditWords.test(t)) return "edit";

    var adviceWords = /que opin|opinion|consejo|como mejorarias|como lo mejorarias|que cambiarias|que le falta|se ve bien|que te parece|analiza|revisa/;
    if (adviceWords.test(t)) return sceneWords.test(t) ? "scene-read" : "knowledge";

    if (/como (puedo|hago|se hace|funciona)|para que sirve|que es |cual es |por que |como funciona|que significa/.test(t)) return "knowledge";

    var editWords = /(crear|hacer|mover|centrar|cambiar|modificar|eliminar|borrar|duplicar|animar|agregar|ajustar|reorganizar|mejorar|corregir|poner|quitar)/;
    if (editWords.test(t)) return "edit";

    if (/^(puedes|podrias|quiero|necesito|deseo)/.test(t) && /(composicion|escena|capa|texto|logo|imagen|video|efecto|keyframe|after effects|ae)/.test(t)) return "edit";
    if (/[?¿]/.test(String(text || ""))) return "knowledge";
    return "edit";
  }

  function intentInstruction(intent) {
    if (intent === "chat") {
      return "MODO CONVERSACIÓN: responde de forma breve y natural. NO llames ninguna herramienta MCP, NO inspecciones After Effects y NO hagas acciones en el proyecto.";
    }
    if (intent === "knowledge") {
      return "MODO CONSULTA GENERAL: responde sin inspeccionar ni modificar After Effects. Puedes usar search_motion_knowledge/get_motion_technique si una técnica concreta de motion se beneficiaría del conocimiento curado; no uses herramientas de escena.";
    }
    if (intent === "scene-read") {
      return "MODO ASESORÍA CONTEXTUAL: puedes usar inspect_scene y, solo si la imagen aporta información real, review_scene. Puedes consultar search_motion_knowledge para técnicas relevantes. Es ESTRICTAMENTE SOLO LECTURA: no uses build_scene, modify_scene ni ninguna operación que cambie el proyecto. Da recomendaciones; no las ejecutes.";
    }
    return "MODO EDICIÓN: el usuario quiere cambios reales en After Effects. Inspecciona solo lo necesario, ejecuta de forma agrupada y aplica la revisión visual de Fase 5 cuando corresponda.";
  }

  function afterEffectsRuntimeContext() {
    try {
      var host = cs && typeof cs.getHostEnvironment === "function" ? cs.getHostEnvironment() : null;
      if (!host || !host.appVersion) return "";
      var version = String(host.appVersion);
      var major = parseInt(version.split(".")[0], 10);
      var year = major >= 22 && major <= 99 ? 2000 + major : null;
      var label = "ENTORNO DETECTADO: After Effects " + version + (year ? " (" + year + ")" : "") + ". ";
      label += "Adapta la técnica a las capacidades reales de esta versión. Puedes usar plugins, renderers y herramientas externas disponibles, pero si una función no existe en esta versión o falla, cambia de vía sin quedarte bloqueado.";
      return label;
    } catch (e) { return ""; }
  }

  function buildPrompt(userPrompt, intent) {
    intent = intent || classifyIntent(userPrompt);
    var presetInstruction = PRESETS[ui.preset.value] || PRESETS.balanced;
    var context = sessionContext();
    var aeRuntime = (intent === "edit" || intent === "scene-read") ? afterEffectsRuntimeContext() : "";
    var usesScene = intent === "edit" || intent === "scene-read";
    var reference = usesScene ? currentReference() : null;
    var referenceText = "";
    if (reference) {
      referenceText = "REFERENCIA ACTIVA OBLIGATORIA: " + reference.title + ". El usuario ya la adjuntó/seleccionó; úsala automáticamente como guía sin pedir que vuelva a decir 'usa la referencia'. ";
      referenceText += "IMPORTANTE: la referencia se entrega también como entrada visual real al modelo. Debes observar sus píxeles/fotogramas y describir/usar lo que realmente ves; no te bases solo en el nombre del archivo. ";
      referenceText += reference.kind === "video"
        ? "Es un video. Se adjuntaron varios fotogramas muestreados del mismo video para leer diseño, poses, ritmo y movimiento. El archivo local original está en: " + reference.localPath + ". "
        : "La imagen está adjunta al turno como entrada visual. ";
      if (reference.sourceUrl) referenceText += "Fuente: " + reference.sourceUrl + ". ";
      referenceText += "Trátala como guía visual; no la conviertas automáticamente en el asset final ni la copies literalmente.";
    }
    return [
      "Eres AE AI, asistente de conversación y trabajo para Adobe After Effects.",
      "Clasificación de intención: " + intent + ". " + intentInstruction(intent),
      aeRuntime,
      (intent === "edit" || intent === "scene-read") ? "Preset activo: " + presetInstruction : "",
      intent === "edit" ? "PRIORIZA RESULTADOS EDITABLES Y ROBUSTOS: cuando varias técnicas den un resultado equivalente, prefiere una solución editable dentro de After Effects. Pero puedes usar cualquier técnica, renderer, plugin o herramienta disponible si produce un resultado mejor o más adecuado para la petición; no sacrifiques calidad por una regla rígida de implementación." : "",
      intent === "edit" ? "Puedes usar Cinema 4D, Cineware, renderers 3D u otras herramientas externas si realmente ayudan a resolver mejor la tarea. No te limites artificialmente. Pero si una herramienta externa no está disponible, falla, pide una interacción que no puedes completar o deja de responder, no te quedes esperando ni repitas indefinidamente: abandona esa vía tras un intento razonable y continúa con la mejor alternativa disponible dentro de After Effects u otra técnica viable." : "",
      referenceText ? "Una referencia adjunta es contexto visual; úsala como guía sin copiarla literalmente." : "",
      intent === "edit" ? "PREFLIGHT DE CONOCIMIENTO: si la petición usa una técnica especializada (parallax, rigging, tracking, morphing, cámara 3D, compositing, keying/roto, partículas, kinetic typography, UI/product motion, glow, MOGRT, etc.), DEBES llamar search_motion_knowledge antes del primer write. Recupera solo 3–5 resultados. Si el resultado principal es curated o synthesized, carga esa técnica con get_motion_technique antes de planificar. Si no hay coincidencia útil, continúa con criterio profesional sin insistir." : "",
      intent === "edit" ? "EJECUCIÓN COMPACTA: después del preflight y de una sola inspección cuando haga falta, usa build_scene/modify_scene como primera opción. Ya soportan duplicar capas existentes, parenting entre capas creadas en la misma llamada, máscaras, efectos configurables, transforms, keyframes y expresiones. Baja a run_batch/primitivas solo para operaciones que esas APIs todavía no puedan expresar. Evita una llamada por propiedad." : "",
      intent === "edit" ? "JERARQUÍA Y CONTROLADORES: antes de animar varias capas con el mismo desplazamiento, escala, rotación, entrada, salida o movimiento de cámara/grupo, evalúa si deben compartir un padre o Null controlador. Si comparten movimiento, vincúlalas y anima el padre una sola vez; deja en los hijos solo offsets o animaciones realmente independientes. No dupliques keyframes idénticos capa por capa. Usa parentLayerIndex/parentLayerId o parent_layer y conserva jerarquías cortas y lógicas. No parentar elementos que necesiten movimiento independiente solo por reducir keyframes." : "",
      intent === "edit" ? "FASE 5 — REVISIÓN VISUAL: si cambias layout, composición, tipografía visible, efectos visibles o movimiento, termina la primera pasada con review_scene. Corrige solo problemas concretos con modify_scene. Si corregiste algo, haz una sola review_scene final; si la primera revisión está bien, no repitas." : "",
      intent === "edit" ? "Evita acción→comprobar→acción→comprobar. Agrupa la ejecución y la verificación al final." : "",
      "No edites el código de AE AI ni archivos del sistema.",
      "Solo pregunta al usuario cuando falte una decisión realmente imprescindible para proceder con seguridad. Si puedes resolver la petición razonablemente sin preguntar, continúa.",
      "Responde en español y sé concreto.",
      context ? "\n" + context : "",
      referenceText ? "\n" + referenceText : "",
      "",
      "Petición del usuario:",
      userPrompt
    ].join("\n");
  }

  function eventLabel(event) {
    var item = event && event.item;
    if (!item) return null;
    if (event.type === "item.completed" && item.type === "agent_message") {
      return { text: item.text, kind: "answer" };
    }
    if (item.type === "mcp_tool_call") {
      var tool = item.tool || item.name || "herramienta";
      if (/^(search_motion_knowledge|get_motion_technique|list_motion_sources)$/.test(String(tool))) return null;
      var callId = item.id || item.call_id || item.tool_call_id || "";
      var phase = event.type === "item.started" ? "started" : "completed";
      return {
        text: (phase === "started" ? "Ejecutando en After Effects: " : "Completado: ") + tool,
        kind: "progress",
        tool: tool,
        callId: String(callId || ""),
        event: phase
      };
    }
    if (item.type === "command_execution" && event.type === "item.started") {
      return { text: "Preparando la tarea…", kind: "progress" };
    }
    return null;
  }

  function consumeLines(state, chunk, onEvent) {
    state.buffer += chunk;
    var lines = state.buffer.split(/\r?\n/);
    state.buffer = lines.pop();
    lines.forEach(function (line) {
      if (!line.trim()) return;
      try { onEvent(JSON.parse(line)); }
      catch (e) { appendOutput(line, "progress"); }
    });
  }

  function adoptExistingCodexAuth(codex, callback) {
    if (!codex) { callback(false); return; }
    cp.execFile(codex, ["login", "status"], { timeout: 10000, env: defaultCodexEnvironment() }, function (error, stdout, stderr) {
      var message = String(stdout || stderr || "");
      if (error || !/logged in/i.test(message)) { callback(false); return; }
      var source = path.join(defaultCodexHome(), "auth.json");
      var target = path.join(codexHome(), "auth.json");
      var sourceInstallation = path.join(defaultCodexHome(), "installation_id");
      var targetInstallation = path.join(codexHome(), "installation_id");
      if (!isFile(source)) { callback(false); return; }
      try {
        fs.mkdirSync(codexHome(), { recursive: true });
        fs.copyFileSync(source, target);
        if (isFile(sourceInstallation)) fs.copyFileSync(sourceInstallation, targetInstallation);
        if (typeof fs.chmodSync === "function") {
          fs.chmodSync(target, 384);
          if (isFile(targetInstallation)) fs.chmodSync(targetInstallation, 384);
        }
      } catch (copyError) {
        callback(false);
        return;
      }
      cp.execFile(codex, ["login", "status"], { timeout: 10000, env: codexEnvironment() }, function (verifyError, verifyOut, verifyErr) {
        var verifyMessage = String(verifyOut || verifyErr || "");
        callback(!verifyError && /logged in/i.test(verifyMessage));
      });
    });
  }

  function checkAuth() {
    var codex = findCodex();
    ui.codexPath.textContent = codex || "No encontrado";
    if (!codex) {
      setConnection("Codex no está instalado", "err", false);
      return;
    }
    setConnection("Comprobando…", "", false);
    cp.execFile(codex, ["login", "status"], { timeout: 10000, env: codexEnvironment() }, function (error, stdout, stderr) {
      var message = String(stdout || stderr || "");
      if (!error && /logged in/i.test(message)) {
        setConnection("Conectado con ChatGPT", "ok", false);
      } else {
        adoptExistingCodexAuth(codex, function (adopted) {
          if (adopted) setConnection("Conectado con ChatGPT", "ok", false);
          else setConnection("Sin conectar", "err", true);
        });
      }
    });
  }

  function openExternalUrl(url, callback) {
    url = String(url || "").trim();
    if (!/^https?:\/\//i.test(url)) {
      if (callback) callback(new Error("URL no válida"));
      return;
    }
    var command;
    var args;
    if (process.platform === "darwin") {
      command = "/usr/bin/open";
      args = [url];
    } else if (process.platform === "win32") {
      command = process.env.ComSpec || "cmd.exe";
      args = ["/d", "/s", "/c", "start", "", url];
    } else {
      command = "xdg-open";
      args = [url];
    }
    cp.execFile(command, args, { timeout: 10000 }, function (error) {
      if (!error) {
        if (callback) callback(null);
        return;
      }
      try {
        cs.openURLInDefaultBrowser(url);
        if (callback) callback(null);
      } catch (fallbackError) {
        if (callback) callback(fallbackError || error);
      }
    });
  }

  function beginLogin() {
    var codex = findCodex();
    if (!codex || loginProcess) return;
    setConnection("Comprobando cuenta…", "warn", false);
    clearOutput();

    cp.execFile(codex, ["login", "status"], { timeout: 10000, env: codexEnvironment() }, function (statusError, stdout, stderr) {
      var statusMessage = String(stdout || stderr || "");
      if (!statusError && /logged in/i.test(statusMessage)) {
        setConnection("Conectado con ChatGPT", "ok", false);
        appendOutput("Tu cuenta ya está conectada.", "answer");
        return;
      }

      adoptExistingCodexAuth(codex, function (adopted) {
        if (adopted) {
          setConnection("Conectado con ChatGPT", "ok", false);
          appendOutput("Usé la sesión de ChatGPT que ya estaba iniciada en este equipo.", "answer");
          return;
        }

        loginOpened = false;
        var authorized = false;
        setConnection("Esperando autorización…", "warn", false);
        appendOutput("Sigue las instrucciones para conectar tu cuenta de ChatGPT.", "progress");
        var child = cp.spawn(codex, ["login", "--device-auth"], {
          cwd: runtimeDirectory(),
          env: codexEnvironment()
        });
        loginProcess = child;

      function clearLoginTimers() {
        if (loginPollTimer && typeof clearInterval === "function") clearInterval(loginPollTimer);
        if (loginExpiryTimer) clearTimeout(loginExpiryTimer);
        loginPollTimer = null;
        loginExpiryTimer = null;
      }

      function markAuthorized() {
        if (authorized) return;
        authorized = true;
        clearLoginTimers();
        if (loginProcess === child) loginProcess = null;
        removeLoginHelp();
        setConnection("Conectado con ChatGPT", "ok", false);
        appendOutput("Cuenta conectada correctamente.", "answer");
        try { if (child && !child.killed) child.kill(); } catch (e) {}
      }

      function pollLoginStatus() {
        cp.execFile(codex, ["login", "status"], { timeout: 10000, env: codexEnvironment() }, function (error, out, err) {
          if (authorized || loginProcess !== child) return;
          var message = String(out || err || "");
          if (!error && /logged in/i.test(message)) markAuthorized();
        });
      }

      var loginOutputBuffer = "";
      function consume(chunk) {
        var text = stripTerminalCodes(chunk.toString("utf8"));
        if (!text) return;
        loginOutputBuffer = (loginOutputBuffer + "\n" + text).slice(-6000);
        var urlMatch = loginOutputBuffer.match(/https?:\/\/[^\s]+/);
        var codeMatch = loginOutputBuffer.match(/[A-Z0-9]{4}-[A-Z0-9]{4,5}/);
        var loginUrl = urlMatch ? urlMatch[0] : "";
        var loginCode = codeMatch ? codeMatch[0] : "";
        if (loginUrl || loginCode) renderLoginHelp(loginUrl, loginCode);
        if (loginUrl && !loginOpened) {
          loginOpened = true;
          setConnection("Autoriza en el navegador…", "warn", false);
          openExternalUrl(loginUrl, function (openError) {
            if (openError) {
              appendOutput("No pude abrir el navegador automáticamente. Usa el botón Abrir de nuevo o copia el enlace desde el panel.", "error");
              setConnection("Abre el enlace manualmente", "warn", false);
            }
          });
        }
      }

      child.stdout.on("data", consume);
      child.stderr.on("data", consume);
      child.on("error", function (error) {
        if (authorized) return;
        clearLoginTimers();
        loginProcess = null;
        appendOutput("No pude iniciar la autorización: " + friendlyError(error.message), "error");
        setConnection("No se pudo conectar", "err", true);
      });
      child.on("close", function (code) {
        if (authorized) return;
        clearLoginTimers();
        if (loginProcess === child) loginProcess = null;
        if (code === 0) {
          markAuthorized();
        } else {
          cp.execFile(codex, ["login", "status"], { timeout: 10000, env: codexEnvironment() }, function (error, out, err) {
            var message = String(out || err || "");
            if (!error && /logged in/i.test(message)) markAuthorized();
            else setConnection("No se pudo conectar", "err", true);
          });
        }
      });

      if (typeof setInterval === "function") loginPollTimer = setInterval(pollLoginStatus, 2500);
      loginExpiryTimer = setTimeout(function () {
        if (authorized || loginProcess !== child) return;
        clearLoginTimers();
        loginProcess = null;
        try { child.kill(); } catch (e) {}
        setConnection("Autorización expirada", "err", true);
        appendOutput("La autorización expiró. Pulsa Conectar para intentarlo de nuevo.", "error");
      }, 16 * 60 * 1000);
      });
    });
  }

  function improvePrompt() {
    var raw = ui.prompt.value.trim();
    if (!raw || active) { if (!raw) ui.prompt.focus(); return; }
    var codex = findCodex();
    if (!codex) { setRunning(false, "Codex no disponible"); return; }
    var args = [
      "exec", "--json", "--ephemeral", "--color", "never",
      "--sandbox", "read-only", "--skip-git-repo-check",
      "--cd", runtimeDirectory()
    ];
    if (ui.model.value) args.push("--model", ui.model.value);
    args.push("-");
    var task = [
      "Mejora la instrucción del usuario para usarla después en AE AI.",
      "NO hagas cambios en After Effects. No uses herramientas de escritura.",
      "Si la instrucción depende claramente de la composición activa (por ejemplo 'mejora esta composición'), puedes usar inspect_scene y, solo si aporta valor, review_scene para entender el contexto. Máximo una vez cada una.",
      "Conserva la intención original, vuelve la instrucción más clara y útil, y no inventes objetivos que el usuario no pidió.",
      "Devuelve SOLO el prompt mejorado en español, sin explicación, sin comillas y sin encabezados.",
      "Prompt original:",
      raw
    ].join("\n");
    var state = { buffer: "", answer: "", stderr: "" };
    setRunning(true, "Mejorando prompt…");
    active = cp.spawn(codex, args, { cwd: runtimeDirectory(), env: codexEnvironment() });
    active.stdout.on("data", function (chunk) {
      consumeLines(state, chunk.toString("utf8"), function (event) {
        var item = event && event.item;
        if (event.type === "item.completed" && item && item.type === "agent_message" && item.text) {
          state.answer += (state.answer ? "\n" : "") + item.text;
        }
      });
    });
    active.stderr.on("data", function (chunk) { state.stderr += chunk.toString("utf8"); });
    active.on("error", function (error) { setRunning(false, "No se pudo mejorar: " + friendlyError(error.message)); });
    active.on("close", function (code, signal) {
      active = null;
      if (!signal && code === 0 && state.answer.trim()) {
        ui.prompt.value = state.answer.trim();
        updateCount();
        scheduleReferenceSearch();
        ui.prompt.focus();
        setRunning(false, "Prompt mejorado · revisa y pulsa Ejecutar");
      } else if (signal) {
        setRunning(false, "Mejora cancelada");
      } else {
        setRunning(false, "No se pudo mejorar el prompt");
      }
    });
    active.stdin.end(task);
  }

  function runTask() {
    var prompt = ui.prompt.value.trim();
    if (!prompt || active) {
      if (!prompt) ui.prompt.focus();
      return;
    }
    var codex = findCodex();
    if (!codex) {
      clearOutput();
      appendOutput("Codex no está instalado. La versión final lo incluirá en el instalador.", "error");
      return;
    }

    var intent = classifyIntent(prompt);
    if (intent === "edit" || intent === "scene-read") {
      var bridgeRuntime = ensureManagedBridgeRuntime();
      if (!bridgeRuntime.ready) {
        clearOutput();
        appendOutput("AE AI no pudo preparar la conexión con After Effects. Reinstala AE AI para reparar los componentes locales.", "error");
        setRunning(false, "AE AI necesita reparación");
        return;
      }
    }
    var args = [
      "exec", "--json", "--ephemeral", "--color", "never",
      "--sandbox", "read-only", "--skip-git-repo-check",
      "--cd", runtimeDirectory()
    ];
    if (ui.model.value) args.push("--model", ui.model.value);
    var reference = (intent === "edit" || intent === "scene-read") ? currentReference() : null;
    if (reference) {
      var visualPaths = modelVisualPaths(reference);
      if (!visualPaths.length) {
        appendOutput("La referencia está seleccionada, pero AE AI no pudo preparar su archivo visual. Vuelve a seleccionarla o adjúntala otra vez.", "error");
        setRunning(false, "Referencia no disponible");
        return;
      }
      visualPaths.forEach(function (visualPath) {
        args.push("--image", visualPath);
      });
    }
    args.push("-");
    var taskPrompt = buildPrompt(prompt, intent);

    saveHistory(prompt);
    localStorage.setItem(MODEL_KEY, ui.model.value);
    var taskSessionId = localStorage.getItem(CURRENT_SESSION_KEY);
    var turnId = startSessionTurn(prompt, reference);
    collapseReferencePanel();
    renderReferenceResults();
    renderSessionTranscript();
    followConversation = true;
    scrollConversationBottom(true);
    ui.prompt.value = "";
    updateCount();
    if (referenceTimer) clearTimeout(referenceTimer);
    setRunning(true, "Trabajando…");

    var stalled = false;
    var lastActivityAt = Date.now();
    var lastActivityTool = "";
    var stallWatch = null;
    function touchTaskActivity() { lastActivityAt = Date.now(); }
    function stopStallWatch() {
      if (stallWatch && typeof clearInterval === "function") clearInterval(stallWatch);
      stallWatch = null;
    }
    function stallLimitMs() {
      return /render|export|aerender|render_queue/i.test(lastActivityTool) ? 300000 : 150000;
    }
    function stopStalledTask(processToKill) {
      if (!processToKill || stalled) return;
      stalled = true;
      appendOutput("La vía actual dejó de responder. AE AI la va a detener y probará otra técnica automáticamente.", "progress");
      setRunning(true, "Cambiando de estrategia…");
      try {
        var cancellation = window.__aeMcpCancelActiveJobs ? window.__aeMcpCancelActiveJobs() : null;
        if (cancellation && typeof cancellation.then === "function") {
          cancellation.then(function () { try { processToKill.kill(); } catch (e) {} }, function () { try { processToKill.kill(); } catch (e) {} });
        }
      } catch (e) {}
      setTimeout(function () { try { processToKill.kill(); } catch (e) {} }, 2500);
    }
    function startStallWatch(processToWatch) {
      stopStallWatch();
      if (typeof setInterval !== "function") return;
      stallWatch = setInterval(function () {
        if (active === processToWatch && Date.now() - lastActivityAt > stallLimitMs()) stopStalledTask(processToWatch);
      }, 10000);
    }
    function recoveryPrompt(blockedTool) {
      return taskPrompt + "\n\nRECUPERACIÓN AUTOMÁTICA: una ejecución anterior de esta misma tarea dejó de responder" +
        (blockedTool ? " mientras trabajaba con " + blockedTool : "") + ". No repitas inmediatamente la misma vía bloqueada. " +
        "Inspecciona una vez el estado ACTUAL del proyecto porque la ejecución anterior pudo haber aplicado cambios parciales. Conserva lo que esté correcto, evita duplicar elementos y continúa la petición original con otra técnica viable. " +
        "Tienes libertad para usar herramientas internas o externas disponibles; si una opción vuelve a fallar, elige otra en lugar de esperar indefinidamente.";
    }
    function launchAttempt(taskText, attemptNumber) {
      var attemptState = { buffer: "", gotAnswer: false, answer: "", stderr: "" };
      stalled = false;
      lastActivityAt = Date.now();
      lastActivityTool = "";
      var child = cp.spawn(codex, args, { cwd: runtimeDirectory(), env: codexEnvironment() });
      active = child;
      startStallWatch(child);
      child.stdout.on("data", function (chunk) {
        touchTaskActivity();
        consumeLines(attemptState, chunk.toString("utf8"), function (event) {
          var label = eventLabel(event);
          if (label) {
            if (label.tool && label.event === "started") lastActivityTool = label.tool;
            if (label.kind === "answer") {
              attemptState.gotAnswer = true;
              attemptState.answer += (attemptState.answer ? "\n" : "") + label.text;
            }
            appendOutput(label.text, label.kind, label);
          }
          if (event.type === "turn.failed") appendOutput(friendlyError(event.error && event.error.message), "error");
        });
      });
      child.stderr.on("data", function (chunk) {
        touchTaskActivity();
        attemptState.stderr += chunk.toString("utf8");
      });
      child.on("error", function (error) {
        touchTaskActivity();
        appendOutput(friendlyError(error.message), "error");
      });
      child.on("close", function (code, signal) {
        stopStallWatch();
        if (active === child) active = null;
        if (signal && stalled && attemptNumber === 0) {
          var blockedTool = lastActivityTool;
          appendOutput("Reintentando automáticamente con otra estrategia" + (blockedTool ? " después de " + blockedTool : "") + "…", "progress");
          setRunning(true, "Recuperando con otra técnica…");
          return launchAttempt(recoveryPrompt(blockedTool), 1);
        }
        if (signal && stalled) {
          var stalledMessage = "La tarea se bloqueó dos veces y AE AI la detuvo para proteger After Effects. La última vía sin respuesta fue " + (lastActivityTool || "un proceso externo") + ".";
          finishSessionTurn(taskSessionId, turnId, stalledMessage, "error");
          renderSessionTranscript();
          setRunning(false, "Detenida por bloqueo");
        } else if (signal) {
          finishSessionTurn(taskSessionId, turnId, "", "cancelled");
          renderSessionTranscript();
          setRunning(false, "Cancelada");
        } else if (code === 0) {
          var finalAnswer = attemptState.answer || "La tarea terminó sin un mensaje final.";
          finishSessionTurn(taskSessionId, turnId, finalAnswer, "done");
          renderSessionTranscript();
          setRunning(false, "Completada");
        } else {
          var failure = friendlyError(attemptState.stderr || "Codex terminó con código " + code + ".");
          finishSessionTurn(taskSessionId, turnId, failure, "error");
          renderSessionTranscript();
          setRunning(false, "Error");
        }
        checkAuth();
      });
      child.stdin.end(taskText);
    }
    launchAttempt(taskPrompt, 0);
  }

  function cancelTask() {
    if (!active) return;
    setRunning(true, "Cancelando…");
    var processToKill = active;
    var finished = false;
    function killCodex() {
      if (finished) return;
      finished = true;
      try { processToKill.kill(); } catch (e) {}
    }
    try {
      var cancellation = window.__aeMcpCancelActiveJobs ? window.__aeMcpCancelActiveJobs() : null;
      if (cancellation && typeof cancellation.then === "function") {
        var timer = setTimeout(killCodex, 3000);
        cancellation.then(function () { clearTimeout(timer); killCodex(); }, function () { clearTimeout(timer); killCodex(); });
        return;
      }
    } catch (e) {}
    killCodex();
  }

  function updateCount() {
    ui.charCount.textContent = String(ui.prompt.value.length);
    if (ui.prompt && ui.prompt.style) {
      ui.prompt.style.height = "auto";
      var desired = Math.max(72, Math.min(132, Number(ui.prompt.scrollHeight) || 72));
      ui.prompt.style.height = desired + "px";
      ui.prompt.style.overflowY = (Number(ui.prompt.scrollHeight) > 132) ? "auto" : "hidden";
    }
  }

  ui.run.addEventListener("click", runTask);
  if (ui.improve) ui.improve.addEventListener("click", improvePrompt);
  ui.newSession.addEventListener("click", createSession);
  ui.deleteSession.addEventListener("click", removeCurrentSession);
  ui.session.addEventListener("change", function () {
    selectSessionById(ui.session.value);
  });
  ui.preset.addEventListener("change", function () {
    localStorage.setItem(PRESET_KEY, ui.preset.value);
  });
  ui.template.addEventListener("change", function () {
    if (!ui.template.value || !TEMPLATES[ui.template.value]) return;
    ui.prompt.value = TEMPLATES[ui.template.value];
    updateCount();
    scheduleReferenceSearch();
    ui.prompt.focus();
    ui.template.value = "";
  });
  ui.cancel.addEventListener("click", cancelTask);
  ui.connect.addEventListener("click", beginLogin);
  if (ui.updateButton) ui.updateButton.addEventListener("click", handleUpdateButton);
  ui.searchReferences.addEventListener("click", function () {
    discoverReferences(ui.referenceQuery.value || referenceQueryFromPrompt(ui.prompt.value));
  });
  if (ui.attachReference && ui.referenceFile) {
    ui.attachReference.addEventListener("click", function () { ui.referenceFile.click(); });
    ui.referenceFile.addEventListener("change", function () {
      var file = ui.referenceFile.files && ui.referenceFile.files[0];
      if (file) attachUserReference(file);
    });
  }
  ui.autoReferences.addEventListener("change", function () {
    localStorage.setItem(AUTO_REFERENCES_KEY, ui.autoReferences.checked ? "1" : "0");
    if (ui.autoReferences.checked) scheduleReferenceSearch();
  });
  ui.clearHistory.addEventListener("click", function () {
    localStorage.removeItem(HISTORY_KEY);
    renderHistory();
  });
  ui.prompt.addEventListener("input", function () {
    updateCount();
    scheduleReferenceSearch();
  });
  ui.prompt.addEventListener("keydown", function (event) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      runTask();
    }
  });

  var storedAutoReferences = localStorage.getItem(AUTO_REFERENCES_KEY);
  ui.autoReferences.checked = storedAutoReferences !== "0";

  var storedPreset = localStorage.getItem(PRESET_KEY);
  if (storedPreset && PRESETS[storedPreset]) ui.preset.value = storedPreset;
  else ui.preset.value = "balanced";
  initializeSidebar();
  renderSessions();
  renderSessionTranscript();
  renderReferenceResults();

  var storedModel = localStorage.getItem(MODEL_KEY);
  if (storedModel !== null) {
    var storedOption = Array.prototype.filter.call(ui.model.options, function (option) {
      return option.value === storedModel && !option.disabled;
    })[0];
    ui.model.value = storedOption ? storedModel : "";
  }
  renderHistory();
  updateCount();
  setRunning(false);
  checkAuth();
  checkForUpdates();
  scrollConversationBottom(true);
})();
