import { all, remove, store } from "./storage.js";
import { deleteSecret, hasSecret, readSecret, saveSecret } from "./vault.js";

const CONNECTORS_STORE = "connectors";
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
const AUTH_TYPES = ["none", "bearer", "api_key", "basic", "oauth2"];
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const OAUTH_FLOWS = ["pkce", "implicit"];
const MAX_RESPONSE_CHARS = 20000;
const MAX_OPERATIONS = 30;
const OAUTH_TIMEOUT_MS = 300000;
const OAUTH_POLL_MS = 500;
const OAUTH_MESSAGE_TYPE = "eco-oauth";
const OAUTH_REDIRECT_PAGE = "oauth.html";
const POPUP_FEATURES = "popup,width=480,height=640";
const VERIFIER_BYTES = 48;
const STATE_BYTES = 24;
const EXPIRY_MARGIN_MS = 60000;
const DEFAULT_API_KEY_HEADER = "X-API-Key";
const DEFAULT_BEARER_PREFIX = "Bearer ";
const NOT_CONNECTED = "not_connected";
const RENEWAL_MODES = ["refresh_token", "silent", "none"];
const SILENT_TIMEOUT_MS = 20000;
const SILENT_FRAME_ID = "ecoSilentAuth";

export const STATUS = Object.freeze({ CONNECTED: "conectado", DISCONNECTED: "sin conectar", EXPIRED: "expirado" });

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export function validateConnector(definition) {
  if (!definition || typeof definition !== "object") {
    return { ok: false, error: "Definición inválida" };
  }
  if (!ID_PATTERN.test(String(definition.id || ""))) {
    return { ok: false, error: "id inválido" };
  }
  if (!String(definition.name || "").trim()) {
    return { ok: false, error: "Falta name" };
  }
  if (!isHttpsUrl(definition.base_url)) {
    return { ok: false, error: "base_url debe ser https" };
  }
  const auth = definition.auth || {};
  if (!AUTH_TYPES.includes(auth.type)) {
    return { ok: false, error: "auth.type inválido" };
  }
  if (auth.type === "oauth2") {
    if (!isHttpsUrl(auth.authorize_url)) {
      return { ok: false, error: "auth.authorize_url debe ser https" };
    }
    const flow = auth.flow || "pkce";
    if (!OAUTH_FLOWS.includes(flow)) {
      return { ok: false, error: "auth.flow inválido" };
    }
    if (flow === "pkce" && !isHttpsUrl(auth.token_url)) {
      return { ok: false, error: "auth.token_url debe ser https" };
    }
    if (auth.developer_url !== undefined && !isHttpsUrl(auth.developer_url)) {
      return { ok: false, error: "auth.developer_url debe ser https" };
    }
    if (auth.renewal !== undefined && !RENEWAL_MODES.includes(auth.renewal)) {
      return { ok: false, error: "auth.renewal inválido" };
    }
  }
  const operations = definition.operations;
  if (!Array.isArray(operations) || !operations.length || operations.length > MAX_OPERATIONS) {
    return { ok: false, error: "operations inválidas" };
  }
  for (const operation of operations) {
    if (!operation || !String(operation.name || "").trim()) {
      return { ok: false, error: "Operación sin name" };
    }
    if (!METHODS.includes(String(operation.method || "").toUpperCase())) {
      return { ok: false, error: "Método inválido en " + operation.name };
    }
    if (!String(operation.path || "").startsWith("/")) {
      return { ok: false, error: "La ruta debe empezar con / en " + operation.name };
    }
  }
  return { ok: true };
}

