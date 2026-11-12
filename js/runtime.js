import { json } from "./storage.js";

const STORE = "runtimeComponents";
const components = new Map();

export function literalError(error) {
  if (error == null) return "unknown error";
  if (typeof error === "string") return error.trim() || "unknown error";
  const message = error.message != null ? String(error.message).trim() : "";
  const name = error.name && error.name !== "Error" ? String(error.name) : "";
  const label = name && message && !message.includes(name) ? name : !message && name ? name : "";
  const file = error.filename ? String(error.filename) + (error.lineno != null ? ":" + error.lineno : "") : "";
  const nested = error.error && error.error !== error ? literalError(error.error) : "";
  const parts = [label, message || nested, file].filter(Boolean);
  return parts.join(" ").trim() || String(error);
}

export function registerComponent(name, api) {
  if (typeof name !== "string" || !/^[A-Za-z][A-Za-z0-9]*$/.test(name) || !api || typeof api !== "object") throw new Error("Invalid component");
  components.set(name, api);
  return name;
}

export function listComponents() {
  return [...components.keys()];
}

export function storedConfig(name) {
  const all = json(STORE) || {};
  return name ? { ...(all[name] || {}) } : { ...all };
}

export function saveComponentConfig(name, patch) {
  const all = { ...(json(STORE) || {}) };
  all[name] = { ...(all[name] || {}), ...patch };
  for (const [key, value] of Object.entries(all[name])) if (value === null || value === "") delete all[name][key];
  json(STORE, all);
  return { ...all[name] };
}

export function componentConfig(name) {
  if (!name) return Object.fromEntries(listComponents().map((key) => [key, componentConfig(key)]));
  const entry = components.get(name);
  if (!entry) throw new Error("Unknown component: " + name);
  return entry.config ? entry.config() : storedConfig(name);
}

export function componentStatus(name) {
  if (!name) return Object.fromEntries(listComponents().map((key) => [key, componentStatus(key)]));
  const entry = components.get(name);
  if (!entry) throw new Error("Unknown component: " + name);
  return { name, ...(entry.status ? entry.status() : {}) };
}

function cleanPatch(entry, name, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("config must be an object of keys to set");
  const clean = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key)) throw new Error("Invalid config key: " + key);
    if (entry.keys && !entry.keys.has(key)) throw new Error("Unknown config key for " + name + ": " + key);
    if (value !== null && typeof value === "object") throw new Error("Config values must be text, numbers or booleans");
    clean[key] = value;
  }
  return clean;
}

export async function configureComponent(name, patch) {
  const entry = components.get(name);
  if (!entry) throw new Error("Unknown component: " + name);
  const clean = cleanPatch(entry, name, patch);
  if (entry.configure) return entry.configure(clean);
  return { ok: true, name, config: saveComponentConfig(name, clean) };
}

export async function reloadComponent(name) {
  const entry = components.get(name);
  if (!entry) throw new Error("Unknown component: " + name);
  if (typeof entry.reload !== "function") throw new Error(name + " cannot be reloaded");
  return entry.reload();
}

export const ecoRuntime = {
  list() { return listComponents(); },
  status(name) { return componentStatus(name); },
  config(name) { return name ? componentConfig(name) : componentConfig(); },
  configure(name, patch) { return configureComponent(name, patch); },
  set(name, key, value) { return configureComponent(name, { [key]: value }); },
  reload(name) { return reloadComponent(name); }
};

if (typeof window !== "undefined") window.ecoRuntime = ecoRuntime;
