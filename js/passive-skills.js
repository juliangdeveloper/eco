import { featureDefinitions, featureValue } from "./environment.js";
import { isWiping, memoryConfigured, reportMemoryConnection, securityState, setMemoryHealth } from "./security.js";
import { APP_VERSION, DEFAULT_MODEL } from "./config.js";
import { json, setting } from "./storage.js";
import { connectorFetch, connectorStatus, getConnector, saveConnector, STATUS } from "./connectors.js";
import { showCredentialCard } from "./credentials.js";
import { sheetId } from "./memory-drive.js";
import { MEMORY_BACKENDS, OBSIDIAN_ACTIONS, memoryDependencies } from "./memory-backends.js";
import { MemorySet } from "./memory-set.js";
import { publicIp } from "./public-ip.js";

const PRESENCE_INTERVAL_MS = 12 * 60 * 60 * 1000;
const PROBE_STALE_MS = 5 * 60 * 1000;
const IP_WAIT_MS = 6000;
const CAPABILITY_LABELS = { mediaDevices: "camera and microphone", geolocation: "location", bluetooth: "Bluetooth", usb: "USB", serial: "serial", hid: "HID", nfc: "NFC", clipboard: "clipboard" };
const CONFIG_KEY = "persistentMemory";
const CONNECTOR_ID = "eco-memory-drive";
const SHEET_TITLE = "Eco · Memoria";
const SHEET_MIME = "application/vnd.google-apps.spreadsheet";
const MAX_CANDIDATES = 10;
const MAX_MENTION_BATCHES = 5;
const BROADCAST = "*";
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ADAPTERS = Object.freeze({
  ...MEMORY_BACKENDS,
  "google-drive": {
    name: "Persistent memory in Google Drive",
    skill: "assets/skills/memoria-google-drive.txt",
    create: MEMORY_BACKENDS["google-drive"].create,
    connector: {
      id: CONNECTOR_ID,
      name: "Persistent memory in Google Drive",
      base_url: "https://sheets.googleapis.com",
      auth: { type: "oauth2", flow: "implicit", renewal: "silent", authorize_url: "https://accounts.google.com/o/oauth2/v2/auth", scopes: ["https://www.googleapis.com/auth/spreadsheets", "https://www.googleapis.com/auth/drive"] },
      operations: [{ name: "leer", method: "GET", path: "/v4/spreadsheets/{id}", write: false }]
    }
  }
});
const DRIVE_FILES_CONNECTOR = Object.freeze({
  id: "google-drive-archivos",
  name: "Google Drive · files",
  base_url: "https://www.googleapis.com",
  auth: { type: "oauth2", flow: "implicit", renewal: "silent", secret_of: CONNECTOR_ID, authorize_url: "https://accounts.google.com/o/oauth2/v2/auth", scopes: ["https://www.googleapis.com/auth/spreadsheets", "https://www.googleapis.com/auth/drive"] },
  operations: [
    { name: "buscar_archivos", description: "Lists or searches Drive files and folders. q uses Drive search syntax, for example name contains 'report' and trashed = false.", method: "GET", path: "/drive/v3/files", params: { q: { type: "string", in: "query" }, pageSize: { type: "integer", in: "query" }, pageToken: { type: "string", in: "query" }, orderBy: { type: "string", in: "query" }, fields: { type: "string", in: "query", description: "Defaults to nextPageToken, files(id,name,mimeType,modifiedTime,parents,webViewLink)." } } },
    { name: "ver_archivo", description: "A file's metadata.", method: "GET", path: "/drive/v3/files/{fileId}", params: { fileId: { type: "string", in: "path", required: true }, fields: { type: "string", in: "query" } } },
    { name: "descargar_archivo", description: "Content of a non-Google file (text, JSON, CSV...). Uses alt=media.", method: "GET", path: "/drive/v3/files/{fileId}", params: { fileId: { type: "string", in: "path", required: true }, alt: { type: "string", in: "query", required: true, description: "Always media." } } },
    { name: "exportar_archivo", description: "Exports a Google Doc, Sheet or Slides file to text. mimeType: text/plain for Docs, text/csv for Sheets, text/plain for Slides.", method: "GET", path: "/drive/v3/files/{fileId}/export", params: { fileId: { type: "string", in: "path", required: true }, mimeType: { type: "string", in: "query", required: true } } },
    { name: "crear_archivo", description: "Creates an empty file or folder (folder: mimeType application/vnd.google-apps.folder; Doc: application/vnd.google-apps.document).", method: "POST", path: "/drive/v3/files", params: { name: { type: "string", in: "body", required: true }, mimeType: { type: "string", in: "body" }, parents: { type: "array", in: "body" } } },
    { name: "actualizar_archivo", description: "Renames, moves to the trash (trashed true) or changes the description. To move, use addParents and removeParents.", method: "PATCH", path: "/drive/v3/files/{fileId}", params: { fileId: { type: "string", in: "path", required: true }, name: { type: "string", in: "body" }, trashed: { type: "boolean", in: "body" }, description: { type: "string", in: "body" }, addParents: { type: "string", in: "query" }, removeParents: { type: "string", in: "query" } } }
  ]
});
const SHARED_SKILL = "assets/skills/memoria-varias.txt";
const TOPIC_SKILLS = Object.freeze([
  { id: "contenedores", description: "Containers, Docker, sandboxed environments or running code on a server.", skill: "assets/skills/contenedores.txt" },
  { id: "modo-cara", description: "Face mode: an animated face or avatar for Eco.", skill: "assets/skills/modo-cara.txt" },
  { id: "chat-voz", description: "Talking to Eco by voice, dictating or listening to its replies.", skill: "assets/skills/chat-voz.txt" },
  { id: "vault", description: "Vault: storing your own passwords, keys or secrets in Eco.", skill: "assets/skills/vault.txt" },
  { id: "llm-local", description: "Using a local or cloud-free model (WebGPU, WebLLM, Ollama, LM Studio).", skill: "assets/skills/llm-local.txt" },
  { id: "magic", description: "Magic, Eco's magic mode.", skill: "assets/skills/magic.txt" }
]);
const QUEUE_PREFIX = "memoryQueue:";
const BACKEND_LABELS = Object.freeze({ "google-drive": "Google Sheet", supabase: "Supabase", database: "Database", obsidian: "Obsidian" });
const skillTexts = new Map();
const adapters = new Map();
const memberStatus = new Map();
let flushing = null;
let presenceTimer;
let presencePending = null;
let presenceIdentity = "";
let presenceUpdated = 0;

