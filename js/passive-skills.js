import { featureDefinitions, featureValue } from "./environment.js";
import { isWiping, securityState } from "./security.js";
import { APP_VERSION, DEFAULT_MODEL } from "./config.js";
import { json, setting } from "./storage.js";
import { connectorFetch, connectorStatus, getConnector, saveConnector, STATUS } from "./connectors.js";
import { showCredentialCard } from "./credentials.js";
import { sheetId } from "./memory-drive.js";
import { MEMORY_BACKENDS, memoryDependencies } from "./memory-backends.js";

const PRESENCE_INTERVAL_MS = 180000;
const CAPABILITY_LABELS = { mediaDevices: "cámara y micrófono", geolocation: "ubicación", bluetooth: "Bluetooth", usb: "USB", serial: "serial", hid: "HID", nfc: "NFC", clipboard: "portapapeles" };
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
    name: "Memoria persistente Google Drive",
    skill: "assets/skills/memoria-google-drive.txt",
    create: MEMORY_BACKENDS["google-drive"].create,
    connector: {
      id: CONNECTOR_ID,
      name: "Memoria persistente Google Drive",
      base_url: "https://sheets.googleapis.com",
      auth: { type: "oauth2", flow: "implicit", renewal: "silent", authorize_url: "https://accounts.google.com/o/oauth2/v2/auth", scopes: ["https://www.googleapis.com/auth/spreadsheets", "https://www.googleapis.com/auth/drive"] },
      operations: [{ name: "leer", method: "GET", path: "/v4/spreadsheets/{id}", write: false }]
    }
  }
});
const DRIVE_FILES_CONNECTOR = Object.freeze({
  id: "google-drive-archivos",
  name: "Google Drive · archivos",
  base_url: "https://www.googleapis.com",
  auth: { type: "oauth2", flow: "implicit", renewal: "silent", secret_of: CONNECTOR_ID, authorize_url: "https://accounts.google.com/o/oauth2/v2/auth", scopes: ["https://www.googleapis.com/auth/spreadsheets", "https://www.googleapis.com/auth/drive"] },
  operations: [
    { name: "buscar_archivos", description: "Lista o busca archivos y carpetas de Drive. q usa la sintaxis de búsqueda de Drive, por ejemplo name contains 'informe' and trashed = false.", method: "GET", path: "/drive/v3/files", params: { q: { type: "string", in: "query" }, pageSize: { type: "integer", in: "query" }, pageToken: { type: "string", in: "query" }, orderBy: { type: "string", in: "query" }, fields: { type: "string", in: "query", description: "Por defecto nextPageToken, files(id,name,mimeType,modifiedTime,parents,webViewLink)." } } },
    { name: "ver_archivo", description: "Metadatos de un archivo.", method: "GET", path: "/drive/v3/files/{fileId}", params: { fileId: { type: "string", in: "path", required: true }, fields: { type: "string", in: "query" } } },
    { name: "descargar_archivo", description: "Contenido de un archivo que no es de Google (texto, JSON, CSV...). Usa alt=media.", method: "GET", path: "/drive/v3/files/{fileId}", params: { fileId: { type: "string", in: "path", required: true }, alt: { type: "string", in: "query", required: true, description: "Siempre media." } } },
    { name: "exportar_archivo", description: "Exporta un Doc, Hoja o Presentación de Google a texto. mimeType: text/plain para Docs, text/csv para Hojas, text/plain para Presentaciones.", method: "GET", path: "/drive/v3/files/{fileId}/export", params: { fileId: { type: "string", in: "path", required: true }, mimeType: { type: "string", in: "query", required: true } } },
    { name: "crear_archivo", description: "Crea un archivo o carpeta vacíos (carpeta: mimeType application/vnd.google-apps.folder; Doc: application/vnd.google-apps.document).", method: "POST", path: "/drive/v3/files", params: { name: { type: "string", in: "body", required: true }, mimeType: { type: "string", in: "body" }, parents: { type: "array", in: "body" } } },
    { name: "actualizar_archivo", description: "Renombra, mueve a la papelera (trashed true) o cambia la descripción. Para mover usa addParents y removeParents.", method: "PATCH", path: "/drive/v3/files/{fileId}", params: { fileId: { type: "string", in: "path", required: true }, name: { type: "string", in: "body" }, trashed: { type: "boolean", in: "body" }, description: { type: "string", in: "body" }, addParents: { type: "string", in: "query" }, removeParents: { type: "string", in: "query" } } }
  ]
});
const skillTexts = new Map();
let activeAdapter = null;
let activeIdentity = "";
let presenceTimer;
let presencePending = null;
let presenceIdentity = "";
let presenceUpdated = 0;

