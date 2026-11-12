import { bindStepLimits } from "./step-limits.js";
import { applyWipeLimits, configureSecurity, eraseWithWord, isWiping, securityState, WIPE_LIMITS, wipeLimits } from "./security.js";
import { DEFAULT_MODEL } from "./config.js";
import { setting } from "./storage.js";
import { byId } from "./ui.js";
import { connectorStatus, deleteConnector, getConnector, listConnectors, openOAuthWindow, startOAuth } from "./connectors.js";
import { deleteSecret } from "./vault.js";
import { showCredentialCard } from "./credentials.js";
import { listRoutines, manageRoutine, onRoutinesChange } from "./routines.js";
import { commandUnavailable, createMagic, deleteMagic, editMagic, listMagic, runMagic } from "./magic.js";
import { listDeviceTools } from "./device-tools.js";
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
    await Promise.all([renderConnectors(), renderRoutines(), renderMemories(), renderMagic()]);
    renderSecurity();
    renderWipeLimits();
    byId("settings").showModal();
  };
  onRoutinesChange(() => renderRoutines());
  window.addEventListener("eco-magic-change", () => renderMagic());
  byId("magicSettings").addEventListener("toggle", () => { if (byId("magicSettings").open) renderMagic(); });
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


const MAGIC_EMPTY = "Add a command here or ask Eco to create one.";
const MAGIC_ACTIONS = [
  ["foto_frontal", "Front photo"],
  ["foto_trasera", "Rear photo"],
  ["hablar", "Speak text"],
  ["callar", "Stop speaking"],
  ["modo_cara", "Toggle face mode"],
  ["rutina", "Run routine"],
  ["herramienta", "Device tool"]
];

function magicSummary(command) {
  if (command.type === "model") return "Model";
  const label = MAGIC_ACTIONS.find((item) => item[0] === command.action?.kind)?.[1] || command.action?.kind || "Local";
  return "Local · " + label;
}

function magicSelect(id, options, value) {
  const input = document.createElement("select");
  input.id = id;
  for (const [key, label] of options) {
    const option = document.createElement("option");
    option.value = key;
    option.textContent = label;
    input.append(option);
  }
  input.value = value;
  return input;
}

function magicField(label, input) {
  const wrapper = document.createElement("label");
  wrapper.append(label, input);
  return wrapper;
}

let magicEditing = "";

function closeMagicForm() {
  magicEditing = "";
  const form = byId("magicForm");
  form.hidden = true;
  form.replaceChildren();
}

function updateMagicFields() {
  const form = byId("magicForm");
  const type = form.querySelector("#magicType")?.value;
  const kind = form.querySelector("#magicKind")?.value;
  for (const id of ["magicSpeak", "magicRoutine", "magicTool"]) {
    const field = form.querySelector("[data-field='" + id + "']");
    if (field) field.hidden = type !== "local" || kind !== { magicSpeak: "hablar", magicRoutine: "rutina", magicTool: "herramienta" }[id];
  }
  const instruction = form.querySelector("[data-field='magicInstruction']");
  const actions = form.querySelector("[data-field='magicActions']");
  if (instruction) instruction.hidden = type !== "model";
  if (actions) actions.hidden = type !== "local";
}