export function normalizeConnector(definition) {
  const auth = { ...definition.auth };
  if (auth.type === "oauth2") {
    auth.flow = auth.flow || "pkce";
    auth.scopes = Array.isArray(auth.scopes) ? auth.scopes.map(String) : [];
    auth.renewal = RENEWAL_MODES.includes(auth.renewal) ? auth.renewal : auth.flow === "implicit" ? "silent" : "refresh_token";
  }
  return {
    id: definition.id,
    name: String(definition.name).trim(),
    base_url: String(definition.base_url).replace(/\/+$/, ""),
    auth,
    operations: definition.operations.map((operation) => ({
      name: String(operation.name).trim(),
      description: String(operation.description || ""),
      method: String(operation.method).toUpperCase(),
      path: String(operation.path),
      params: operation.params && typeof operation.params === "object" ? operation.params : {},
      write: operation.write === true || String(operation.method).toUpperCase() !== "GET"
    })),
    createdAt: definition.createdAt || Date.now()
  };
}

export async function saveConnector(definition) {
  const connector = normalizeConnector(definition);
  await store(CONNECTORS_STORE, connector);
  return connector;
}

export async function listConnectors() {
  const rows = await all(CONNECTORS_STORE);
  return rows.sort((left, right) => (left.createdAt || 0) - (right.createdAt || 0));
}

export async function getConnector(id) {
  return (await listConnectors()).find((item) => item.id === id) || null;
}

export async function deleteConnector(id) {
  await deleteSecret(id);
  await remove(CONNECTORS_STORE, id);
}

export async function connectorStatus(id) {
  const connector = await getConnector(id);
  if (!connector) {
    return STATUS.DISCONNECTED;
  }
  if (connector.auth.type === "none") {
    return STATUS.CONNECTED;
  }
  if (!(await hasSecret(id))) {
    return STATUS.DISCONNECTED;
  }
  if (connector.auth.type === "oauth2") {
    const secret = await readSecret(id);
    if (!secret || !secret.access_token) {
      return STATUS.DISCONNECTED;
    }
    if (secret.renewal_failed || (secret.expires_at && secret.expires_at < Date.now() && !secret.refresh_token)) {
      return STATUS.EXPIRED;
    }
  }
  return STATUS.CONNECTED;
}

export async function saveManualCredential(id, values) {
  const connector = await getConnector(id);
  if (!connector) {
    return false;
  }
  const type = connector.auth.type;
  if (type === "bearer" && values.token) {
    await saveSecret(id, { token: values.token });
    return true;
  }
  if (type === "api_key" && values.key) {
    await saveSecret(id, { key: values.key });
    return true;
  }
  if (type === "basic" && values.username && values.password !== undefined) {
    await saveSecret(id, { username: values.username, password: values.password });
    return true;
  }
  return false;
}

function base64Utf8(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64Url(bytes) {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomString(size) {
  return base64Url(crypto.getRandomValues(new Uint8Array(size)));
}

async function refreshToken(connector, secret) {
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: secret.refresh_token, client_id: secret.client_id || connector.auth.client_id || "" });
  const response = await window.fetch(connector.auth.token_url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!response.ok) {
    return null;
  }
  const data = await response.json();
  const next = {
    ...secret,
    access_token: data.access_token,
    refresh_token: data.refresh_token || secret.refresh_token,
    expires_at: data.expires_in ? Date.now() + Number(data.expires_in) * 1000 : 0,
    renewal_failed: false
  };
  await saveSecret(connector.id, next);
  return next;
}

async function authorize(connector, url, headers) {
  const type = connector.auth.type;
  if (type === "none") {
    return true;
  }
  let secret = await readSecret(connector.id);
  if (!secret) {
    return false;
  }
  if (type === "bearer") {
    headers.Authorization = (connector.auth.prefix ?? DEFAULT_BEARER_PREFIX) + secret.token;
    return true;
  }
  if (type === "api_key") {
    if (connector.auth.query_param) {
      url.searchParams.set(connector.auth.query_param, secret.key);
    } else {
      headers[connector.auth.header || DEFAULT_API_KEY_HEADER] = secret.key;
    }
    return true;
  }
  if (type === "basic") {
    headers.Authorization = "Basic " + base64Utf8(secret.username + ":" + secret.password);
    return true;
  }
  if (secret.expires_at && secret.expires_at - EXPIRY_MARGIN_MS < Date.now()) {
    if (!(await renewCredential(connector.id))) {
      return false;
    }
    secret = await readSecret(connector.id);
  }
  headers.Authorization = DEFAULT_BEARER_PREFIX + secret.access_token;
  return true;
}

