import { createAgentPanel } from "./agentPanel.js";
import { setBridgeState, setToolListener } from "./bridge.js";
import { APP_ID, APP_VERSION, STATS } from "./config.js";
import { createChat } from "./chat.js";
import { metaDeclararProyecto, metaUpdate } from "./meta.js";
import { loadAgent } from "./pyodide.js";
import { startRenewal } from "./renewal.js";
import { listConnectors, connectorStatus, STATUS } from "./connectors.js";
import { showCredentialCard } from "./credentials.js";
import { createSessions } from "./sessions.js";
import { bindSettings, renderConnectors } from "./settings.js";
import { json, store } from "./storage.js";
import { autoExpand, byId, pretty, renderEmpty, updateToolCard } from "./ui.js";

const DEFAULT_TITLE = "Nueva conversación";
const LOAD_ERROR = "No se pudo preparar el agente. Recarga la página.";
const CONFIRM_LABELS = {
  create_connector: (args) => "Crear conector " + (args.definition?.name || "") + " (" + (args.definition?.base_url || "") + ")",
  call_connector: (args) => args.connector + ": " + args.operation + " (" + args.method + " " + args.path + ")",
  skill_manage: (args) => (args.action === "delete" ? "Borrar" : args.action === "edit" ? "Editar" : "Crear") + " habilidad " + args.name
};

let pyodide;
let session = newSessionData();
let agentPanel;
let chat;
let stats = json("stats") || { mensajes_enviados: 0, herramientas_usadas: 0 };

function newSessionData() {
  return { id: crypto.randomUUID(), title: DEFAULT_TITLE, messages: [], todos: [], updatedAt: Date.now() };
}

function currentSession() {
  return session;
}

function replaceSession(value) {
  if (value === session) {
    return;
  }
  session = { ...newSessionData(), ...value, messages: value.messages || [], todos: value.todos || [] };
}

function statsSave() {
  json("stats", stats);
  metaUpdate(APP_ID, APP_VERSION, { stats }, { declare: STATS });
}

async function persist() {
  session.updatedAt = Date.now();
  if (session.title === DEFAULT_TITLE) {
    session.title = session.messages.find((item) => item.role === "user")?.content.slice(0, 48) || DEFAULT_TITLE;
  }
  await store("sessions", session);
}

function parseArgs(raw) {
  try {
    return typeof raw === "string" ? JSON.parse(raw) : raw || {};
  } catch {
    return {};
  }
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
    dialog.showModal();
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
  byId("clarifyForm").onsubmit = (event) => {
    event.preventDefault();
    dialog.returnValue = byId("clarifyText").value;
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
    dialog.showModal();
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

const promptedExpired = new Set();

async function promptExpired() {
  for (const connector of await listConnectors()) {
    if (promptedExpired.has(connector.id)) {
      continue;
    }
    if ((await connectorStatus(connector.id)) === STATUS.EXPIRED) {
      promptedExpired.add(connector.id);
      showCredentialCard(connector, { expired: true }).then((status) => {
        if (status === STATUS.CONNECTED) {
          promptedExpired.delete(connector.id);
        }
        renderConnectors();
      });
    }
  }
}

function bindComposer() {
  const prompt = byId("prompt");
  prompt.oninput = () => autoExpand(prompt);
  byId("composer").onsubmit = (event) => {
    event.preventDefault();
    const text = prompt.value;
    prompt.value = "";
    autoExpand(prompt);
    chat.send(text);
    promptExpired();
  };
}

async function main() {
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
    statsSave
  });
  chat.setSending(true);
  agentPanel = createAgentPanel({ getTodos: () => chat.currentTodos() });
  createSessions({
    loadSession: chat.loadSession,
    newSession: () => {
      replaceSession(newSessionData());
      renderEmpty(chat.send);
    }
  });
  setBridgeState({
    refreshAgent: () => agentPanel.render(),
    refreshConnectors: () => renderConnectors(),
    sessionId: () => currentSession().id,
    setTodos: chat.setTodos,
    todos: chat.currentTodos
  });
  window.ecoUI = {
    clarify,
    confirm
  };
  setToolListener((name, status, value) => {
    updateToolCard(name, status, value);
    if (status !== "trabajando") {
      stats.herramientas_usadas += 1;
      statsSave();
    }
  });
  bindComposer();
  startRenewal(() => renderConnectors());
  try {
    pyodide = await loadAgent();
  } catch (error) {
    byId("empty").textContent = LOAD_ERROR;
    throw error;
  }
  chat.setSending(false);
  renderEmpty(chat.send);
}

window.ecoApp = {
  ready: main(),
  send: (text) => window.ecoApp.ready.then(() => chat.send(text))
};

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js?v=" + APP_VERSION);
}