async function openMagicForm(command) {
  magicEditing = command?.id || "";
  const form = byId("magicForm");
  const phrases = document.createElement("textarea");
  phrases.id = "magicPhrases";
  phrases.rows = 3;
  phrases.required = true;
  phrases.placeholder = "One phrase per line";
  phrases.value = (command?.phrases || []).join("\n");
  const type = magicSelect("magicType", [["local", "Local"], ["model", "Model"]], command?.type || "local");
  const kind = magicSelect("magicKind", MAGIC_ACTIONS, command?.action?.kind || "foto_frontal");
  type.onchange = updateMagicFields;
  kind.onchange = updateMagicFields;
  const speak = document.createElement("input");
  speak.id = "magicSpeak";
  speak.value = command?.action?.text || "";
  const routines = (await listRoutines()).map((item) => [item.id, item.nombre + (item.activa ? "" : " (paused)")]);
  const routine = magicSelect("magicRoutine", routines.length ? routines : [["", "No routines"]], command?.action?.routine_id || routines[0]?.[0] || "");
  const tools = (await listDeviceTools()).map((item) => [item.name, item.name]);
  const tool = magicSelect("magicTool", tools.length ? tools : [["", "No device tools"]], command?.action?.tool || tools[0]?.[0] || "");
  const instruction = document.createElement("textarea");
  instruction.id = "magicInstruction";
  instruction.rows = 3;
  instruction.value = command?.instruction || "";
  const reply = document.createElement("input");
  reply.id = "magicReply";
  reply.value = command?.reply || "";
  const enabled = document.createElement("input");
  enabled.type = "checkbox";
  enabled.id = "magicEnabled";
  enabled.checked = command ? command.enabled : true;
  const enabledLabel = document.createElement("label");
  enabledLabel.className = "checkLabel";
  enabledLabel.append(enabled, "Enabled");
  const actions = document.createElement("div");
  actions.dataset.field = "magicActions";
  actions.append(magicField("Action", kind));
  const speakWrap = magicField("Text to say", speak);
  speakWrap.dataset.field = "magicSpeak";
  const routineWrap = magicField("Routine", routine);
  routineWrap.dataset.field = "magicRoutine";
  const toolWrap = magicField("Device tool", tool);
  toolWrap.dataset.field = "magicTool";
  actions.append(speakWrap, routineWrap, toolWrap);
  const instructionWrap = magicField("Instruction", instruction);
  instructionWrap.dataset.field = "magicInstruction";
  const status = document.createElement("p");
  status.id = "magicFormStatus";
  status.setAttribute("role", "status");
  const buttons = document.createElement("div");
  buttons.className = "connectorActions";
  const save = button(command ? "Save" : "Add", "", () => submitMagicForm());
  save.type = "button";
  const cancel = button("Cancel", "", () => closeMagicForm());
  buttons.append(save, cancel);
  form.replaceChildren(
    magicField("Phrases", phrases),
    magicField("Type", type),
    actions,
    instructionWrap,
    magicField("Spoken reply", reply),
    enabledLabel,
    status,
    buttons
  );
  form.hidden = false;
  form.onsubmit = (event) => { event.preventDefault(); submitMagicForm(); };
  updateMagicFields();
  phrases.focus();
}

async function submitMagicForm() {
  const phrases = byId("magicPhrases").value.split(/\n+/).map((item) => item.trim()).filter(Boolean);
  const type = byId("magicType").value;
  const payload = {
    frases: phrases,
    tipo: type,
    instruccion: byId("magicInstruction").value,
    respuesta: byId("magicReply").value,
    activa: byId("magicEnabled").checked,
    origen: "user"
  };
  if (type === "local") {
    payload.accion = { kind: byId("magicKind").value, texto: byId("magicSpeak").value, rutina: byId("magicRoutine").value, herramienta: byId("magicTool").value };
  }
  const result = magicEditing ? await editMagic(magicEditing, payload) : await createMagic(payload);
  if (!result.ok) {
    byId("magicFormStatus").textContent = result.error || "Could not save.";
    return;
  }
  closeMagicForm();
  await renderMagic();
}

export async function renderMagic() {
  const list = byId("magicList");
  if (!list) return;
  const rows = await listMagic();
  const items = [];
  if (!rows.length && byId("magicForm").hidden) {
    const empty = document.createElement("small");
    empty.textContent = MAGIC_EMPTY;
    items.push(empty);
  }
  for (const command of rows) {
    const row = document.createElement("div");
    row.className = "connectorRow";
    const info = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = command.phrases[0] || "Command";
    const detail = document.createElement("small");
    const blocked = await commandUnavailable(command);
    detail.textContent = [magicSummary(command), command.enabled ? "" : "Off", blocked].filter(Boolean).join(" · ");
    info.append(name, detail);
    const actions = document.createElement("div");
    actions.className = "connectorActions";
    const test = button("Test", "", async () => {
      byId("settings").close();
      const result = await runMagic(command, "", command.phrases[0]);
      if (result?.ok === false) byId("settings").showModal();
    });
    if (blocked) test.disabled = true;
    actions.append(
      test,
      button("Edit", "", () => openMagicForm(command)),
      button("Delete", "danger", async () => { await deleteMagic(command.id); await renderMagic(); })
    );
    row.append(info, actions);
    items.push(row);
  }
  const add = button("Add", "", () => openMagicForm(null));
  add.className = (add.className + " magicAdd").trim();
  list.replaceChildren(...items, add);
  if (magicEditing && !rows.some((item) => item.id === magicEditing) && magicEditing) closeMagicForm();
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