function identityOf(config) {
  if (config.backend === "google-drive") return [config.backend, config.sheet, config.eco, config.usuario].join(":");
  if (config.backend === "obsidian") return [config.backend, config.connector, config.folder, JSON.stringify(config.operations || {}), JSON.stringify(config.arguments || {}), JSON.stringify(config.operation_args || {}), config.eco, config.usuario].join(":");
  return [config.backend, config.connector, config.operation, config.mode, config.sql_argument, JSON.stringify(config.operations), config.eco, config.usuario].join(":");
}

function memoryRequest() {
  return memoryDependencies({ backend: "google-drive" }).request;
}

export function memoryKey(config) {
  return [config.backend, config.backend === "google-drive" ? config.sheet : config.connector, config.backend === "obsidian" ? config.folder || "Eco" : ""].filter(Boolean).join(":");
}

const connectorOf = config => config.backend === "google-drive" ? CONNECTOR_ID : config.connector;

function memberConfigs() {
  const state = json(CONFIG_KEY);
  if (!state || typeof state !== "object") return [];
  const { mirrors, ...primary } = state;
  return [primary, ...(Array.isArray(mirrors) ? mirrors : [])].filter(config => config && ADAPTERS[config.backend] && (config.backend === "google-drive" ? config.sheet : config.connector));
}

