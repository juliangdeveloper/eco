import { setupReload, resumeMarker, clearResumeMarker, prepareReload, commitReload } from "./reload.js";
import { refreshMemoryPresence, startSecurityMemory, stopSecurityMemory } from "./passive-skills.js";
import { ecoName, onEcoName } from "./identity.js";
import { pruneAttachments } from "./attachments.js";
import { interceptSecurityCommand, isSecurityCommand, isWiping, safeDraft, setSecurityShutdown, startLocalActivityWatch } from "./security.js";
import { stopDeviceTools } from "./device-runtime.js";
import { abortNetwork } from "./network.js";
import { clearVaultMemory } from "./vault.js";
import { deleteStoredSession, flushSessions, recoverSessions, saveSession } from "./session-store.js";
import { dreamingEnabled, dreamingTool, startDreaming, stopDreaming } from "./dreaming.js";
import { createAgentPanel } from "./agentPanel.js";
import { setBridgeState, setDreamingHandler, setFaceHandler, setSpeakHandler, setToolListener, setVoiceHandler } from "./bridge.js";
import { deviceCapabilities, listenOn, onCapabilities, speakOn, watchCapabilities } from "./capabilities.js";
import { speakTool, voiceState } from "./voice-output.js";
import { startMagic, stopMagic } from "./magic.js";
import { createFace } from "./face.js";
import { emitActivity } from "./face-config.js";
import { bindFaceVoiceSettings } from "./face-settings.js";
import { createVoice } from "./voice.js";
import { clearPendingSpeech, stopSpeaking } from "./speech.js";
import { APP_ID, APP_VERSION, STATS } from "./config.js";
import { createChat } from "./chat.js";
import { metaDeclararProyecto, metaUpdate } from "./meta.js";
import { loadAgent } from "./pyodide.js";
import { startRenewal } from "./renewal.js";
import { startRoutines, stopRoutines, tick } from "./routines.js";
import { listConnectors, connectorStatus, STATUS } from "./connectors.js";
import { renderReconnectNotice } from "./credentials.js";
import { compactFinishedJobs, setupSubagents, renderSubagents, stopSubagents } from "./subagents.js";
import { createSessions } from "./sessions.js";
import { bindSettings, renderConnectors } from "./settings.js";
import { all, closeDatabase, flushWrites, json, retryFailedWrites } from "./storage.js";
import { autoExpand, bindReplyGestures, byId, updateToolCard } from "./ui.js";

const DEFAULT_TITLE = "New conversation";
const NAME_SYNC_MS = 1500;
const LOAD_ERROR = "The agent could not be prepared. Reload the page.";

let pyodide;
let session = newSessionData();
const knownSessions = new Map();
let agentPanel;
let chat;
let face;
let voice;
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
  if (!saved) throw new Error("Conversation not found");
  if (!knownSessions.has(id)) knownSessions.set(id, saved);
  return knownSessions.get(id);
}

function statsSave() {
  json("stats", stats);
  metaUpdate(APP_ID, APP_VERSION, { stats }, { declare: STATS });
}

async function deleteSession(id) {
  if (id === session.id) throw new Error("The open conversation is never deleted.");
  const owner = knownSessions.get(id);
  if (owner?.subagents?.some((job) => job.status === "ejecutando") || owner?.inFlight || owner?.pendingTurns?.length) throw new Error("The conversation is busy.");
  knownSessions.delete(id);
  await deleteStoredSession(id);
  all("sessions").then((rows) => pruneAttachments(rows.map((row) => row.id))).catch(() => {});
}

function busy() {
  for (const value of knownSessions.values()) if (value.inFlight || value.pendingTurns?.length || value.subagents?.some((job) => job.status === "ejecutando")) return true;
  return false;
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
    if (item.signal?.aborted) return resolve("");
    interactions.push(item);
    drainInteractions();
  });
}