export async function connectorFetch(id, method, path, query, body) {
  const connector = await getConnector(id);
  if (!connector) {
    return { ok: false, error: "Conector no encontrado" };
  }
  const base = new URL(connector.base_url);
  const url = new URL(connector.base_url + path);
  if (url.origin !== base.origin) {
    return { ok: false, error: "Ruta fuera del conector" };
  }
  for (const [key, value] of Object.entries(query || {})) {
    url.searchParams.set(key, typeof value === "string" ? value : JSON.stringify(value));
  }
  const headers = { Accept: "application/json" };
  if (!(await authorize(connector, url, headers))) {
    return { ok: false, error: NOT_CONNECTED };
  }
  const init = { method, headers };
  if (body && Object.keys(body).length) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await window.fetch(url.href, init);
  } catch {
    return { ok: false, error: "No se pudo conectar con el servicio" };
  }
  if (response.status === 401 && connector.auth.type !== "none") {
    return { ok: false, status: 401, error: NOT_CONNECTED };
  }
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text.slice(0, MAX_RESPONSE_CHARS);
  }
  if (typeof data !== "string" && JSON.stringify(data).length > MAX_RESPONSE_CHARS) {
    data = JSON.stringify(data).slice(0, MAX_RESPONSE_CHARS);
  }
  return { ok: response.ok, status: response.status, data };
}

function authorizeParams(auth, clientId, state, responseType) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(),
    response_type: responseType,
    scope: (auth.scopes || []).join(" "),
    state
  });
  for (const [key, value] of Object.entries(auth.extra_params || {})) {
    params.set(key, String(value));
  }
  return params;
}

function authorizeUrl(auth, params) {
  return auth.authorize_url + (auth.authorize_url.includes("?") ? "&" : "?") + params.toString();
}

function waitForFrame(frame, state) {
  return new Promise((resolve) => {
    const finish = (value) => {
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      frame.remove();
      resolve(value);
    };
    const onMessage = (event) => {
      if (event.origin !== location.origin || !event.data || event.data.type !== OAUTH_MESSAGE_TYPE) {
        return;
      }
      const params = event.data.params || {};
      if (params.state === state) {
        finish(params);
      }
    };
    const timer = setTimeout(() => finish({ error: "timeout" }), SILENT_TIMEOUT_MS);
    window.addEventListener("message", onMessage);
  });
}

async function silentImplicit(connector, secret) {
  const clientId = secret.client_id || connector.auth.client_id;
  if (!clientId) {
    return null;
  }
  const state = randomString(STATE_BYTES);
  const params = authorizeParams(connector.auth, clientId, state, "token");
  params.set("prompt", "none");
  if (secret.login_hint) {
    params.set("login_hint", secret.login_hint);
  }
  document.getElementById(SILENT_FRAME_ID)?.remove();
  const frame = document.createElement("iframe");
  frame.id = SILENT_FRAME_ID;
  frame.hidden = true;
  frame.setAttribute("aria-hidden", "true");
  const result = waitForFrame(frame, state);
  frame.src = authorizeUrl(connector.auth, params);
  document.body.append(frame);
  const response = await result;
  if (response.error || !response.access_token) {
    return null;
  }
  const next = {
    ...secret,
    access_token: response.access_token,
    expires_at: response.expires_in ? Date.now() + Number(response.expires_in) * 1000 : 0,
    renewal_failed: false
  };
  await saveSecret(connector.id, next);
  return next;
}

const renewals = new Map();

async function renewNow(id) {
  const connector = await getConnector(id);
  if (!connector || connector.auth.type !== "oauth2") {
    return false;
  }
  const secret = await readSecret(id);
  if (!secret || !secret.access_token) {
    return false;
  }
  let next = null;
  try {
    if (secret.refresh_token && connector.auth.token_url) {
      next = await refreshToken(connector, secret);
    } else if (connector.auth.renewal === "silent" && connector.auth.flow === "implicit") {
      next = await silentImplicit(connector, secret);
    }
  } catch {
    next = null;
  }
  if (!next) {
    await saveSecret(id, { ...secret, renewal_failed: true });
    return false;
  }
  return true;
}

