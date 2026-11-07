import { configureSecurity, eraseWithWord, isWiping, securityState } from "./security.js";
import { DEFAULT_MODEL } from "./config.js";
import { setting } from "./storage.js";
import { byId } from "./ui.js";
import { connectorStatus, deleteConnector, getConnector, listConnectors, openOAuthWindow, startOAuth } from "./connectors.js";
import { deleteSecret } from "./vault.js";
import { showCredentialCard } from "./credentials.js";
import { listRoutines, manageRoutine, onRoutinesChange } from "./routines.js";

const TEXT_SETTINGS = ["openrouterKey", "model"];
const EMPTY_ROUTINES = "Pídele a Eco que revise algo cada cierto tiempo y aparecerá aquí.";
const SECONDS_PER_MINUTE = 60;
const EMPTY_CONNECTORS = "Pídele a Eco que se conecte a un servicio y aparecerá aquí.";

export function bindSettings() {
  for (const id of TEXT_SETTINGS) {
    const field = byId(id);
    field.value = setting(id) || (id === "model" ? DEFAULT_MODEL : "");
    field.oninput = () => {
      setting(id, field.value);
      updateNotice();
    };
  }
  byId("settingsButton").onclick = async () => {
    await Promise.all([renderConnectors(), renderRoutines()]);
    renderSecurity();
    byId("settings").showModal();
  };
  onRoutinesChange(() => renderRoutines());
  document.querySelectorAll("[data-open-settings]").forEach((button) => {
    button.onclick = () => byId("settings").showModal();
  });
  bindSecurity();
  updateNotice();
}

function button(text, className, onclick) {
  const item = document.createElement("button");
  item.type = "button";
  item.textContent = text;
  if (className) {
    item.className = className;
  }
  item.onclick = onclick;
  return item;
}

export async function renderConnectors() {
  const list = byId("connectorList");
  const rows = await listConnectors();
  if (!rows.length) {
    const empty = document.createElement("small");
    empty.textContent = EMPTY_CONNECTORS;
    list.replaceChildren(empty);
    return;
  }
  const items = [];
  for (const connector of rows) {
    const status = await connectorStatus(connector.id);
    const row = document.createElement("div");
    row.className = "connectorRow";
    const info = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = connector.name;
    const detail = document.createElement("small");
    const toolCount = connector.kind === "mcp" && status === "conectado" ? " · " + (connector.tools || []).length + " herramientas" : "";
    detail.textContent = status.charAt(0).toUpperCase() + status.slice(1) + toolCount + " · " + new URL(connector.base_url).host;
    info.append(name, detail);
    const actions = document.createElement("div");
    actions.className = "connectorActions";
    if (connector.auth.type !== "none") {
      if (status === "conectado") {
        actions.append(button("Quitar acceso", "", async () => {
          if (window.confirm("¿Borrar la credencial de " + connector.name + "?")) {
            await deleteSecret(connector.id);
            await renderConnectors();
          }
        }));
      } else {
        actions.append(button("Conectar", "", async () => {
          byId("settings").close();
          const owner = rows.find((item) => item.id === connector.auth.secret_of) || connector;
          if (owner.auth.type === "oauth2" && owner.auth.client_id) {
            const popup = openOAuthWindow();
            try {
              if (!await startOAuth(owner.id, owner.auth.client_id, popup)) await showCredentialCard(owner, { expired: true });
            } catch { await showCredentialCard(owner, { expired: true }); }
          } else {
            const fresh = await getConnector(owner.id);
            await showCredentialCard(fresh);
          }
        }));
      }
    }
    actions.append(button("Eliminar", "danger", async () => {
      if (window.confirm("¿Eliminar el conector " + connector.name + "?")) {
        await deleteConnector(connector.id);
        await renderConnectors();
      }
    }));
    row.append(info, actions);
    items.push(row);
  }
  list.replaceChildren(...items);
}

export async function renderRoutines() {
  const list = byId("routineList");
  const rows = await listRoutines();
  if (!rows.length) {
    const empty = document.createElement("small");
    empty.textContent = EMPTY_ROUTINES;
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(...rows.map((routine) => {
    const row = document.createElement("div");
    row.className = "connectorRow";
    const info = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = routine.nombre;
    const detail = document.createElement("small");
    const minutes = routine.cada_segundos / SECONDS_PER_MINUTE;
    detail.textContent = (routine.activa ? "Activa" : "En pausa") + " · cada " + (Number.isInteger(minutes) ? minutes + " min" : routine.cada_segundos + " s");
    info.append(name, detail);
    const actions = document.createElement("div");
    actions.className = "connectorActions";
    actions.append(button(routine.activa ? "Pausar" : "Reanudar", "", () => manageRoutine(routine.id, routine.activa ? "pausar" : "reanudar")));
    actions.append(button("Eliminar", "danger", () => {
      if (window.confirm("¿Eliminar la rutina " + routine.nombre + "?")) manageRoutine(routine.id, "borrar");
    }));
    row.append(info, actions);
    return row;
  }));
}

export function updateNotice() {
  byId("notice").hidden = Boolean(setting("openrouterKey"));
}

function renderSecurity() {
  const state = securityState();
  byId("securityCurrentLabel").hidden = !state.enabled;
  byId("securitySave").textContent = state.enabled ? "Cambiar palabra" : "Guardar palabra";
  byId("securityStatus").textContent = state.enabled ? "Protección activada. El borrado solo afecta a Eco en este dispositivo." : "Configura una palabra de 8 a 128 caracteres para habilitar el borrado.";
}

function bindSecurity() {
  renderSecurity();
  byId("securityForm").onsubmit = async event => {
    event.preventDefault();
    const current = byId("securityCurrent").value;
    const word = byId("securityNew").value;
    const repeat = byId("securityRepeat").value;
    for (const id of ["securityCurrent", "securityNew", "securityRepeat"]) byId(id).value = "";
    byId("securitySave").disabled = true;
    try {
      const ok = word.normalize("NFC").trim() === repeat.normalize("NFC").trim() && await configureSecurity(word, current);
      renderSecurity();
      if (!ok) byId("securityStatus").textContent = "No se pudo guardar. Comprueba las palabras o espera antes de intentarlo otra vez.";
    } catch { byId("securityStatus").textContent = "No se pudo guardar la protección en este navegador."; }
    finally { byId("securitySave").disabled = false; }
  };
  byId("clearData").onclick = () => {
    if (!securityState().enabled) { renderSecurity(); byId("securityNew").focus(); return; }
    byId("wipeWord").value = "";
    byId("wipeConfirm").checked = false;
    byId("wipeStatus").textContent = "";
    byId("settings").close();
    byId("wipeDialog").showModal();
  };
  byId("wipeForm").onsubmit = async event => {
    event.preventDefault();
    const word = byId("wipeWord").value;
    byId("wipeWord").value = "";
    byId("wipeSubmit").disabled = true;
    try {
      if (!await eraseWithWord(word, byId("wipeConfirm").checked)) byId("wipeStatus").textContent = "No se pudo verificar la solicitud.";
    } catch { byId("wipeStatus").textContent = "No se pudo verificar la solicitud."; }
    finally { byId("wipeSubmit").disabled = false; }
  };
  byId("wipeDialog").addEventListener("close", () => { byId("wipeWord").value = ""; byId("wipeConfirm").checked = false; if (!isWiping()) byId("settings").showModal(); });
  byId("settings").addEventListener("close", () => {
    for (const id of ["securityCurrent", "securityNew", "securityRepeat"]) byId(id).value = "";
  });
}