function saveMembers(list) {
  json(CONFIG_KEY, list.length ? { ...list[0], ...(list.length > 1 ? { mirrors: list.slice(1) } : {}) } : null);
  presenceIdentity = "";
}

function roleFor(config, rol) {
  const others = memberConfigs().filter(item => memoryKey(item) !== memoryKey(config));
  const current = memberConfigs().findIndex(item => memoryKey(item) === memoryKey(config));
  if (!others.length || rol === "principal" || current === 0 && rol !== "copia") return "principal";
  return "copia";
}

function nameFor(config, role) {
  if (role !== "copia") return config;
  const primary = memberConfigs().find(item => memoryKey(item) !== memoryKey(config));
  return { ...config, eco: primary.eco, usuario: primary.usuario };
}

function placeMemory(config, role) {
  const list = memberConfigs(), key = memoryKey(config), current = list.findIndex(item => memoryKey(item) === key);
  if (current >= 0) list.splice(current, 1);
  if (role === "principal" || !list.length) {
    list.unshift(config);
    for (const item of list) Object.assign(item, { eco: config.eco, usuario: config.usuario });
  } else list.splice(current > 0 ? current : list.length, 0, { ...config, eco: list[0].eco, usuario: list[0].usuario });
  saveMembers(list);
  return list[0] === config ? "principal" : "copia";
}

function reporter(key) {
  return ok => {
    memberStatus.set(key, { ...memberStatus.get(key), [ok ? "ok" : "fail"]: performance.now(), last: ok });
    if (ok) return reportMemoryConnection(true);
    if (memberConfigs().every(config => memberStatus.get(memoryKey(config))?.last !== true)) reportMemoryConnection(false);
  };
}

function adapter(config) {
  const definition = ADAPTERS[config.backend];
  if (!definition) throw new Error("Unsupported memory destination.");
  const identity = identityOf(config);
  if (!adapters.has(identity)) {
    const cursorKey = "memoryCursor:" + identity;
    adapters.set(identity, definition.create({ config, ...memoryDependencies(config, reporter(memoryKey(config))), loadCursor: () => json(cursorKey), saveCursor: (cursor) => json(cursorKey, cursor) }));
  }
  return adapters.get(identity);
}

const queueStore = { load: key => json(QUEUE_PREFIX + key) || [], save: (key, list) => json(QUEUE_PREFIX + key, list.length ? list : null) };

async function memorySet() {
  const configs = memberConfigs();
  if (!configs.length) return null;
  const members = await Promise.all(configs.map(async config => ({ key: memoryKey(config), identity: identityOf(config), label: BACKEND_LABELS[config.backend], config, connected: await connectorStatus(connectorOf(config)) === STATUS.CONNECTED, adapter: adapter(config) })));
  if (!members.some(member => member.connected)) return null;
  return new MemorySet({ members, status: key => memberStatus.get(key) || {}, queue: queueStore, store: { load: key => json(key), save: (key, value) => json(key, value) } });
}

function flushQueues(set) {
  if (!flushing && Object.values(set.pending()).some(Boolean)) flushing = set.flush().catch(() => {}).finally(() => { flushing = null; });
  return flushing;
}

export async function memoryOverview(detailed = false) {
  return Promise.all(memberConfigs().map(async (config, index) => ({ ...(detailed ? { memoria: memoryKey(config), backend: config.backend } : {}), nombre: BACKEND_LABELS[config.backend], rol: index ? "copia" : "principal", conectada: await connectorStatus(connectorOf(config)) === STATUS.CONNECTED, pendientes: queueStore.load(memoryKey(config)).length })));
}

async function skillText(path) {
  if (!skillTexts.has(path)) {
    const response = await fetch(path + "?v=" + APP_VERSION);
    if (!response.ok) throw new Error("Could not load the memory skill.");
    skillTexts.set(path, await response.text());
  }
  return skillTexts.get(path);
}

export function topicSkills() {
  return TOPIC_SKILLS.map(({ id, description }) => ({ id, description }));
}

