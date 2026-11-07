import { APP_VERSION } from "./config.js";
import { json } from "./storage.js";
import { connectorFetch, connectorStatus, getConnector, saveConnector, STATUS } from "./connectors.js";
import { showCredentialCard } from "./credentials.js";
import { DriveMemory, sheetId, validateProtocol } from "./memory-drive.js";

const CONFIG_KEY = "persistentMemory";
const CONNECTOR_ID = "eco-memory-drive";
const SHEET_TITLE = "Eco · Memoria";
const SHEET_MIME = "application/vnd.google-apps.spreadsheet";
const MAX_CANDIDATES = 10;
const MAX_MENTION_BATCHES = 5;
const BROADCAST = "*";
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ADAPTERS = Object.freeze({
  "google-drive": {
    name: "Memoria persistente Google Drive",
    skill: "assets/skills/memoria-google-drive.txt",
    create: (dependencies) => new DriveMemory(dependencies),
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

function identityOf(config) {
  return [config.backend, config.sheet, config.eco, config.usuario].join(":");
}

function memoryRequest(definition) {
  return (method, path, query, body) => connectorFetch(definition.connector.id, method, path, query, body, true);
}

function adapter(config) {
  const definition = ADAPTERS[config.backend];
  if (!definition) throw new Error("Destino de memoria no compatible.");
  const identity = identityOf(config);
  if (activeIdentity !== identity) {
    const cursorKey = "memoryCursor:" + identity;
    activeAdapter = definition.create({ config, request: memoryRequest(definition), loadCursor: () => json(cursorKey), saveCursor: (cursor) => json(cursorKey, cursor) });
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
  const config = json(CONFIG_KEY);
  if (!config?.sheet || !ADAPTERS[config.backend] || await connectorStatus(ADAPTERS[config.backend].connector.id) !== STATUS.CONNECTED) throw new Error("La memoria sigue local. Conecta Google Drive o inicia sesión de nuevo.");
  const destination = adapter(config);
  if (action === "guardar") return destination.save(args);
  if (action === "buscar") return destination.search(args);
  if (action === "leer_nuevos") return destination.readNew();
  throw new Error("Operación de memoria no compatible.");
}

async function connectedConfig() {
  const config = json(CONFIG_KEY);
  if (!config?.sheet || !ADAPTERS[config.backend] || await connectorStatus(ADAPTERS[config.backend].connector.id) !== STATUS.CONNECTED) return null;
  return config;
}

export async function memoryMentions(cursor) {
  const config = await connectedConfig();
  if (!config) return null;
  const identity = identityOf(config);
  let position = cursor?.identity === identity ? cursor.position : json("memoryCursor:" + identity);
  const reader = ADAPTERS[config.backend].create({ config, request: memoryRequest(ADAPTERS[config.backend]), loadCursor: () => position, saveCursor: (value) => { position = value; } });
  const mention = "@" + config.eco;
  const records = [];
  for (let batch = 0; batch < MAX_MENTION_BATCHES; batch += 1) {
    const result = await reader.readNew();
    records.push(...result.records.filter((record) => record.eco_autor !== config.eco && (record.para === config.eco || record.para === BROADCAST || record.contenido.includes(mention))));
    if (!result.hay_mas) break;
  }
  return { records, cursor: { identity, position } };
}

async function findExistingSheet(definition) {
  const query = { q: "name = '" + SHEET_TITLE + "' and mimeType = '" + SHEET_MIME + "' and trashed = false", fields: "files(id,modifiedTime)", orderBy: "modifiedTime desc", pageSize: MAX_CANDIDATES };
  const listing = await connectorFetch(DRIVE_FILES_CONNECTOR.id, "GET", "/drive/v3/files", query, null, true);
  if (!listing.ok || !Array.isArray(listing.data?.files)) return "";
  let best = null;
  for (const file of listing.data.files) {
    try {
      const probe = definition.create({ config: { sheet: file.id }, request: memoryRequest(definition), loadCursor: () => null, saveCursor: () => {} });
      validateProtocol(await probe.values("'_eco'!A1:B30"), (await probe.values("'records'!A1:K1"))[0]);
      const rows = (await probe.values("'records'!A:A")).length;
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

export async function configureMemory(action) {
  if (action === "desconectar") {
    json(CONFIG_KEY, null);
    activeAdapter = null;
    activeIdentity = "";
    return { ok: true, estado: "Memoria local; la hoja no se borró y el acceso de Google sigue guardado en Conectores." };
  }
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
