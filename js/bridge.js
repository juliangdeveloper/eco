import { stepLimits } from "./step-limits.js";
import { prepareReload, commitReload } from "./reload.js";
import { redactSecurityData } from "./security.js";
import { discoverEnvironment, readEnvironmentStorage } from "./environment.js";
import { readDeviceDocumentation, listDeviceTools, manageDeviceTool, callDeviceTool } from "./device-tools.js";
import { timedFetch } from "./network.js";
import { passiveMemory, memoryCall, configureMemory, databaseMemoryGuide, topicSkill, topicSkills } from "./passive-skills.js";
import { abortJob, jobRecords, jobSignal, jobSnapshot, jobUpdate, resumeJob } from "./subagents.js";
import { DEFAULT_MODEL } from "./config.js";
import { all, remove, setting, store } from "./storage.js";
import { connectorFetch, deleteConnector, getConnector, normalizeConnector, publicConnectors, saveConnector, validateConnector } from "./connectors.js";
import { showCredentialCard } from "./credentials.js";
import { searchSessions } from "./sessions.js";
import { routinesCall } from "./routines.js";
import { callMcpTool, probeMcp, verifyMcp } from "./mcp.js";

const MCP_KIND = "mcp";
const PROBE_ID = "probe";
const MEMORY_CONTEXT_CHAR_LIMIT = 16000;
const GENERAL_MEMORY_TAG = /^(reglas?|instrucciones?|general|global|preferencias?|rules?|instructions?)$/i;
const PROJECT_MEMORY_TAG = /^proyecto[:=/](.+)$/i;
const TASK_STOP_WORDS = new Set(["proyecto", "archivos", "revisar", "revisa", "tarea", "para", "como", "esta", "este", "hacer", "sobre", "with", "from", "that", "this", "project"]);

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
  delete auth.secret_of;
  if (previous?.auth?.client_id && auth.type === "oauth2") {
    auth.client_id = previous.auth.client_id;
  }
  const connector = await saveConnector({ ...normalized, auth, createdAt: previous?.createdAt });
  stateApi?.refreshConnectors();
  let status;
  if (connector.kind === MCP_KIND && connector.auth.type === "none") {
    const check = await verifyMcp(connector.id);
    status = check.ok ? "conectado" : "sin conectar";
    if (!check.ok) {
      stateApi?.refreshConnectors();
      return JSON.stringify({ ok: false, id: connector.id, status, error: check.error || "No se pudieron leer las herramientas" });
    }
  } else {
    status = connector.auth.type === "none" ? "conectado" : await showCredentialCard(connector);
  }
  stateApi?.refreshConnectors();
  return JSON.stringify({ ok: true, id: connector.id, status });
}