export async function topicSkill(id) {
  const entry = TOPIC_SKILLS.find(item => item.id === id);
  return entry ? { id: entry.id, description: entry.description, content: await skillText(entry.skill), pasiva: true } : null;
}

export async function passiveMemory() {
  const set = await memorySet();
  if (!set) return null;
  const paths = [...new Set(set.members.map(member => ADAPTERS[member.config.backend].skill))];
  const texts = [];
  for (const path of [...paths, SHARED_SKILL]) texts.push(await skillText(path));
  const listing = "Connected memories:\n" + set.members.map((member, index) => "- " + member.label + " · " + (index ? "copia" : "principal") + (member.connected ? "" : " · offline") + " · memoria=" + member.key).join("\n");
  const primary = set.primary.config;
  return { name: set.mirrors.length ? "Persistent memories" : ADAPTERS[primary.backend].name, instructions: texts.join("\n\n") + "\n\n" + listing, eco: primary.eco, usuario: primary.usuario };
}

export async function memoryCall(action, args) {
  const set = await memorySet();
  if (!set) throw new Error("Memory is still local. Connect a destination or renew its credentials.");
  flushQueues(set);
  if (action === "esquema") return set.schema(args?.action || "ver", args?.mapa || {}, args?.memoria);
  if (action === "reglas") return set.search(args, ["memories"]);
  if (action === "agentes") { const operation = args?.action || "listar"; return set.agents(operation, Object.fromEntries(Object.entries(args || {}).filter(([key]) => key !== "action")), operation === "actualizar" ? await presenceIdentityWithIp() : agentIdentity()); }
  if (action === "rutinas") return set.routines(args?.action || "listar", Object.fromEntries(Object.entries(args || {}).filter(([key]) => key !== "action")));
  if (action === "guardar") return set.save(args);
  if (action === "buscar") return set.search(args);
  if (action === "leer_nuevos") return set.readNew();
  throw new Error("Unsupported memory operation.");
}

export async function memoryMentions(cursor) {
  const set = await memorySet();
  if (!set) return null;
  const config = set.primary.config;
  const identity = set.primary.identity;
  let position = cursor?.identity === identity ? cursor.position : null;
  const mention = "@" + config.eco;
  const records = [];
  for (let batch = 0; batch < MAX_MENTION_BATCHES; batch += 1) {
    const result = await set.readNew(["messages", "acks"], { load: () => position, save: value => { position = value; } }, "mentionCursor");
    records.push(...result.records.filter((record) => ["message", "ack"].includes(record.type) && record.eco_author !== config.eco && (record.to === config.eco || record.to === BROADCAST || record.content.includes(mention))));
    if (!result.hay_mas) break;
  }
  return { records, cursor: { identity, position } };
}

export async function findExistingSheet(definition = ADAPTERS["google-drive"]) {
  const query = { q: "name = '" + SHEET_TITLE + "' and mimeType = '" + SHEET_MIME + "' and trashed = false", fields: "files(id,modifiedTime)", orderBy: "modifiedTime desc", pageSize: MAX_CANDIDATES };
  const listing = await connectorFetch(DRIVE_FILES_CONNECTOR.id, "GET", "/drive/v3/files", query, null, true);
  if (!listing.ok || !Array.isArray(listing.data?.files)) return "";
  let best = null;
  for (const file of listing.data.files) {
    try {
      const probe = definition.create({ config: { sheet: file.id }, request: memoryRequest(), loadCursor: () => null, saveCursor: () => {} });
      const rows = (await probe.describe()).count;
      if (!best || rows > best.rows) best = { id: file.id, rows };
    } catch {
      continue;
    }
  }
  return best?.id || "";
}

function element(tag, text = "") {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}

