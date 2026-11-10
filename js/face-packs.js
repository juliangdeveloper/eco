import { APP_VERSION } from "./config.js";
import { all, remove, setting, store } from "./storage.js";

const STORE = "facePacks";
const ACTIVE_KEY = "facePack";
export const DEFAULT_PACK_ID = "default";
export const PACK_FORMAT = "eco-face-pack";
export const PACK_MAX_BYTES = 3 * 1024 * 1024;
const SHEET_MAX_SIDE = 4096;
const DATA_URL = /^data:image\/(?:png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const STATE_NAME = /^[a-z][a-z0-9_]{0,39}$/;
let cache = null;

const base = (file) => new URL("../assets/face/" + file + "?v=" + APP_VERSION, import.meta.url).href;

async function fetchJson(file) {
  const response = await fetch(base(file));
  if (!response.ok) throw new Error("Face assets could not be loaded.");
  return response.json();
}

function sheetsOf(manifest) {
  const files = new Set(Object.values(manifest.states || {}).map((state) => state.sheet));
  for (const accessory of Object.values(manifest.accessories || {})) files.add(accessory.sheet);
  return [...files];
}

async function defaultPack() {
  const [face, characters] = await Promise.all([fetchJson("face.json"), fetchJson("characters.json")]);
  const urls = {};
  for (const file of new Set([...sheetsOf(face), ...sheetsOf(characters)])) urls[file] = base(file);
  return { id: DEFAULT_PACK_ID, name: "Default", packVersion: APP_VERSION, face, characters, urls };
}

export function activePackId() {
  return setting(ACTIVE_KEY) || DEFAULT_PACK_ID;
}

export async function listPacks() {
  let rows = [];
  try { rows = await all(STORE); } catch {}
  return [{ id: DEFAULT_PACK_ID, name: "Default" }, ...rows.map(({ id, name, packVersion }) => ({ id, name, packVersion }))];
}

export async function loadPack(force = false) {
  const id = activePackId();
  if (cache && cache.id === id && !force) return cache;
  let pack = null;
  if (id !== DEFAULT_PACK_ID) {
    try { pack = (await all(STORE)).find((row) => row.id === id) || null; } catch {}
    if (pack) pack = { ...pack, urls: pack.sheets };
  }
  cache = await measure(pack || await defaultPack());
  return cache;
}

async function measure(pack) {
  pack.sizes = {};
  await Promise.all(Object.entries(pack.urls).map(([file, url]) => new Promise((resolve) => {
    const image = new Image();
    image.onload = () => { pack.sizes[file] = [image.naturalWidth, image.naturalHeight]; resolve(); };
    image.onerror = () => resolve();
    image.src = url;
  })));
  return pack;
}

export async function selectPack(id) {
  setting(ACTIVE_KEY, id);
  cache = null;
  const pack = await loadPack(true);
  window.dispatchEvent(new Event("eco-face-pack"));
  return pack;
}

export async function deletePack(id) {
  if (id === DEFAULT_PACK_ID) return;
  await remove(STORE, id);
  if (activePackId() === id) await selectPack(DEFAULT_PACK_ID);
}

function toDataUrl(url) {
  return fetch(url).then((response) => response.blob()).then((blob) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  }));
}

export async function exportPack() {
  const pack = await loadPack();
  const sheets = {};
  for (const [file, url] of Object.entries(pack.urls)) sheets[file] = url.startsWith("data:") ? url : await toDataUrl(url);
  const value = { format: PACK_FORMAT, version: 1, name: pack.name, packVersion: String(pack.packVersion || "1"), face: pack.face, characters: pack.characters, sheets };
  const blob = new Blob([JSON.stringify(value)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "eco-face-" + pack.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + ".json";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  return { name: pack.name, bytes: blob.size };
}

const isInt = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

function checkState(state, sheets, required = true) {
  if (!state || typeof state !== "object") return !required;
  return typeof state.sheet === "string" && Object.hasOwn(sheets, state.sheet) && isInt(state.row ?? 0, 0, 512) && isInt(state.frames, 1, 64) && typeof state.fps === "number" && state.fps >= 0.5 && state.fps <= 60 && typeof state.loop === "boolean" && (state.next === undefined || typeof state.next === "string" && STATE_NAME.test(state.next));
}

function checkManifest(manifest, format, required, sheets) {
  if (!manifest || manifest.format !== format || manifest.version !== 1 || !isInt(manifest.grid, 8, 256) || !manifest.states || typeof manifest.states !== "object") return false;
  const names = Object.keys(manifest.states);
  if (!names.length || names.length > 128 || !names.every((name) => STATE_NAME.test(name))) return false;
  if (!required.every((name) => Object.hasOwn(manifest.states, name))) return false;
  if (!Object.values(manifest.states).every((state) => checkState(state, sheets))) return false;
  if (manifest.accessories !== undefined && (typeof manifest.accessories !== "object" || Object.keys(manifest.accessories).length > 32 || !Object.entries(manifest.accessories).every(([name, state]) => STATE_NAME.test(name) && checkState(state, sheets)))) return false;
  if (manifest.palettes !== undefined && (!Array.isArray(manifest.palettes) || manifest.palettes.length > 32 || !manifest.palettes.every((hue) => typeof hue === "number" && hue >= 0 && hue <= 360))) return false;
  return true;
}

async function decode(url) {
  const blob = await (await fetch(url)).blob();
  const bitmap = await createImageBitmap(blob);
  const size = [bitmap.width, bitmap.height];
  bitmap.close?.();
  return size;
}

export async function readPackFile(file) {
  const invalid = "This file isn't a valid Eco face pack.";
  if (!file || file.size > PACK_MAX_BYTES) throw new Error("The pack is too large. The limit is 3 MB.");
  let value;
  try { value = JSON.parse(await file.text()); } catch { throw new Error(invalid); }
  if (!value || value.format !== PACK_FORMAT || value.version !== 1 || typeof value.name !== "string" || !value.name.trim() || value.name.length > 40 || !value.sheets || typeof value.sheets !== "object") throw new Error(invalid);
  const sheets = value.sheets;
  const files = Object.keys(sheets);
  if (!files.length || files.length > 64 || !files.every((name) => /^[\w.-]{1,64}$/.test(name) && typeof sheets[name] === "string" && DATA_URL.test(sheets[name]))) throw new Error(invalid);
  if (!checkManifest(value.face, "eco-face", ["idle"], sheets) || !checkManifest(value.characters, "eco-characters", ["waiting"], sheets)) throw new Error(invalid);
  const sizes = {};
  try { for (const name of files) sizes[name] = await decode(sheets[name]); } catch { throw new Error("The pack has an image that can't be read."); }
  for (const manifest of [value.face, value.characters]) {
    for (const state of [...Object.values(manifest.states), ...Object.values(manifest.accessories || {})]) {
      const [width, height] = sizes[state.sheet];
      if (width > SHEET_MAX_SIDE || height > SHEET_MAX_SIDE || width < state.frames * manifest.grid || height < ((state.row || 0) + 1) * manifest.grid) throw new Error("The pack's images don't match its manifest.");
    }
  }
  return { name: value.name.trim(), packVersion: String(value.packVersion || "1").slice(0, 20), face: value.face, characters: value.characters, sheets, bytes: file.size };
}

export async function importPack(file) {
  const pack = await readPackFile(file);
  const id = "pack-" + crypto.randomUUID();
  await store(STORE, { id, ...pack, importedAt: Date.now() });
  return selectPack(id);
}
