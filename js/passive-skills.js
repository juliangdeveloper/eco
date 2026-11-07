import { APP_VERSION } from "./config.js";
import { json } from "./storage.js";
import { connectorFetch, connectorStatus, getConnector, saveConnector, STATUS } from "./connectors.js";
import { showCredentialCard } from "./credentials.js";
import { DriveMemory, sheetId } from "./memory-drive.js";

const CONFIG_KEY = "persistentMemory";
const CONNECTOR_ID = "eco-memory-drive";
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
const skillTexts = new Map();
let activeAdapter = null;
let activeIdentity = "";

function adapter(config) {
  const definition = ADAPTERS[config.backend];
  if (!definition) throw new Error("Destino de memoria no compatible.");
  const identity = [config.backend, config.sheet, config.eco, config.usuario].join(":");
  if (activeIdentity !== identity) {
    const cursorKey = "memoryCursor:" + identity;
    activeAdapter = definition.create({ config, request: (method, path, query, body) => connectorFetch(definition.connector.id, method, path, query, body, true), loadCursor: () => json(cursorKey), saveCursor: (cursor) => json(cursorKey, cursor) });
    activeIdentity = identity;
  }
  return activeAdapter;
}

export async function passiveMemory() {
  const config = json(CONFIG_KEY);
  if (!config?.sheet || !ADAPTERS[config.backend] || await connectorStatus(ADAPTERS[config.backend].connector.id) !== STATUS.CONNECTED) return null;
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
  form.append(element("strong", "Conectar memoria a Google Drive"), element("small", "Pega una hoja compatible o deja el campo vacío para crear Eco · Memoria. Solo se comparte lo que apruebes guardar."));
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
        destination = adapter(config);
        const connected = await destination.connect();
        json(CONFIG_KEY, config);
        const anchor = element("a", "Abrir Eco · Memoria");
        anchor.href = connected.url;
        anchor.target = "_blank";
        anchor.rel = "noopener noreferrer";
        card.replaceChildren(element("span", "Memoria conectada · " + config.eco), anchor);
        card.classList.add("done");
        resolve({ ok: true, eco: config.eco, url: connected.url, estado: "Memoria conectada. Ya puedes usar las herramientas de memoria." });
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