export async function configureMemory(input) {
  const options = typeof input === "string" ? { accion: input } : input || {};
  const action = options.accion || "conectar";
  if (action === "desconectar") {
    json(CONFIG_KEY, null);
    adapters.clear();
    presenceIdentity = "";
    presenceUpdated = 0;
    return { ok: true, estado: "Local memory; remote data and credentials are untouched." };
  }
  if (action === "listar") return { ok: true, memorias: await memoryOverview(true) };
  if (action === "principal" || action === "quitar") {
    const list = memberConfigs(), index = list.findIndex(item => memoryKey(item) === options.memoria);
    if (index < 0) return { ok: false, error: "There is no memory with that id; use accion=listar.", memorias: await memoryOverview(true) };
    const [chosen] = list.splice(index, 1);
    if (action === "principal") { list.unshift(chosen); saveMembers(list); return { ok: true, principal: options.memoria, memorias: await memoryOverview(true) }; }
    saveMembers(list);
    adapters.delete(identityOf(chosen));
    return { ok: true, quitada: options.memoria, estado: "Eco stopped using that memory; its data and credentials are untouched.", memorias: await memoryOverview(true) };
  }
  if (action !== "conectar") throw new Error("Unsupported memory action.");
  if (options.backend === "obsidian") return configureObsidian(options);
  if (options.backend && options.backend !== "google-drive") return configureDatabase(options);
  const definition = ADAPTERS["google-drive"];
  let connector = await getConnector(CONNECTOR_ID);
  if (!connector) connector = await saveConnector(definition.connector);
  await saveConnector({ ...DRIVE_FILES_CONNECTOR, createdAt: (await getConnector(DRIVE_FILES_CONNECTOR.id))?.createdAt });
  if (await connectorStatus(CONNECTOR_ID) !== STATUS.CONNECTED) {
    const status = await showCredentialCard(connector);
    if (status !== STATUS.CONNECTED) return { ok: false, estado: "Memory is still local." };
  }
  const previous = json(CONFIG_KEY) || {};
  const chat = document.getElementById("chat");
  document.getElementById("empty")?.remove();
  const card = element("div");
  card.className = "credentialCard";
  const form = element("form");
  form.append(element("strong", "Connect memory to Google Drive"), element("small", "Paste a compatible sheet or leave the field empty to use your existing Eco · Memoria or create one."));
  const inputs = {};
  for (const [name, label, initial] of [["eco", "Name of this Eco", previous.eco || "eco-" + crypto.randomUUID().slice(0, 6)], ["usuario", "Your alias", previous.usuario || "usuario"], ["sheet", "Spreadsheet (URL or ID, optional)", previous.sheet || ""]]) {
    const row = element("label", label);
    const input = element("input");
    input.name = name;
    input.value = initial;
    input.autocomplete = "off";
    input.spellcheck = false;
    row.append(input);
    inputs[name] = input;
    form.append(row);
  }
  const error = element("p");
  error.className = "credentialError";
  error.hidden = true;
  const actions = element("div");
  actions.className = "actions";
  const cancel = element("button", "Not now");
  cancel.type = "button";
  const submit = element("button", "Connect or create");
  submit.className = "primary";
  submit.type = "submit";
  actions.append(cancel, submit);
  form.append(error, actions);
  card.append(form);
  chat.append(card);
  chat.scrollTop = chat.scrollHeight;
  let pendingConfig = null;
  return new Promise((resolve) => {
    cancel.onclick = () => {
      card.replaceChildren(element("span", "No changes to memory."));
      resolve({ ok: false, cancelado: true });
    };
    form.onsubmit = async (event) => {
      event.preventDefault();
      error.hidden = true;
      submit.disabled = true;
      cancel.disabled = true;
      let config;
      let destination;
      try {
        config = { backend: "google-drive", eco: inputs.eco.value.trim(), usuario: inputs.usuario.value.trim(), sheet: sheetId(inputs.sheet.value) };
        if (!NAME_PATTERN.test(config.eco) || !NAME_PATTERN.test(config.usuario)) throw new Error("Use 1 to 40 lowercase letters, numbers or hyphens for the name and the alias.");
        if (pendingConfig?.sheet === config.sheet && pendingConfig.initialize) config.initialize = true;
        let origin = "";
        if (!config.sheet) {
          config.sheet = await findExistingSheet(definition);
          origin = config.sheet ? "reutilizada" : "creada";
        }
        const role = roleFor(config, options.rol);
        config = nameFor(config, role);
        destination = adapter(config);
        const connected = await destination.connect();
        placeMemory(config, role);
        await refreshMemoryPresence(true).catch(() => {});
        const anchor = element("a", "Open Eco · Memoria");
        anchor.href = connected.url;
        anchor.target = "_blank";
        anchor.rel = "noopener noreferrer";
        const summary = origin === "reutilizada" ? " · existing sheet" : origin === "creada" ? " · new sheet" : "";
        card.replaceChildren(element("span", "Memory connected · " + config.eco + summary), anchor);
        card.classList.add("done");
        resolve({ ok: true, eco: config.eco, rol: role, memoria: memoryKey(config), url: connected.url, hoja: origin || "indicada", estado: origin === "reutilizada" ? "Memory connected to your existing Eco · Memoria." : origin === "creada" ? "Memory connected to a new Eco · Memoria." : "Memory connected to the given sheet." });
      } catch (failure) {
        if (config?.sheet) inputs.sheet.value = config.sheet;
        pendingConfig = config;
        error.textContent = failure.message;
        error.hidden = false;
        submit.disabled = false;
        cancel.disabled = false;
      }
    };
  });
}

