import { startSecurityMemory, stopSecurityMemory } from "./passive-skills.js";
import { interceptSecurityCommand, isSecurityCommand, isWiping, safeDraft, setSecurityShutdown } from "./security.js";
import { stopDeviceTools } from "./device-runtime.js";
import { abortNetwork } from "./network.js";
import { clearVaultMemory } from "./vault.js";
import { checkpointSession, flushSessions, recoverSessions, saveSession } from "./session-store.js";
import { createAgentPanel } from "./agentPanel.js";
import { setBridgeState, setToolListener } from "./bridge.js";
import { APP_ID, APP_VERSION, STATS } from "./config.js";
import { createChat } from "./chat.js";
import { metaDeclararProyecto, metaUpdate } from "./meta.js";
import { loadAgent } from "./pyodide.js";
import { startRenewal } from "./renewal.js";
import { startRoutines, stopRoutines, tick } from "./routines.js";
import { listConnectors, connectorStatus, STATUS } from "./connectors.js";
import { renderReconnectNotice } from "./credentials.js";
import { setupSubagents, renderSubagents, stopSubagents } from "./subagents.js";
import { createSessions } from "./sessions.js";
import { bindSettings, renderConnectors } from "./settings.js";
import { all, closeDatabase, flushWrites, json } from "./storage.js";
import { autoExpand, bindReplyGestures, byId, pretty, updateToolCard } from "./ui.js";

const DEFAULT_TITLE = "Nueva conversación";
const LOAD_ERROR = "No se pudo preparar el agente. Recarga la página.";
const CONFIRM_LABELS = {
  herramienta_dispositivo_gestionar: (args) => ({ crear: "Crear", actualizar: "Actualizar", borrar: "Borrar" }[args.action] || "Cambiar") + " herramienta del dispositivo «" + args.name + "»",
  create_connector: (args) => "Crear conector " + (args.definition?.name || "") + " (" + (args.definition?.base_url || "") + ")",
  call_connector: (args) => args.connector + ": " + args.operation + " (" + args.method + " " + args.path + ")",
  skill_manage: (args) => (args.action === "delete" ? "Borrar" : args.action === "edit" ? "Editar" : "Crear") + " habilidad " + args.name
};

let pyodide;
let session = newSessionData();
const knownSessions = new Map();
let agentPanel;
let chat;
let stats = json("stats") || { mensajes_enviados: 0, herramientas_usadas: 0 };

function newSessionData() {
  return { id: crypto.randomUUID(), title: DEFAULT_TITLE, messages: [], todos: [], results: {}, subagents: [], updatedAt: Date.now() };
}

function currentSession() {
  return session;
}

function replaceSession(value) {
  session = knownSessions.get(value.id) || { ...newSessionData(), ...value };
  knownSessions.set(session.id, session);
  json("lastSession", session.id);
}

async function resolveSession(id) {
  if (!id) return session;
  if (knownSessions.has(id)) return knownSessions.get(id);
  const saved = (await all("sessions")).find((row) => row.id === id);
  if (!saved) throw new Error("Conversación no encontrada");
  if (!knownSessions.has(id)) knownSessions.set(id, saved);
  return knownSessions.get(id);
}

function statsSave() {
  json("stats", stats);
  metaUpdate(APP_ID, APP_VERSION, { stats }, { declare: STATS });
}

async function persist(value = session) {
  if (isWiping()) return;
  value.updatedAt = Date.now();
  if (value.title === DEFAULT_TITLE) {
    value.title = value.messages.find((item) => item.role === "user")?.content.slice(0, 48) || DEFAULT_TITLE;
  }
  await saveSession(value);
}

function parseArgs(raw) {
  try {
    return typeof raw === "string" ? JSON.parse(raw) : raw || {};
  } catch {
    return {};
  }
}

const interactions = [];
let activeInteraction = null;

function interaction(kind, open, args) {
  return new Promise((resolve) => {
    const item = { kind, open, args, resolve, job: args[2], signal: args[3] };
    if (item.signal?.aborted) return resolve(kind === "confirm" ? false : "");
    interactions.push(item);
    drainInteractions();
  });
}

