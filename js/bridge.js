import { DEFAULT_MODEL } from "./config.js";
import { all, remove, setting, store } from "./storage.js";
import { gmailToken } from "./gmail.js";
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
      origin: location.origin,
      githubToken: setting("githubToken"),
      githubEnabled: setting("githubEnabled") !== "false",
      gmailEnabled: setting("gmailEnabled") !== "false",
      gmailToken: gmailToken()
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