window.ecoBridge = {
  async prepareReload(raw) { return JSON.stringify(prepareReload(parsed(raw))); },
  commitReload,
  async deviceEnvironment() { return JSON.stringify(await discoverEnvironment()); },
  async deviceStorage() { return JSON.stringify(readEnvironmentStorage()); },
  async deviceDocumentation(url) {
    try { return JSON.stringify(await readDeviceDocumentation(String(url))); }
    catch (error) { return JSON.stringify({ ok: false, error: String(error.message || error) }); }
  },
  async deviceTools(name) { return JSON.stringify(await listDeviceTools(String(name || ""))); },
  async deviceManage(raw) {
    try { return JSON.stringify(await manageDeviceTool(parsed(raw))); }
    catch (error) { return JSON.stringify({ ok: false, error: String(error.message || error) }); }
  },
  async deviceCall(name, raw, sessionId, jobId) { return JSON.stringify(await callDeviceTool(String(name), parsed(raw), jobSignal(jobId))); },
  async abortJob(id) { abortJob(id); return true; },
  async resumeJob(id) { resumeJob(id); return true; },
  jobUpdate,
  async turnUpdate(raw, sessionId) {
    await stateApi?.turnUpdate(sessionId, parsed(raw));
    return true;
  },
  async jobRecords(sessionId) {
    return JSON.stringify(await jobRecords(sessionId));
  },
  async jobSnapshot(id, sessionId) {
    return JSON.stringify(await jobSnapshot(id, sessionId));
  },
  async memoryContext(task, project) {
    if (!await passiveMemory()) return JSON.stringify({ estado: "Memoria local" });
    const result = await memoryCall("reglas", {});
    const words = (String(task).toLocaleLowerCase().match(/[\p{L}\p{N}_-]{4,}/gu) || []).filter((word) => !TASK_STOP_WORDS.has(word));
    const projectName = String(project).trim().toLocaleLowerCase();
    const superseded = new Set(result.records.map((row) => row.replaces).filter(Boolean));
    const records = result.records.filter((row) => !superseded.has(row.id)).map((row) => {
      const tags = String(row.tags || "").split(",").map((tag) => tag.trim());
      const content = String(row.content + " " + row.tags).toLocaleLowerCase();
      const scopes = tags.map((tag) => tag.match(PROJECT_MEMORY_TAG)?.[1]?.toLocaleLowerCase()).filter(Boolean);
      const projectMatch = projectName && (scopes.length ? scopes.includes(projectName) : content.includes(projectName));
      const sharedRule = tags.some((tag) => GENERAL_MEMORY_TAG.test(tag)) && (!scopes.length || projectMatch);
      const relevant = projectMatch || !scopes.length && words.some((word) => content.includes(word));
      return { row, score: (sharedRule ? 2 : 0) + (relevant ? 1 : 0) };
    }).filter(({ row, score }) => score && (["memory", "fact"].includes(row.type) || score >= 2)).sort((a, b) => b.score - a.score);
    const selected = [];
    let used = 0;
    for (const { row } of records) {
      const size = JSON.stringify(row).length;
      if (used + size > MEMORY_CONTEXT_CHAR_LIMIT) continue;
      selected.push(row);
      used += size;
    }
    return JSON.stringify({ records: selected, omitidos: records.length - selected.length, contenido_no_confiable: true });
  },
  fetch(url, init, sessionId, jobId) {
    const options = plain(init);
    if (options.body == null) {
      delete options.body;
    }
    options.signal = jobSignal(jobId);
    return timedFetch(url, options);
  },
  async config() {
    return JSON.stringify({
      key: setting("openrouterKey"),
      model: setting("model") || DEFAULT_MODEL,
      ...stepLimits(),
      origin: location.origin
    });
  },
  async state(sessionId, jobId) {
    return JSON.stringify({
      memory: setting("memory"),
      user: setting("user"),
      todos: await stateApi?.todos(sessionId, jobId) || []
    });
  },
  async saveMemory(target, value) {
    if (!["memory", "user"].includes(target)) throw new Error("Destino inválido");
    setting(target, String(value));
    stateApi?.refreshAgent();
    return true;
  },
  async saveTodos(raw, sessionId, jobId) {
    await stateApi?.setTodos(parsed(raw), sessionId, jobId);
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
  async connectorFetch(id, method, path, queryJson, bodyJson, sessionId, jobId) {
    const result = await connectorFetch(String(id), String(method), String(path), parsed(queryJson) || {}, parsed(bodyJson), false, jobSignal(jobId));
    return JSON.stringify(result);
  },
  async probeMcp(url, headersJson) {
    let headers = {};
    try {
      headers = Object.fromEntries(Object.entries(parsed(headersJson) || {}).filter(([key]) => /^X-MCP-/i.test(key)));
    } catch {
      headers = {};
    }
    try {
      const target = new URL(String(url));
      if (target.protocol !== "https:") {
        return JSON.stringify({ ok: false, error: "La URL debe ser https" });
      }
      return JSON.stringify(await probeMcp({ id: PROBE_ID, base_url: target.href, auth: { type: "none" }, headers }));
    } catch {
      return JSON.stringify({ ok: false, error: "URL inválida" });
    }
  },
  async replaceConnector(id) {
    const connector = await getConnector(String(id));
    if (!connector || connector.kind === MCP_KIND) {
      return JSON.stringify({ ok: false });
    }
    await deleteConnector(connector.id);
    stateApi?.refreshConnectors();
    return JSON.stringify({ ok: true });
  },
  async mcpCall(id, name, argsJson, sessionId, jobId) {
    let args = {};
    try {
      args = parsed(argsJson) || {};
    } catch {
      args = {};
    }
    const result = redactSecurityData(await callMcpTool(String(id), String(name), args, jobSignal(jobId)));
    stateApi?.refreshConnectors();
    return JSON.stringify(result);
  },
  async databaseMemoryGuide() { return databaseMemoryGuide(); },
  async passiveTopics() {
    return JSON.stringify(topicSkills());
  },
  async passiveTopic(name) {
    return JSON.stringify(await topicSkill(String(name)));
  },
  async passiveSkills() {
    return JSON.stringify(await passiveMemory());
  },
  async configureMemory(action) {
    const result = await configureMemory(typeof action === "string" && !action.trim().startsWith("{") ? action : parsed(action));
    stateApi?.refreshConnectors();
    return JSON.stringify(result);
  },
  async memoryCall(action, argsJson) {
    return JSON.stringify(await memoryCall(String(action), parsed(argsJson)));
  },
  async routines(action, argsJson) {
    try {
      return JSON.stringify(await routinesCall(String(action), parsed(argsJson)));
    } catch {
      return JSON.stringify({ ok: false, error: "No se pudo guardar la rutina" });
    }
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
  clarify(question, optionsJson, sessionId, jobId) {
    return window.ecoUI.clarify(question, optionsJson, jobId, jobSignal(jobId));
  },
  async onToolStart(name, argsJson, sessionId, jobId) {
    if (jobId || sessionId !== stateApi?.sessionId()) return;
    toolListener(name, "trabajando", argsJson);
  },
  async onToolEnd(name, resultJson, sessionId, jobId) {
    if (jobId || sessionId !== stateApi?.sessionId()) return;
    let result = resultJson;
    try {
      result = parsed(resultJson);
    } catch {
      result = resultJson;
    }
    toolListener(name, result?.error !== undefined ? "error" : "listo", result);
  }
};