async function drainInteractions() {
  if (activeInteraction || !interactions.length) return;
  const item = interactions.shift();
  if (item.signal?.aborted) {
    item.resolve(item.kind === "confirm" ? false : "");
    drainInteractions();
    return;
  }
  activeInteraction = item;
  try {
    item.resolve(await item.open(...item.args));
  } finally {
    activeInteraction = null;
    drainInteractions();
  }
}

function cancelJob(id) {
  for (const item of interactions.filter((row) => row.job === id)) item.resolve(item.kind === "confirm" ? false : "");
  if (activeInteraction?.job === id) byId(activeInteraction.kind).close("cancelled");
}

function bindConfirm() {
  let resolve;
  const dialog = byId("confirm");
  const finish = (value) => {
    if (resolve) {
      resolve(value);
      resolve = null;
    }
  };
  byId("approveConfirm").onclick = () => dialog.close("approved");
  byId("cancelConfirm").onclick = () => dialog.close("cancelled");
  dialog.onclose = () => finish(dialog.returnValue === "approved");
  return (name, raw) => new Promise((done) => {
    const args = parseArgs(raw);
    byId("confirmText").textContent = CONFIRM_LABELS[name]?.(args) || name;
    byId("confirmArgs").textContent = pretty(args);
    resolve = done;
    dialog.show();
  });
}

function bindClarify() {
  let resolve;
  const dialog = byId("clarify");
  const finish = (value) => {
    if (resolve) {
      resolve(value);
      resolve = null;
    }
  };
  dialog.onclose = () => finish(dialog.returnValue || "");
  byId("clarifyForm").onsubmit = async (event) => {
    event.preventDefault();
    const value = byId("clarifyText").value;
    byId("clarifyText").value = "";
    if (await interceptSecurityCommand(value)) return;
    dialog.returnValue = value;
    dialog.close();
  };
  return (question, raw) => new Promise((done) => {
    byId("clarifyQuestion").textContent = question;
    byId("clarifyText").value = "";
    const options = parseArgs(raw);
    byId("clarifyOptions").replaceChildren(...options.map((option) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = option;
      button.onclick = () => {
        dialog.returnValue = option;
        dialog.close();
      };
      return button;
    }));
    resolve = done;
    dialog.show();
  });
}

function bindCloseButtons() {
  document.querySelectorAll("[data-close]").forEach((button) => {
    button.onclick = () => {
      const dialog = button.closest("dialog");
      if (dialog) {
        dialog.close();
      } else {
        button.closest(".panel").hidden = true;
      }
    };
  });
}

async function refreshCredentials() {
  try { await Promise.all([renderConnectors(), renderReconnectNotice()]); }
  catch { byId("reconnectNotice").hidden = false; byId("reconnectText").textContent = "No se pudo leer el acceso guardado. Puedes seguir usando Eco."; }
}

function bindComposer() {
  const prompt = byId("prompt");
  prompt.oninput = () => { autoExpand(prompt); byId("securityNotice").hidden = true; };
  byId("composer").onsubmit = (event) => {
    event.preventDefault();
    const text = prompt.value;
    prompt.value = "";
    autoExpand(prompt);
    chat.send(text).catch(() => { if (!isWiping() && !isSecurityCommand(text)) byId("prompt").value = text; });
    refreshCredentials();
  };
}