export function renewCredential(id) {
  if (!renewals.has(id)) {
    renewals.set(id, renewNow(id).finally(() => renewals.delete(id)));
  }
  return renewals.get(id);
}

export async function credentialsDue(aheadMs) {
  const due = [];
  for (const connector of await listConnectors()) {
    if (connector.auth.type !== "oauth2" || connector.auth.renewal === "none") {
      continue;
    }
    const secret = await readSecret(connector.id);
    if (!secret || !secret.access_token || secret.renewal_failed || !secret.expires_at) {
      continue;
    }
    if (secret.expires_at - aheadMs <= Date.now()) {
      due.push(connector.id);
    }
  }
  return due;
}

function waitForOAuth(popup, state) {
  return new Promise((resolve, reject) => {
    const finish = (callback, value) => {
      clearInterval(poll);
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      callback(value);
    };
    const onMessage = (event) => {
      if (event.origin !== location.origin || !event.data || event.data.type !== OAUTH_MESSAGE_TYPE) {
        return;
      }
      const params = event.data.params || {};
      if (params.state !== state) {
        finish(reject, new Error("state"));
        return;
      }
      finish(resolve, params);
    };
    const poll = setInterval(() => {
      if (popup.closed) {
        finish(reject, new Error("closed"));
      }
    }, OAUTH_POLL_MS);
    const timer = setTimeout(() => finish(reject, new Error("timeout")), OAUTH_TIMEOUT_MS);
    window.addEventListener("message", onMessage);
  });
}

export function redirectUri() {
  const url = new URL(OAUTH_REDIRECT_PAGE, location.href);
  url.search = "";
  url.hash = "";
  return url.href;
}

export async function startOAuth(id, clientId) {
  const connector = await getConnector(id);
  if (!connector || connector.auth.type !== "oauth2" || !clientId) {
    return false;
  }
  const auth = connector.auth;
  const state = randomString(STATE_BYTES);
  const params = authorizeParams(auth, clientId, state, auth.flow === "implicit" ? "token" : "code");
  let verifier = "";
  if (auth.flow !== "implicit") {
    verifier = randomString(VERIFIER_BYTES);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    params.set("code_challenge", base64Url(digest));
    params.set("code_challenge_method", "S256");
  }
  const popup = window.open(authorizeUrl(auth, params), "eco-oauth", POPUP_FEATURES);
  if (!popup) {
    return false;
  }
  let result;
  try {
    result = await waitForOAuth(popup, state);
  } catch {
    return false;
  }
  if (result.error) {
    return false;
  }
  let token = {};
  if (auth.flow === "implicit") {
    token = { access_token: result.access_token, expires_in: result.expires_in };
  } else {
    const body = new URLSearchParams({ grant_type: "authorization_code", code: result.code || "", redirect_uri: redirectUri(), client_id: clientId, code_verifier: verifier });
    try {
      const response = await window.fetch(auth.token_url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
      if (!response.ok) {
        return false;
      }
      token = await response.json();
    } catch {
      return false;
    }
  }
  if (!token.access_token) {
    return false;
  }
  await saveSecret(id, {
    access_token: token.access_token,
    refresh_token: token.refresh_token || "",
    expires_at: token.expires_in ? Date.now() + Number(token.expires_in) * 1000 : 0,
    client_id: clientId,
    renewal_failed: false
  });
  await store(CONNECTORS_STORE, { ...connector, auth: { ...auth, client_id: clientId } });
  return true;
}

export async function publicConnectors() {
  const rows = await listConnectors();
  const result = [];
  for (const connector of rows) {
    result.push({
      id: connector.id,
      name: connector.name,
      base_url: connector.base_url,
      auth_type: connector.auth.type,
      renewal: connector.auth.renewal || "none",
      status: await connectorStatus(connector.id),
      operations: connector.operations
    });
  }
  return result;
}
