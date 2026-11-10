import { bindStepLimits } from "./step-limits.js";
import { applyWipeLimits, configureSecurity, eraseWithWord, isWiping, securityState, WIPE_LIMITS, wipeLimits } from "./security.js";
import { DEFAULT_MODEL } from "./config.js";
import { setting } from "./storage.js";
import { byId } from "./ui.js";
import { connectorStatus, deleteConnector, getConnector, listConnectors, openOAuthWindow, startOAuth } from "./connectors.js";
import { deleteSecret } from "./vault.js";
import { showCredentialCard } from "./credentials.js";
import { listRoutines, manageRoutine, onRoutinesChange } from "./routines.js";
import { memoryOverview } from "./passive-skills.js";
import { ecoName, NAME_MAX, NAME_MIN, setEcoName } from "./identity.js";

const TEXT_SETTINGS = ["openrouterKey", "model"];
const EMPTY_ROUTINES = "Ask Eco to check something every so often and it will show up here.";
const SECONDS_PER_MINUTE = 60;
const EMPTY_CONNECTORS = "Ask Eco to connect to a service and it will show up here.";

export function bindSettings() {
  bindStepLimits(byId);
  bindName();
  for (const id of TEXT_SETTINGS) {
    const field = byId(id);
    field.value = setting(id) || (id === "model" ? DEFAULT_MODEL : "");
    field.oninput = () => {
      setting(id, field.value);
      updateNotice();
    };
  }
  byId("settingsButton").onclick = async () => {
    byId("ecoName").value = ecoName();
    await Promise.all([renderConnectors(), renderRoutines(), renderMemories()]);
    renderSecurity();
    renderWipeLimits();
    byId("settings").showModal();
  };
  onRoutinesChange(() => renderRoutines());
  document.querySelectorAll("[data-open-settings]").forEach((button) => {
    button.onclick = () => byId("settings").showModal();
  });
  bindSecurity();
  updateNotice();
}

const NAME_HINT = "Wake word, title and name in shared memory.";

function bindName() {
  const field = byId("ecoName"), hint = byId("ecoNameHint");
  field.value = ecoName();
  field.oninput = () => {
    const ok = setEcoName(field.value);
    field.setAttribute("aria-invalid", String(!ok));
    hint.textContent = ok ? NAME_HINT : "Use " + NAME_MIN + " to " + NAME_MAX + " letters, numbers, spaces or hyphens.";
  };
  field.onchange = () => {
    field.value = ecoName();
    field.removeAttribute("aria-invalid");
    hint.textContent = NAME_HINT;
  };
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
    const toolCount = connector.kind === "mcp" && status === "connected" ? " · " + (connector.tools || []).length + " tools" : "";
    detail.textContent = status.charAt(0).toUpperCase() + status.slice(1) + toolCount + " · " + new URL(connector.base_url).host;
    info.append(name, detail);
    const actions = document.createElement("div");
    actions.className = "connectorActions";
    if (connector.auth.type !== "none") {
      if (status === "connected") {
        actions.append(button("Remove access", "", async () => {
          await deleteSecret(connector.id);
          await renderConnectors();
        }));
      } else {
        actions.append(button("Connect", "", async () => {
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
    actions.append(button("Delete", "danger", async () => {
      await deleteConnector(connector.id);
      await renderConnectors();
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
    detail.textContent = (routine.activa ? "Active" : "Paused") + " · every " + (Number.isInteger(minutes) ? minutes + " min" : routine.cada_segundos + " s");
    info.append(name, detail);
    const actions = document.createElement("div");
    actions.className = "connectorActions";
    actions.append(button(routine.activa ? "Pause" : "Resume", "", () => manageRoutine(routine.id, routine.activa ? "pausar" : "reanudar")));
    actions.append(button("Delete", "danger", () => {
      manageRoutine(routine.id, "borrar");
    }));
    row.append(info, actions);
    return row;
  }));
}

export async function renderMemories() {
  const rows = await memoryOverview().catch(() => []);
  byId("memoryTitle").hidden = byId("memoryList").hidden = !rows.length;
  byId("memoryList").replaceChildren(...rows.map((memory) => {
    const row = document.createElement("div");
    row.className = "connectorRow";
    const info = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = memory.nombre;
    const detail = document.createElement("small");
    detail.textContent = [memory.rol === "principal" ? "Primary" : "Mirror", memory.conectada ? "" : "Offline", memory.pendientes ? memory.pendientes + " to copy" : ""].filter(Boolean).join(" · ");
    info.append(name, detail);
    row.append(info);
    return row;
  }));
}

export function updateNotice() {
  byId("notice").hidden = Boolean(setting("openrouterKey"));
}

function renderSecurity() {
  const state = securityState();
  byId("securityCurrentLabel").hidden = !state.enabled;
  byId("securitySave").textContent = state.enabled ? "Change word" : "Save word";
  byId("securityStatus").textContent = state.enabled ? "Protection on. The wipe only affects Eco on this device." : "Set a word of 8 to 128 characters to enable the wipe.";
}

function renderWipeLimits() {
  const limits = wipeLimits();
  for (const [name, bounds] of Object.entries(WIPE_LIMITS)) {
    const field = byId(name);
    field.min = bounds.min;
    field.max = name === "wipeWarningDays" ? Math.min(bounds.max, limits.wipeOfflineDays - bounds.step) : bounds.max;
    field.step = bounds.step;
    if (document.activeElement !== field) field.value = limits[name];
  }
}

function bindWipeLimits() {
  renderWipeLimits();
  for (const name of Object.keys(WIPE_LIMITS)) {
    const field = byId(name);
    field.onchange = () => {
      const valid = field.value && field.checkValidity() && (name !== "wipeWarningDays" || Number(field.value) < wipeLimits().wipeOfflineDays);
      if (valid) { setting(name, field.value); applyWipeLimits(); }
      field.value = wipeLimits()[name];
      renderWipeLimits();
    };
  }
}

function bindSecurity() {
  renderSecurity();
  bindWipeLimits();
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
      if (!ok) byId("securityStatus").textContent = "Could not save. Check the words or wait before trying again.";
    } catch { byId("securityStatus").textContent = "Protection could not be saved in this browser."; }
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
      if (!await eraseWithWord(word, byId("wipeConfirm").checked)) byId("wipeStatus").textContent = "The request could not be verified.";
    } catch { byId("wipeStatus").textContent = "The request could not be verified."; }
    finally { byId("wipeSubmit").disabled = false; }
  };
  byId("wipeDialog").addEventListener("close", () => { byId("wipeWord").value = ""; byId("wipeConfirm").checked = false; if (!isWiping()) byId("settings").showModal(); });
  byId("settings").addEventListener("close", () => {
    for (const id of ["securityCurrent", "securityNew", "securityRepeat"]) byId(id).value = "";
  });
}
