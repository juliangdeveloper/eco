import { DEFAULT_MODEL } from "./config.js";
import { all, remove, setting, store } from "./storage.js";
import { connectorFetch, getConnector, normalizeConnector, publicConnectors, saveConnector, validateConnector } from "./connectors.js";
import { showCredentialCard } from "./credentials.js";
import { searchSessions } from "./sessions.js";

let toolListener = () => {};
let stateApi = null;

function plain(value) {
  if (value?.toJs) {
    return value.toJs({ dict_converter: Object.fromEntries });
  }
  return value || {};
}

function parsed(value) {
  const plainValue = plain(value);
  return typeof plainValue === "string" ? JSON.parse(plainValue) : plainValue;
}

export function setToolListener(listener) {
  toolListener = listener;
}

export function setBridgeState(api) {
  stateApi = api;
}

async function createConnectorSafely(raw) {
  let definition;
  try {
    definition = parsed(raw);
  } catch {
    return JSON.stringify({ ok: false, error: "Definición inválida" });
  }
  const check = validateConnector(definition);
  if (!check.ok) {
    return JSON.stringify(check);
  }
  const previous = await getConnector(definition.id);
  const normalized = normalizeConnector(definition);
  const auth = { ...normalized.auth };
  delete auth.client_id;
  if (previous?.auth?.client_id && auth.type === "oauth2") {
    auth.client_id = previous.auth.client_id;
  }
  const connector = await saveConnector({ ...normalized, auth, createdAt: previous?.createdAt });
  stateApi?.refreshConnectors();
  const status = connector.auth.type === "none" ? "conectado" : await showCredentialCard(connector);
  stateApi?.refreshConnectors();
  return JSON.stringify({ ok: true, id: connector.id, status });
}

window.ecoBridge = {
  fetch(url, init) {
    const options = plain(init);
    if (options.body == null) {
      delete options.body;
    }
    return window.fetch(url, options);
  },
  async config() {
    return JSON.stringify({
      key: setting("openrouterKey"),
      model: setting("model") || DEFAULT_MODEL,
      origin: location.origin
    });
  },
  async state() {
    return JSON.stringify({
      memory: setting("memory"),
      user: setting("user"),
      todos: stateApi?.todos() || []
    });
  },
  async saveState(raw) {
    const value = parsed(raw);
    setting("memory", value.memory || "");
    setting("user", value.user || "");
    await stateApi?.setTodos(Array.isArray(value.todos) ? value.todos : []);
    stateApi?.refreshAgent();
    return true;
  },
  async connectors() {
    return JSON.stringify(await publicConnectors());
  },
  async createConnector(raw) {
    try {
      return await createConnectorSafely(raw);
    } catch {
      return JSON.stringify({ ok: false, error: "No se pudo guardar el conector" });
    }
  },
  async requestSignIn(id) {
    const connector = await getConnector(String(id));
    if (!connector) {
      return JSON.stringify({ ok: false, error: "Conector no encontrado" });
    }
    const status = await showCredentialCard(connector);
    stateApi?.refreshConnectors();
    return JSON.stringify({ ok: true, id: connector.id, status });
  },
  async connectorFetch(id, method, path, queryJson, bodyJson) {
    const result = await connectorFetch(String(id), String(method), String(path), parsed(queryJson) || {}, parsed(bodyJson));
    return JSON.stringify(result);
  },
  async skills() {
    return JSON.stringify(await all("skills"));
  },
  async skillManage(raw) {
    const value = parsed(raw);
    if (value.action === "delete") {
      await remove("skills", value.name);
    } else {
      await store("skills", {
        id: value.name,
        description: value.description || "",
        content: value.content || ""
      });
    }
    stateApi?.refreshAgent();
    return JSON.stringify({ ok: true });
  },
  async sessionSearch(query, limit) {
    return JSON.stringify(await searchSessions(query, limit, stateApi?.sessionId() || ""));
  },
  confirm(name, argsJson) {
    return window.ecoUI.confirm(name, argsJson);
  },
  clarify(question, optionsJson) {
    return window.ecoUI.clarify(question, optionsJson);
  },
  async onToolStart(name, argsJson) {
    toolListener(name, "trabajando", argsJson);
  },
  async onToolEnd(name, resultJson) {
    let result = resultJson;
    try {
      result = parsed(resultJson);
    } catch {
      result = resultJson;
    }
    toolListener(name, result?.error !== undefined ? "error" : "listo", result);
  }
};