export async function databaseMemoryGuide() {
  return skillText(ADAPTERS.database.skill);
}

async function configureObsidian(options) {
  const previous = json(CONFIG_KEY) || {};
  const folder = String(options.folder || "Eco").trim().replace(/^\/+|\/+$/g, "");
  if (!folder || folder.length > 120 || folder.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Use a folder relative to the vault, without . or ..");
  const config = { backend: "obsidian", connector: String(options.connector || ""), folder, eco: options.eco || previous.eco || "eco-" + crypto.randomUUID().slice(0, 6), usuario: options.usuario || previous.usuario || "usuario" };
  if (!NAME_PATTERN.test(config.eco) || !NAME_PATTERN.test(config.usuario)) throw new Error("Use names of 1 to 40 lowercase letters, numbers or hyphens.");
  const connector = config.connector && await getConnector(config.connector);
  if (!connector) return { ok: false, error: "Create the vault connector first and give its id in connector.", instructions: await skillText(ADAPTERS.obsidian.skill) };
  if (connector.kind === "mcp") {
    const names = connector.tools?.map(tool => tool.name) || [];
    config.operations = Object.fromEntries(OBSIDIAN_ACTIONS.map(action => [action, String(options.operations?.[action] || "")]));
    const absent = OBSIDIAN_ACTIONS.filter(action => !names.includes(config.operations[action]));
    if (absent.length) return { ok: false, error: "Give in operations the MCP tool for: " + absent.join(", "), herramientas: names, instructions: await skillText(ADAPTERS.obsidian.skill) };
    const argumentsMap = Object.fromEntries(["path", "content"].filter(key => typeof options.arguments?.[key] === "string" && options.arguments[key]).map(key => [key, options.arguments[key]]));
    if (Object.keys(argumentsMap).length) config.arguments = argumentsMap;
    const fixed = Object.fromEntries(OBSIDIAN_ACTIONS.filter(action => options.operation_args?.[action] && typeof options.operation_args[action] === "object" && !Array.isArray(options.operation_args[action])).map(action => [action, options.operation_args[action]]));
    if (Object.keys(fixed).length) config.operation_args = fixed;
  }
  if (await connectorStatus(config.connector) !== STATUS.CONNECTED && await showCredentialCard(connector) !== STATUS.CONNECTED) return { ok: false, estado: "Memory is still local." };
  const role = roleFor(config, options.rol);
  const named = nameFor(config, role);
  try {
    const destination = adapter(named);
    await destination.connect();
    await destination.agents("actualizar", {}, agentIdentity());
  } catch (error) {
    return { ok: false, error: error.message, instructions: await skillText(ADAPTERS.obsidian.skill) };
  }
  placeMemory(named, role);
  return { ok: true, backend: config.backend, eco: named.eco, rol: role, memoria: memoryKey(named), carpeta: folder, estado: "Memory connected to the Obsidian vault." };
}

async function configureDatabase(options) {
  if (!["supabase", "database"].includes(options.backend)) throw new Error("Unsupported memory destination.");
  const previous = json(CONFIG_KEY) || {};
  const config = { backend: options.backend, connector: options.connector || (options.backend === "supabase" ? "eco-memory-supabase" : ""), eco: options.eco || previous.eco || "eco-" + crypto.randomUUID().slice(0, 6), usuario: options.usuario || previous.usuario || "usuario" };
  if (!NAME_PATTERN.test(config.eco) || !NAME_PATTERN.test(config.usuario)) throw new Error("Use names of 1 to 40 lowercase letters, numbers or hyphens.");
  let connector = await getConnector(config.connector);
  if (options.backend === "supabase" && options.project_url) {
    const url = new URL(options.project_url);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !["/", ""].includes(url.pathname)) throw new Error("Use the project's HTTPS URL, without paths or credentials.");
    if (connector && connector.base_url !== url.origin) throw new Error("Use another connector id for a different project.");
    connector = await saveConnector({ id: config.connector, name: "Memory · database", base_url: url.origin, auth: { type: "api_key", header: "apikey", bearer: true }, operations: [{ name: "leer_memoria", method: "GET", path: "/rest/v1/_eco" }] });
  }
  if (!connector) throw new Error("Connect the database first or give project_url for Supabase.");
  if (options.backend === "supabase" && (connector.kind === "mcp" || connector.auth.type !== "api_key" || connector.auth.header !== "apikey" || !connector.auth.bearer || new URL(connector.base_url).pathname !== "/")) throw new Error("Use a PostgREST connector with an apikey key for Supabase.");
  if (await connectorStatus(config.connector) !== STATUS.CONNECTED && await showCredentialCard(connector) !== STATUS.CONNECTED) return { ok: false, estado: "Memory is still local." };
  if (options.backend === "database") {
    config.mode = options.mode || "operations";
    if (!["operations", "sql"].includes(config.mode)) throw new Error("Unsupported database mode.");
    config.operation = String(options.operation || "");
    config.operations = Object.fromEntries(Object.entries(options.operations || {}).filter(([key, value]) => ["schema", "search", "new", "save", "agents", "routines", "redact"].includes(key) && typeof value === "string"));
    config.sql_argument = String(options.sql_argument || "query");
    const names = connector.kind === "mcp" ? connector.tools?.map(tool => tool.name) || [] : connector.operations.map(operation => operation.name);
    for (const action of ["schema", "search", "new", "save", "agents", "routines", "redact"]) if (!names.includes(config.operations[action] || config.operation)) throw new Error("A compatible memory operation is missing: " + action);
  }
  const role = roleFor(config, options.rol);
  const named = nameFor(config, role);
  try {
    const destination = adapter(named);
    await destination.connect();
    await destination.agents("actualizar", {}, agentIdentity());
  }
  catch (error) {
    const result = { ok: false, error: error.message, instructions: await databaseMemoryGuide() };
    if (options.backend === "supabase") {
      const response = await fetch("assets/skills/memoria-supabase.sql?v=" + APP_VERSION);
      if (response.ok) result.setup_sql = await response.text();
    }
    return result;
  }
  placeMemory(named, role);
  return { ok: true, backend: config.backend, eco: named.eco, rol: role, memoria: memoryKey(named), estado: "Memory connected to the database." };
}