async function drainInteractions() {
  if (activeInteraction || !interactions.length) return;
  const item = interactions.shift();
  if (item.signal?.aborted) {
    item.resolve("");
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
  for (const item of interactions.filter((row) => row.job === id)) item.resolve("");
  if (activeInteraction?.job === id) byId(activeInteraction.kind).close("cancelled");
}

function bindClarify() {
  let resolve;
  const dialog = byId("clarify");
  const finish = (value) => {
    if (resolve) {
      emitActivity("asking", { on: false });
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
    emitActivity("asking", { on: true });
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
  catch { byId("reconnectNotice").hidden = false; byId("reconnectText").textContent = "Saved access could not be read. You can keep using Eco."; }
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
    for (const stop of [() => voice?.stop(), stopSpeaking, stopDreaming, stopRoutines, stopMagic, stopSecurityMemory, stopSubagents, stopDeviceTools, abortNetwork, closeDatabase, clearVaultMemory]) { try { stop(); } catch {} }
    for (const item of interactions.splice(0)) item.resolve("");
    for (const dialog of document.querySelectorAll("dialog[open]")) dialog.close("cancelled");
    pyodide = null;
    knownSessions.clear();
    session = newSessionData();
    stats = {};
    window.ecoBridge = null;
    for (const input of document.querySelectorAll("input, textarea")) input.value = "";
  });
  if (await startLocalActivityWatch()) return;
  byId("version").textContent = APP_VERSION;
  const showName = () => {
    const name = ecoName();
    byId("brandName").textContent = name;
    document.title = name;
    byId("faceSprite").setAttribute("aria-label", name + "'s face");
  };
  showName();
  let renamed = null;
  onEcoName(() => {
    showName();
    clearTimeout(renamed);
    renamed = setTimeout(() => refreshMemoryPresence(true).catch(() => {}), NAME_SYNC_MS);
  });
  metaDeclararProyecto(APP_ID, APP_VERSION);
  bindSettings();
  bindFaceVoiceSettings();
  bindCloseButtons();
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
  face = createFace({ getSession: currentSession });
  startMagic({
    getSession: currentSession,
    append: (session, message) => chat.append(session, message),
    triggerTurn: chat.trigger,
    toggleFace: async () => { await face.set(!face.active); return face.active; },
    modelReady: () => Boolean(pyodide && localStorage.getItem("eco.openrouterKey")),
    onChange: () => window.dispatchEvent(new Event("eco-magic-change"))
  });
  voice = createVoice({ sendVoice: (text) => window.ecoApp.ready.then(() => chat.send(text, { voice: true })), faceActive: () => face.active });
  setVoiceHandler(() => voiceState(voice));
  setSpeakHandler(speakTool, () => deviceCapabilities().speak);
  const applyVoice = () => {
    byId("micButton").hidden = !listenOn();
    if (!listenOn() && (voice.enabled || voice.phase === "turn")) voice.stop();
    if (!speakOn()) { stopSpeaking(); clearPendingSpeech(); }
  };
  onCapabilities(applyVoice);
  window.addEventListener("eco-face-voice-settings", applyVoice);
  watchCapabilities();
  setFaceHandler(async (action) => {
    if (action === "on" || action === "off") await face.set(action === "on");
    return { ok: true, modo_cara: face.active ? "on" : "off", estado: face.state };
  });
  Object.assign(window.ecoApp, { face, voice });
  chat.setSending(true);
  const reloadResume = await resumeMarker();
  const restored = await recoverSessions(reloadResume);
  all("sessions").then((rows) => pruneAttachments(rows.map((row) => row.id))).catch(() => {});
  for (const saved of restored) knownSessions.set(saved.id, saved);
  const last = restored.find((row) => row.id === json("lastSession")) || [...restored].sort((a, b) => b.updatedAt - a.updatedAt)[0];
  replaceSession(last || session);
  statsSave();
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
    async anchor(sessionId) {
      const owner = await resolveSession(sessionId);
      return owner.messages.filter((message) => !message.event && message.content && ["user", "assistant"].includes(message.role)).at(-1)?.id || "";
    },
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
    cancelJob
  };
  await setupSubagents({ getSession: currentSession, getPyodide: () => pyodide, persist, persistQuiet: (value) => saveSession(value, { touch: false }), receiveJob: chat.receiveJob, resolveSession });
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
  window.addEventListener("eco-storage-error", (event) => {
    byId("storageNotice").hidden = false;
    byId("storageText").textContent = event.detail?.name === "QuotaExceededError"
      ? "There is no space left to save. Old results were already cleared. Don't close Eco until your messages are saved."
      : "The latest changes could not be saved. Don't close Eco; try saving again.";
  });
  window.addEventListener("eco-storage-saved", () => { byId("storageNotice").hidden = true; });
  byId("storageRetry").onclick = async () => {
    byId("storageRetry").disabled = true;
    try { await retryFailedWrites(); await flushSessions(knownSessions.values()); }
    catch {}
    finally { byId("storageRetry").disabled = false; }
  };
  const flush = () => {
    if (isWiping()) return;
    currentSession().draft = safeDraft(byId("prompt").value);
    flushSessions(knownSessions.values()).catch(() => {});
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
  setupReload({
    async checkpoint() {
      currentSession().draft = safeDraft(byId("prompt").value);
      for (const value of knownSessions.values()) await saveSession(value, { touch: false });
      await flushSessions(knownSessions.values());
      await flushWrites();
      return { session: currentSession().id, sessions: [...knownSessions.values()].filter((value) => value.pendingTurns?.length || value.subagents?.some((job) => job.status === "ejecutando")).map((value) => ({ id: value.id, jobs: (value.subagents || []).filter((job) => job.status === "ejecutando").map((job) => job.id) })) };
    },
    stop: stopRoutines
  });
  if (reloadResume) {
    const notice = "Eco reloaded from " + reloadResume.before + " a " + APP_VERSION + ". Motivo: " + reloadResume.reason + ". Continue the pending work from the last saved point. Active subagents resume with the same id. Check the state of interrupted operations before repeating them; don't duplicate writes or tasks.";
    const owners = [];
    for (const item of reloadResume.sessions || []) {
      const owner = await resolveSession(item.id);
      owners.push(owner);
      for (const id of item.jobs) {
        const job = owner.subagents?.find((row) => row.id === id);
        if (job?.status !== "interrumpido") continue;
        const result = JSON.parse(await pyodide.globals.get("job_control")(JSON.stringify({ session: owner.id, id, action: "modificar", instruction: notice, owner_instructions: job.owner_instructions || owner.messages.filter((message) => message.role === "user" && !message.event).map((message) => message.content).join("\n") })));
        if (result.error) throw new Error(result.error);
      }
    }
    await clearResumeMarker();
    if (reloadResume.session) replaceSession(await resolveSession(reloadResume.session));
    await chat.resume(owners, notice);
  }
  chat.setSending(false);
  chat.loadSession(currentSession());
  chat.drain();
  renderSubagents();
  startRoutines(chat.trigger);
  setDreamingHandler(dreamingTool, dreamingEnabled);
  startDreaming({ sessions: () => knownSessions, currentSession, deleteSession, busy, compact: compactFinishedJobs });
}

window.ecoApp = {
  ready: main().catch(() => {
    byId("chat").textContent = "Storage could not be opened or Eco could not be prepared. Close other tabs and reload.";
    byId("send").disabled = true;
    return false;
  }),
  send: (text) => isSecurityCommand(text) ? interceptSecurityCommand(text) : window.ecoApp.ready.then(() => chat?.send(text))
};

document.getElementById("reloadButton").onclick = async () => {
  await window.ecoApp.ready;
  const check = prepareReload({ motivo: "Update from the button" });
  if (!check.ok) { updateToolCard("eco_actualizar", "error", check); return; }
  commitReload(check).catch((error) => updateToolCard("eco_actualizar", "error", { error: error.message }));
};

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js?v=" + APP_VERSION).then(registration => { if (isWiping()) registration.unregister(); }).catch(() => {});
}