function identityOf(config) {
  if (config.backend === "google-drive") return [config.backend, config.sheet, config.eco, config.usuario].join(":");
  return [config.backend, config.connector, config.operation, config.mode, config.sql_argument, JSON.stringify(config.operations), config.eco, config.usuario].join(":");
}

function memoryRequest() {
  return memoryDependencies({ backend: "google-drive" }).request;
}

function adapter(config) {
  const definition = ADAPTERS[config.backend];
  if (!definition) throw new Error("Destino de memoria no compatible.");
  const identity = identityOf(config);
  if (activeIdentity !== identity) {
    const cursorKey = "memoryCursor:" + identity;
    activeAdapter = definition.create({ config, ...memoryDependencies(config), loadCursor: () => json(cursorKey), saveCursor: (cursor) => json(cursorKey, cursor) });
    activeIdentity = identity;
  }
  return activeAdapter;
}

export async function passiveMemory() {
  const config = await connectedConfig();
  if (!config) return null;
  if (!skillTexts.has(config.backend)) {
    const response = await fetch(ADAPTERS[config.backend].skill + "?v=" + APP_VERSION);
    if (!response.ok) throw new Error("No se pudo cargar la habilidad de memoria.");
    skillTexts.set(config.backend, await response.text());
  }
  return { name: ADAPTERS[config.backend].name, instructions: skillTexts.get(config.backend), eco: config.eco, usuario: config.usuario };
}

export async function memoryCall(action, args) {
  const config = await connectedConfig();
  if (!config) throw new Error("La memoria sigue local. Conecta un destino o renueva sus credenciales.");
  const destination = adapter(config);
  await destination.ensure();
  if (action === "reglas") return destination.search(args, ["memories"]);
  if (action === "agentes") return destination.agents(args?.accion || "listar", Object.fromEntries(Object.entries(args || {}).filter(([key]) => key !== "accion")), agentIdentity());
  if (action === "rutinas") return destination.routines(args?.accion || "listar", Object.fromEntries(Object.entries(args || {}).filter(([key]) => key !== "accion")));
  if (action === "guardar") return destination.save(args);
  if (action === "buscar") return destination.search(args);
  if (action === "leer_nuevos") return destination.readNew();
  throw new Error("Operación de memoria no compatible.");
}

async function connectedConfig() {
  const config = json(CONFIG_KEY);
  if (!config || !ADAPTERS[config.backend] || !(config.backend === "google-drive" ? config.sheet : config.connector) || await connectorStatus(config.backend === "google-drive" ? CONNECTOR_ID : config.connector) !== STATUS.CONNECTED) return null;
  return config;
}