async function main() {
  setSecurityShutdown(() => {
    for (const stop of [stopRoutines, stopSecurityMemory, stopSubagents, stopDeviceTools, abortNetwork, closeDatabase, clearVaultMemory]) { try { stop(); } catch {} }
    for (const item of interactions.splice(0)) item.resolve(item.kind === "confirm" ? false : "");
    for (const dialog of document.querySelectorAll("dialog[open]")) dialog.close("cancelled");
    pyodide = null;
    knownSessions.clear();
    session = newSessionData();
    stats = {};
    window.ecoBridge = null;
    for (const input of document.querySelectorAll("input, textarea")) input.value = "";
  });
  byId("version").textContent = APP_VERSION;
  metaDeclararProyecto(APP_ID, APP_VERSION);
  statsSave();
  bindSettings();
  bindCloseButtons();
  const confirm = bindConfirm();
  const clarify = bindClarify();
  chat = createChat({
    getPyodide: () => pyodide,
    getSession: currentSession,
    incrementMessages: () => { stats.mensajes_enviados += 1; },
    persist,
    setSession: replaceSession,
    resolveSession,
    statsSave
  });
  chat.setSending(true);
  const restored = await recoverSessions();
  for (const saved of restored) knownSessions.set(saved.id, saved);
  const last = restored.find((row) => row.id === json("lastSession")) || [...restored].sort((a, b) => b.updatedAt - a.updatedAt)[0];
  replaceSession(last || session);
  agentPanel = createAgentPanel({ getTodos: () => chat.currentTodos() });
  createSessions({
    loadSession: chat.loadSession,
    newSession: () => {
      chat.loadSession(newSessionData());
      persist().catch(() => {});
    }
  });
  setBridgeState({
    refreshAgent: () => agentPanel.render(),
    refreshConnectors: () => renderConnectors(),
    sessionId: () => currentSession().id,
    turnUpdate: (sessionId, value) => chat.updateTurn(sessionId, value),
    async setTodos(todos, sessionId, jobId) {
      const owner = await resolveSession(sessionId);
      const target = jobId ? owner.subagents?.find((job) => job.id === jobId) : owner;
      if (!target) return;
      target.todos = todos;
      await persist(owner);
      if (owner === currentSession() && !jobId) await chat.setTodos(todos);
    },
    async todos(sessionId, jobId) {
      const owner = await resolveSession(sessionId);
      return (jobId ? owner.subagents?.find((job) => job.id === jobId) : owner)?.todos || [];
    }
  });
  window.ecoUI = {
    clarify: (...args) => interaction("clarify", clarify, args),
    confirm: (...args) => interaction("confirm", confirm, args),
    cancelJob
  };
  await setupSubagents({ getSession: currentSession, getPyodide: () => pyodide, persist, receiveJob: chat.receiveJob, resolveSession });
  setToolListener((name, status, value) => {
    if (!["subagente_crear", "subagente_listar", "subagente_control"].includes(name)) updateToolCard(name, status, value);
    if (status !== "trabajando") {
      stats.herramientas_usadas += 1;
      statsSave();
    }
  });
  bindComposer();
  bindReplyGestures((id) => chat.replyTo(id).catch(() => {}));
  window.addEventListener("eco-credentials-changed", () => { refreshCredentials(); tick().catch(() => {}); chat.drain(); });
  window.addEventListener("eco-reconnect-finished", () => { renderConnectors().catch(() => {}); });
  window.addEventListener("eco-storage-error", () => {
    byId("reconnectNotice").hidden = false;
    byId("reconnectText").textContent = "El almacenamiento está lleno. No cierres Eco hasta guardar tus mensajes.";
  });
  const flush = () => {
    if (isWiping()) return;
    currentSession().draft = safeDraft(byId("prompt").value);
    for (const value of knownSessions.values()) checkpointSession(value);
    flushSessions(knownSessions.values());
    flushWrites();
  };
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(); });
  window.addEventListener("pagehide", flush);
  startSecurityMemory();
  startRenewal(refreshCredentials);
  refreshCredentials();
  try {
    const loaded = await loadAgent();
    if (isWiping()) return;
    pyodide = loaded;
  } catch (error) {
    if (byId("empty")) byId("empty").textContent = LOAD_ERROR;
    throw error;
  }
  chat.setSending(false);
  chat.loadSession(currentSession());
  renderSubagents();
  startRoutines(chat.trigger);
}

window.ecoApp = {
  ready: main().catch(() => {
    byId("chat").textContent = "No se pudo abrir el almacenamiento o preparar Eco. Cierra otras pestañas y vuelve a cargar.";
    byId("send").disabled = true;
    return false;
  }),
  send: (text) => isSecurityCommand(text) ? interceptSecurityCommand(text) : window.ecoApp.ready.then(() => chat?.send(text))
};

document.getElementById("reloadButton").onclick = async () => {
  const registration = await navigator.serviceWorker?.getRegistration();
  await registration?.update().catch(() => {});
  location.reload();
};

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js?v=" + APP_VERSION).then(registration => { if (isWiping()) registration.unregister(); }).catch(() => {});
}
