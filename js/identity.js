import { json, setting } from "./storage.js";

export const DEFAULT_NAME = "Eco";
export const NAME_MIN = 2;
export const NAME_MAX = 24;
const PATTERN = /^(?=.*\p{L})[\p{L}\p{N}][\p{L}\p{N}' .-]*$/u;

export function cleanName(value) {
  return String(value ?? "").normalize("NFC").replace(/\s+/g, " ").trim();
}

export function validName(value) {
  const name = cleanName(value);
  return name.length >= NAME_MIN && name.length <= NAME_MAX && PATTERN.test(name);
}

function migrate() {
  const voice = json("faceVoice");
  if (!voice || !Object.hasOwn(voice, "wakeWord")) return;
  const legacy = cleanName(voice.wakeWord);
  if (!setting("ecoName") && validName(legacy)) setting("ecoName", legacy);
  delete voice.wakeWord;
  json("faceVoice", voice);
}

export function ecoName() {
  migrate();
  const stored = cleanName(setting("ecoName"));
  return validName(stored) ? stored : DEFAULT_NAME;
}

export function setEcoName(value) {
  const name = cleanName(value);
  if (!validName(name)) return false;
  if (name === ecoName()) return true;
  setting("ecoName", name);
  window.dispatchEvent(new CustomEvent("eco-name", { detail: { name } }));
  return true;
}

export function nameHandle(name = ecoName()) {
  return cleanName(name).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

export function onEcoName(listener) {
  window.addEventListener("eco-name", listener);
}
