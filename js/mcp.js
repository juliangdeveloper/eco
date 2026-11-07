import { APP_VERSION } from "./config.js";
import { store } from "./storage.js";
import { authorizeHeaders, getConnector } from "./connectors.js";

const CONNECTORS_STORE = "connectors";
const PROTOCOL_VERSION = "2025-06-18";
const SESSION_HEADER = "Mcp-Session-Id";
const VERSION_HEADER = "MCP-Protocol-Version";
const ACCEPT = "application/json, text/event-stream";
const SSE_TYPE = "text/event-stream";
const CLIENT_INFO = { name: "eco", version: APP_VERSION };
const MAX_TOOL_PAGES = 5;
const MAX_RESULT_CHARS = 20000;
const MAX_ERROR_CHARS = 300;
const NOT_CONNECTED = "not_connected";
const AUTH_OK = "ok";
const AUTH_REJECTED = "rejected_by_api";
const SESSION_EXPIRED_STATUS = 404;
const UNAUTHORIZED_STATUS = 401;
const FORBIDDEN_STATUS = 403;

const sessions = new Map();
let nextId = 1;

function parseSse(text, id) {
  let found = null;
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!data) {
      continue;
    }
    try {
      const message = JSON.parse(data);
      if (message.id === id || (found === null && (message.result || message.error))) {
        found = message;
      }
    } catch {
      continue;
    }
  }
  return found;
}

function resourceMetadata(response) {
  const header = response.headers.get("WWW-Authenticate") || "";
  const match = header.match(/resource_metadata="([^"]+)"/);
  return match ? match[1] : "";
}

async function post(connector, session, body, auth) {
  const headers = { "Content-Type": "application/json", Accept: ACCEPT, ...(connector.headers || {}) };
  if (session?.id) {
    headers[SESSION_HEADER] = session.id;
  }
  if (session?.version) {
    headers[VERSION_HEADER] = session.version;
  }
  if (auth) {
    const result = await authorizeHeaders(connector, headers);
    if (result !== AUTH_OK) {
      return { ok: false, error: NOT_CONNECTED, reason: result };
    }
  }
  let response;
  try {
    response = await window.fetch(connector.base_url, { method: "POST", headers, body: JSON.stringify(body) });
  } catch {
    return { ok: false, error: "No se pudo conectar con el servidor MCP" };
  }
  if (response.status === UNAUTHORIZED_STATUS || response.status === FORBIDDEN_STATUS) {
    return { ok: false, status: response.status, error: NOT_CONNECTED, reason: AUTH_REJECTED, auth_required: true, resource_metadata: resourceMetadata(response) };
  }
  if (response.status === SESSION_EXPIRED_STATUS && session?.id) {
    return { ok: false, status: response.status, session_expired: true };
  }
  const text = await response.text();
  if (body.id === undefined) {
    return { ok: response.ok, status: response.status };
  }
  let message = null;
  if ((response.headers.get("Content-Type") || "").includes(SSE_TYPE)) {
    message = parseSse(text, body.id);
  } else {
    try {
      message = JSON.parse(text);
    } catch {
      message = null;
    }
  }
  if (!response.ok || !message) {
    return { ok: false, status: response.status, error: text.slice(0, MAX_ERROR_CHARS) || "Respuesta inválida del servidor MCP" };
  }
  if (message.error) {
    return { ok: false, status: response.status, error: String(message.error.message || "Error MCP").slice(0, MAX_ERROR_CHARS) };
  }
  return { ok: true, result: message.result, sessionId: response.headers.get(SESSION_HEADER) || "" };
}

function request(method, params) {
  return { jsonrpc: "2.0", id: nextId++, method, params: params || {} };
}

async function openSession(connector, auth) {
  const init = await post(connector, null, request("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO }), auth);
  if (!init.ok) {
    return init;
  }
  const session = { id: init.sessionId, version: init.result?.protocolVersion || PROTOCOL_VERSION, server: init.result?.serverInfo || {} };
  await post(connector, session, { jsonrpc: "2.0", method: "notifications/initialized" }, auth);
  sessions.set(connector.id, session);
  return { ok: true, session };
}

async function rpc(connector, method, params, auth = true) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let session = sessions.get(connector.id);
    if (!session) {
      const opened = await openSession(connector, auth);
      if (!opened.ok) {
        return opened;
      }
      session = opened.session;
    }
    const result = await post(connector, session, request(method, params), auth);
    if (!result.session_expired) {
      return result;
    }
    sessions.delete(connector.id);
  }
  return { ok: false, error: "La sesión MCP expiró" };
}

export async function probeMcp(connector) {
  sessions.delete(connector.id);
  const opened = await openSession(connector, false);
  sessions.delete(connector.id);
  if (opened.ok) {
    return { ok: true, auth_required: false, server: opened.session.server };
  }
  if (opened.auth_required) {
    return { ok: true, auth_required: true, resource_metadata: opened.resource_metadata };
  }
  return { ok: false, error: opened.error || "No responde como servidor MCP" };
}

function compactTool(tool) {
  return {
    name: String(tool.name || ""),
    description: String(tool.description || "").slice(0, MAX_ERROR_CHARS * 3),
    inputSchema: tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : { type: "object", properties: {} },
    readOnly: tool.annotations?.readOnlyHint === true
  };
}

export async function verifyMcp(id) {
  const connector = await getConnector(id);
  if (!connector || connector.kind !== "mcp") {
    return { ok: false, error: "Conector no encontrado" };
  }
  sessions.delete(id);
  const tools = [];
  let cursor;
  for (let page = 0; page < MAX_TOOL_PAGES; page++) {
    const result = await rpc(connector, "tools/list", cursor ? { cursor } : {}, connector.auth.type !== "none");
    if (!result.ok) {
      await store(CONNECTORS_STORE, { ...connector, tools: [], verified: false });
      return result;
    }
    tools.push(...(result.result?.tools || []).map(compactTool).filter((tool) => tool.name));
    cursor = result.result?.nextCursor;
    if (!cursor) {
      break;
    }
  }
  if (!tools.length) {
    await store(CONNECTORS_STORE, { ...connector, tools: [], verified: false });
    return { ok: false, error: "El servidor MCP no ofrece herramientas" };
  }
  await store(CONNECTORS_STORE, { ...connector, tools, verified: true });
  return { ok: true, tools: tools.length };
}

export async function callMcpTool(id, name, args) {
  const connector = await getConnector(id);
  if (!connector || connector.kind !== "mcp") {
    return { ok: false, error: "Conector no encontrado" };
  }
  const result = await rpc(connector, "tools/call", { name, arguments: args || {} }, connector.auth.type !== "none");
  if (!result.ok) {
    if (result.error === NOT_CONNECTED) {
      sessions.delete(id);
      await store(CONNECTORS_STORE, { ...connector, verified: false });
    }
    return result;
  }
  const content = (result.result?.content || []).map((item) => (item.type === "text" ? item.text : JSON.stringify(item))).join("\n");
  const data = result.result?.structuredContent ?? content;
  const text = typeof data === "string" ? data : JSON.stringify(data);
  return { ok: !result.result?.isError, data: text.slice(0, MAX_RESULT_CHARS) };
}

export function forgetMcpSession(id) {
  sessions.delete(id);
}