export async function memoryMentions(cursor) {
  const config = await connectedConfig();
  if (!config) return null;
  const identity = identityOf(config);
  let position = cursor?.identity === identity ? cursor.position : null;
  const reader = adapter(config);
  const mention = "@" + config.eco;
  const records = [];
  for (let batch = 0; batch < MAX_MENTION_BATCHES; batch += 1) {
    const result = await reader.readNew(["messages"], { load: () => position, save: value => { position = value; } });
    records.push(...result.records.filter((record) => record.tipo === "mensaje" && record.eco_autor !== config.eco && (record.para === config.eco || record.para === BROADCAST || record.contenido.includes(mention))));
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
    activeAdapter = null;
    activeIdentity = "";
    presenceIdentity = "";
    presenceUpdated = 0;
    return { ok: true, estado: "Memoria local; los datos remotos y las credenciales siguen intactos." };
  }
  if (options.backend && options.backend !== "google-drive") return configureDatabase(options);
  const definition = ADAPTERS["google-drive"];
  let connector = await getConnector(CONNECTOR_ID);
  if (!connector) connector = await saveConnector(definition.connector);
  await saveConnector({ ...DRIVE_FILES_CONNECTOR, createdAt: (await getConnector(DRIVE_FILES_CONNECTOR.id))?.createdAt });
  if (await connectorStatus(CONNECTOR_ID) !== STATUS.CONNECTED) {
    const status = await showCredentialCard(connector);
    if (status !== STATUS.CONNECTED) return { ok: false, estado: "La memoria sigue local." };
  }
  const previous = json(CONFIG_KEY) || {};
  const chat = document.getElementById("chat");
  document.getElementById("empty")?.remove();
  const card = element("div");
  card.className = "credentialCard";
  const form = element("form");
  form.append(element("strong", "Conectar memoria a Google Drive"), element("small", "Pega una hoja compatible o deja el campo vacío para usar tu Eco · Memoria existente o crear una."));
  const inputs = {};
  for (const [name, label, initial] of [["eco", "Nombre de este Eco", previous.eco || "eco-" + crypto.randomUUID().slice(0, 6)], ["usuario", "Tu alias", previous.usuario || "usuario"], ["sheet", "Hoja de cálculo (URL o ID, opcional)", previous.sheet || ""]]) {
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
  const cancel = element("button", "Ahora no");
  cancel.type = "button";
  const submit = element("button", "Conectar o crear");
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
      card.replaceChildren(element("span", "Sin cambios en la memoria."));
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
        if (!NAME_PATTERN.test(config.eco) || !NAME_PATTERN.test(config.usuario)) throw new Error("Usa de 1 a 40 letras minúsculas, números o guiones para el nombre y el alias.");
        if (pendingConfig?.sheet === config.sheet && pendingConfig.initialize) config.initialize = true;
        let origin = "";
        if (!config.sheet) {
          config.sheet = await findExistingSheet(definition);
          origin = config.sheet ? "reutilizada" : "creada";
        }
        destination = adapter(config);
        const connected = await destination.connect();
        json(CONFIG_KEY, config);
        await refreshMemoryPresence(true);
        const anchor = element("a", "Abrir Eco · Memoria");
        anchor.href = connected.url;
        anchor.target = "_blank";
        anchor.rel = "noopener noreferrer";
        const summary = origin === "reutilizada" ? " · hoja existente" : origin === "creada" ? " · hoja nueva" : "";
        card.replaceChildren(element("span", "Memoria conectada · " + config.eco + summary), anchor);
        card.classList.add("done");
        resolve({ ok: true, eco: config.eco, url: connected.url, hoja: origin || "indicada", estado: origin === "reutilizada" ? "Memoria conectada a tu Eco · Memoria existente." : origin === "creada" ? "Memoria conectada a una Eco · Memoria nueva." : "Memoria conectada a la hoja indicada." });
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
  if (!skillTexts.has("database")) {
    const response = await fetch(ADAPTERS.database.skill + "?v=" + APP_VERSION);
    if (!response.ok) throw new Error("No se pudo cargar la habilidad de bases de datos.");
    skillTexts.set("database", await response.text());
  }
  return skillTexts.get("database");
}

async function configureDatabase(options) {
  if (!["supabase", "database"].includes(options.backend)) throw new Error("Destino de memoria no compatible.");
  const previous = json(CONFIG_KEY) || {};
  const config = { backend: options.backend, connector: options.connector || (options.backend === "supabase" ? "eco-memory-supabase" : ""), eco: options.eco || previous.eco || "eco-" + crypto.randomUUID().slice(0, 6), usuario: options.usuario || previous.usuario || "usuario" };
  if (!NAME_PATTERN.test(config.eco) || !NAME_PATTERN.test(config.usuario)) throw new Error("Usa nombres de 1 a 40 letras minúsculas, números o guiones.");
  let connector = await getConnector(config.connector);
  if (options.backend === "supabase" && options.project_url) {
    const url = new URL(options.project_url);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !["/", ""].includes(url.pathname)) throw new Error("Usa la URL HTTPS del proyecto, sin rutas ni credenciales.");
    if (connector && connector.base_url !== url.origin) throw new Error("Usa otro id de conector para un proyecto distinto.");
    connector = await saveConnector({ id: config.connector, name: "Memoria · base de datos", base_url: url.origin, auth: { type: "api_key", header: "apikey", bearer: true }, operations: [{ name: "leer_memoria", method: "GET", path: "/rest/v1/_eco" }] });
  }
  if (!connector) throw new Error("Conecta la base de datos primero o indica project_url para Supabase.");
  if (options.backend === "supabase" && (connector.kind === "mcp" || connector.auth.type !== "api_key" || connector.auth.header !== "apikey" || !connector.auth.bearer || new URL(connector.base_url).pathname !== "/")) throw new Error("Usa un conector PostgREST con clave apikey para Supabase.");
  if (await connectorStatus(config.connector) !== STATUS.CONNECTED && await showCredentialCard(connector) !== STATUS.CONNECTED) return { ok: false, estado: "La memoria sigue local." };
  if (options.backend === "database") {
    config.mode = options.mode || "operations";
    if (!["operations", "sql"].includes(config.mode)) throw new Error("Modo de base de datos no compatible.");
    config.operation = String(options.operation || "");
    config.operations = Object.fromEntries(Object.entries(options.operations || {}).filter(([key, value]) => ["schema", "search", "new", "save", "agents", "routines", "redact"].includes(key) && typeof value === "string"));
    config.sql_argument = String(options.sql_argument || "query");
    const names = connector.kind === "mcp" ? connector.tools?.map(tool => tool.name) || [] : connector.operations.map(operation => operation.name);
    for (const action of ["schema", "search", "new", "save", "agents", "routines", "redact"]) if (!names.includes(config.operations[action] || config.operation)) throw new Error("Falta una operación de memoria compatible: " + action);
  }
  try {
    const destination = adapter(config);
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
  json(CONFIG_KEY, config);
  presenceIdentity = identityOf(config);
  presenceUpdated = Date.now();
  return { ok: true, backend: config.backend, eco: config.eco, estado: "Memoria conectada a la base de datos." };
}

let securityChecking = false;
let securityTimer;

export async function checkSecurityMemory() {
  const security = securityState();
  if (securityChecking || isWiping() || !security.enabled || security.lockedUntil > Date.now() || !navigator.onLine) return;
  securityChecking = true;
  try {
    const config = await connectedConfig();
    if (!config || isWiping()) return;
    const cursorKey = "securityMemoryCursor:" + identityOf(config);
    const reader = adapter(config);
    for (let batch = 0; batch < MAX_MENTION_BATCHES && !isWiping(); batch++) {
      if (!(await reader.readNew(["messages"], { load: () => json(cursorKey), save: value => json(cursorKey, value) })).hay_mas) break;
    }
  } catch {} finally { securityChecking = false; }
}

function agentIdentity() {
  return {
    modelo: setting("model") || DEFAULT_MODEL,
    version: APP_VERSION,
    perifericos: featureDefinitions().filter(entry => CAPABILITY_LABELS[entry.name] && featureValue(entry.path)).map(entry => CAPABILITY_LABELS[entry.name]).join(", ") || "Sin periféricos expuestos"
  };
}

export async function refreshMemoryPresence(force = false) {
  const config = await connectedConfig();
  if (!config || isWiping()) return;
  const identity = identityOf(config);
  if (!force && presenceIdentity === identity && Date.now() - presenceUpdated < PRESENCE_INTERVAL_MS) return;
  if (presencePending) return presencePending;
  presencePending = adapter(config).agents("actualizar", {}, agentIdentity()).then(result => {
    presenceIdentity = identity;
    presenceUpdated = Date.now();
    return result;
  }).finally(() => { presencePending = null; });
  return presencePending;
}

export function startSecurityMemory() {
  clearInterval(securityTimer);
  clearInterval(presenceTimer);
  presenceTimer = setInterval(() => refreshMemoryPresence().catch(() => {}), PRESENCE_INTERVAL_MS);
  refreshMemoryPresence().catch(() => {});
  securityTimer = setInterval(checkSecurityMemory, 15000);
  for (const event of ["online", "focus", "eco-credentials-changed", "eco-security-changed"]) window.addEventListener(event, checkSecurityMemory);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") checkSecurityMemory(); });
  checkSecurityMemory();
}

export function stopSecurityMemory() { clearInterval(securityTimer); clearInterval(presenceTimer); presenceUpdated = 0; presenceIdentity = ""; activeAdapter = null; activeIdentity = ""; skillTexts.clear(); }
