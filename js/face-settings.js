import { FACE_VOICE_SETTINGS, TRANSCRIBERS, faceVoiceSettings, resetFaceVoiceSettings, setFaceVoiceSetting } from "./face-config.js";
import { activePackId, deletePack, DEFAULT_PACK_ID, exportPack, importPack, isBuiltin, listPacks, loadPack, selectPack } from "./face-packs.js";
import { systemVoices } from "./speech.js";
import { deviceCapabilities, onCapabilities } from "./capabilities.js";
import { byId } from "./ui.js";

const SPEECH_FIELDS = new Set(["speechRate", "speechPitch"]);
const TRANSCRIBER_LABELS = { "whisper-tiny": "Whisper tiny (faster)", "whisper-base": "Whisper base (more accurate)" };

function field(label, input) {
  const wrapper = document.createElement("label");
  wrapper.append(label, input);
  return wrapper;
}

function numberField(entry, values) {
  const input = document.createElement("input");
  input.type = "number";
  input.id = "fv-" + entry.name;
  input.min = entry.min;
  input.max = entry.max;
  input.step = entry.step;
  input.inputMode = "decimal";
  input.value = values[entry.name];
  input.oninput = () => { if (input.value && input.checkValidity()) setFaceVoiceSetting(entry.name, input.value); };
  input.onchange = () => { input.value = faceVoiceSettings()[entry.name]; };
  return field(entry.label, input);
}

function select(id, options, value, onchange) {
  const input = document.createElement("select");
  input.id = id;
  for (const [key, label] of options) {
    const option = document.createElement("option");
    option.value = key;
    option.textContent = label;
    input.append(option);
  }
  input.value = value;
  input.onchange = () => onchange(input.value);
  return input;
}

function toggle(name, label, hint, checked) {
  const input = document.createElement("input");
  input.type = "checkbox";
  input.id = "fv-" + name;
  input.checked = checked;
  input.onchange = () => setFaceVoiceSetting(name, input.checked);
  const text = document.createElement("span");
  const title = document.createElement("strong");
  title.textContent = label;
  const small = document.createElement("small");
  small.textContent = hint;
  text.append(title, small);
  const wrapper = document.createElement("label");
  wrapper.className = "checkLabel voiceSwitch";
  wrapper.append(input, text);
  return wrapper;
}

function resetButton(group) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "resetDefaults";
  button.textContent = "Reset to defaults";
  button.onclick = () => { resetFaceVoiceSettings(group); renderFaceVoiceSettings(); };
  return button;
}

async function renderPacks() {
  const box = byId("facePackControls");
  const packs = await listPacks();
  const active = activePackId();
  const chooser = select("facePackSelect", packs.map((pack) => [pack.id, pack.name + (pack.packVersion && pack.id !== DEFAULT_PACK_ID ? " · " + pack.packVersion : "")]), packs.some((pack) => pack.id === active) ? active : DEFAULT_PACK_ID, async (id) => { await selectPack(id); renderPacks(); });
  const status = document.createElement("small");
  status.id = "facePackStatus";
  status.setAttribute("role", "status");
  const preview = document.createElement("div");
  preview.id = "facePackPreview";
  preview.className = "facePackPreview";
  preview.setAttribute("aria-hidden", "true");
  const actions = document.createElement("div");
  actions.className = "facePackActions";
  const exportButton = document.createElement("button");
  exportButton.type = "button";
  exportButton.textContent = "Export";
  exportButton.onclick = async () => { try { const result = await exportPack(); status.textContent = "Exported “" + result.name + "”."; } catch { status.textContent = "The pack could not be exported."; } };
  const importButton = document.createElement("button");
  importButton.type = "button";
  importButton.textContent = "Import";
  const file = document.createElement("input");
  file.type = "file";
  file.accept = "application/json,.json";
  file.hidden = true;
  file.id = "facePackFile";
  importButton.onclick = () => file.click();
  file.onchange = async () => {
    const chosen = file.files?.[0];
    file.value = "";
    if (!chosen) return;
    status.textContent = "Checking the pack…";
    try { const pack = await importPack(chosen); await renderPacks(); byId("facePackStatus").textContent = "Using “" + pack.name + "”."; }
    catch (error) { status.textContent = error.message || "This file isn't a valid Eco face pack."; }
  };
  const removeButton = document.createElement("button");
  removeButton.type = "button";
  removeButton.textContent = "Remove";
  removeButton.disabled = isBuiltin(chooser.value);
  removeButton.onclick = async () => { await deletePack(chooser.value); await renderPacks(); };
  actions.append(exportButton, importButton, removeButton, file);
  box.replaceChildren(preview, field("Face pack", chooser), actions, status);
  try {
    const pack = await loadPack();
    const state = pack.face.states.idle;
    const grid = pack.face.grid;
    const size = pack.sizes[state.sheet] || [grid, grid];
    const zoom = Math.max(1, Math.floor(64 / grid));
    Object.assign(preview.style, { width: grid * zoom + "px", height: grid * zoom + "px", backgroundImage: 'url("' + pack.urls[state.sheet] + '")', backgroundSize: size[0] * zoom + "px " + size[1] * zoom + "px", backgroundPosition: "0 " + -(state.row || 0) * grid * zoom + "px" });
  } catch {}
}