let securityChecking = false;
let securityTimer;

export async function checkSecurityMemory() {
  const security = securityState();
  if (securityChecking || isWiping() || !security.enabled || security.lockedUntil > Date.now() || !navigator.onLine) return;
  securityChecking = true;
  try {
    const set = await memorySet();
    if (!set || isWiping()) return;
    for (const member of set.members.filter(item => item.connected)) {
      const cursorKey = "securityMemoryCursor:" + member.identity;
      try {
        for (let batch = 0; batch < MAX_MENTION_BATCHES && !isWiping(); batch++) {
          if (!(await member.adapter.readNew(["messages"], { load: () => json(cursorKey), save: value => json(cursorKey, value) })).hay_mas) break;
        }
      } catch {}
      if (isWiping()) return;
    }
  } catch {} finally { securityChecking = false; }
}

async function currentIp() {
  let timer;
  const limit = new Promise(resolve => { timer = setTimeout(() => resolve(""), IP_WAIT_MS); });
  try { return await Promise.race([publicIp().then(result => result.ip).catch(() => ""), limit]); }
  finally { clearTimeout(timer); }
}

async function presenceIdentityWithIp() {
  const ip = await currentIp();
  return { ...agentIdentity(), ...(ip ? { ip } : {}) };
}

export async function devicePublicIp() {
  const result = await publicIp(true).catch(() => ({ ip: "", source: "" }));
  return result.ip ? { ip: result.ip, source: result.source, contenido_no_confiable: true } : { error: "Could not get the public IP. Check the connection and try again." };
}