export function renderFaceVoiceSettings() {
  const values = faceVoiceSettings();
  const faceFields = byId("faceSettingsFields");
  const voiceFields = byId("voiceSettingsFields");
  const faceGrid = document.createElement("div");
  faceGrid.className = "stepLimits";
  faceGrid.append(...FACE_VOICE_SETTINGS.filter((entry) => entry.group === "face").map((entry) => numberField(entry, values)));
  faceFields.replaceChildren(faceGrid, resetButton("face"));
  const caps = deviceCapabilities();
  const parts = [];
  const switches = document.createElement("div");
  switches.className = "voiceSwitches";
  if (caps.listen) switches.append(toggle("listen", "Listen", "Microphone, hands-free listening and the wake word.", values.listen));
  if (caps.speak) switches.append(toggle("speak", "Speak", "Reads replies to voice turns aloud and speaks when asked.", values.speak));
  if (switches.children.length) parts.push(switches);
  else {
    const note = document.createElement("p");
    note.className = "voiceUnavailable";
    note.id = "voiceUnavailable";
    note.textContent = "This device has no microphone or voice output Eco can use.";
    parts.push(note);
  }
  if (caps.listen) {
    const transcriber = select("fv-transcriber", Object.keys(TRANSCRIBERS).map((key) => [key, TRANSCRIBER_LABELS[key]]), values.transcriber, (value) => setFaceVoiceSetting("transcriber", value));
    const top = document.createElement("div");
    top.className = "stepLimits";
    top.append(field("Transcriber", transcriber));
    parts.push(top);
  }
  const voices = systemVoices();
  if (voices.length) parts.push(field("System voice", select("fv-voiceName", [["", "Automatic (reply language)"], ...voices.map((voice) => [voice.name, voice.name + " · " + voice.lang])], values.voiceName, (value) => setFaceVoiceSetting("voiceName", value))));
  if ((window.AudioContext || window.webkitAudioContext) && window.WebAssembly) {
    const neural = document.createElement("input");
    neural.type = "checkbox";
    neural.id = "fv-neuralVoice";
    neural.checked = values.neuralVoice;
    neural.onchange = () => setFaceVoiceSetting("neuralVoice", neural.checked);
    const neuralLabel = document.createElement("label");
    neuralLabel.className = "checkLabel";
    neuralLabel.append(neural, "Local neural voice (downloads about 75 MB the first time)");
    parts.push(neuralLabel);
  }
  const grid = document.createElement("div");
  grid.className = "stepLimits";
  grid.append(...FACE_VOICE_SETTINGS.filter((entry) => entry.group === "voice" && (SPEECH_FIELDS.has(entry.name) ? caps.speak : caps.listen)).map((entry) => numberField(entry, values)));
  if (grid.children.length) parts.push(grid);
  voiceFields.replaceChildren(...parts, resetButton("voice"));
  renderPacks().catch(() => {});
}

export function bindFaceVoiceSettings() {
  byId("faceSettings").addEventListener("toggle", () => { if (byId("faceSettings").open) renderFaceVoiceSettings(); });
  byId("voiceSettings").addEventListener("toggle", () => { if (byId("voiceSettings").open) renderFaceVoiceSettings(); });
  onCapabilities(() => { if (byId("voiceSettings").open) renderFaceVoiceSettings(); });
  try { speechSynthesis.addEventListener?.("voiceschanged", () => { if (byId("voiceSettings").open) renderFaceVoiceSettings(); }); } catch {}
}