function agentIdentity() {
  return {
    model: setting("model") || DEFAULT_MODEL,
    version: APP_VERSION,
    peripherals: featureDefinitions().filter(entry => CAPABILITY_LABELS[entry.name] && featureValue(entry.path)).map(entry => CAPABILITY_LABELS[entry.name]).join(", ") || "No exposed peripherals"
  };
}

export async function refreshMemoryPresence(force = false) {
  const set = await memorySet();
  if (!set || isWiping()) return;
  const identity = set.members.map(member => member.identity).join("|");
  if (!force && presenceIdentity === identity && Date.now() - presenceUpdated < PRESENCE_INTERVAL_MS) return;
  if (presencePending) return presencePending;
  presencePending = presenceIdentityWithIp().then(details => set.agents("actualizar", {}, details)).then(result => {
    presenceIdentity = identity;
    presenceUpdated = Date.now();
    return result;
  }).finally(() => { presencePending = null; });
  return presencePending;
}

async function memoryHealth() {
  if (!memoryConfigured() || !memberConfigs().length) return null;
  if (!navigator.onLine) return true;
  const set = await memorySet();
  if (!set) return true;
  flushQueues(set);
  if (!set.mirrors.length) return false;
  for (const member of set.members) if (!member.connected) memberStatus.set(member.key, { ...memberStatus.get(member.key), last: false });
  const now = performance.now();
  const probe = set.members.filter(member => member.connected && (memberStatus.get(member.key)?.last !== true || now - Math.max(memberStatus.get(member.key)?.ok ?? 0, memberStatus.get(member.key)?.fail ?? 0) > PROBE_STALE_MS));
  await Promise.all(probe.map(member => member.adapter.agents("listar").catch(() => {})));
  if (set.members.every(member => memberStatus.get(member.key)?.last !== true)) reportMemoryConnection(false);
  return false;
}

export function startSecurityMemory() {
  setMemoryHealth(memoryHealth);
  clearInterval(securityTimer);
  clearInterval(presenceTimer);
  presenceTimer = setInterval(() => refreshMemoryPresence().catch(() => {}), PRESENCE_INTERVAL_MS);
  refreshMemoryPresence().catch(() => {});
  securityTimer = setInterval(checkSecurityMemory, 15000);
  for (const event of ["online", "focus", "eco-credentials-changed", "eco-security-changed"]) window.addEventListener(event, checkSecurityMemory);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") checkSecurityMemory(); });
  checkSecurityMemory();
}

export function stopSecurityMemory() { clearInterval(securityTimer); clearInterval(presenceTimer); presenceUpdated = 0; presenceIdentity = ""; adapters.clear(); memberStatus.clear(); skillTexts.clear(); }
