const KEY = "eco.security";
const SIGNAL_KEY = "eco.securitySignal";
const CHANNEL_KEY = "eco.securityChannel";
const ACTIVITY_KEY = "eco.lastActivityAt";
const DAY_MS = 24 * 60 * 60 * 1000;
const OFFLINE_KEY = "eco.memoryOfflineMs";
export const WIPE_LIMITS = Object.freeze({
  wipeClosedDays: Object.freeze({ default: 15, min: 1, max: 365, step: 1 }),
  wipeOfflineDays: Object.freeze({ default: 5, min: 1, max: 365, step: 1 }),
  wipeWarningDays: Object.freeze({ default: 3, min: 0.5, max: 364.5, step: 0.5 }),
  wipeIntervalSeconds: Object.freeze({ default: 60, min: 15, max: 600, step: 1 })
});
const validLimit = (value, bounds) => Number.isFinite(value) && value >= bounds.min && value <= bounds.max && Number.isInteger(value / bounds.step);
export function wipeLimits() {
  const read = name => { let raw = null; try { raw = localStorage.getItem("eco." + name); } catch {} const value = raw === null || raw === "" ? NaN : Number(raw); return validLimit(value, WIPE_LIMITS[name]) ? value : WIPE_LIMITS[name].default; };
  const limits = Object.fromEntries(Object.keys(WIPE_LIMITS).map(name => [name, read(name)]));
  if (limits.wipeWarningDays >= limits.wipeOfflineDays) limits.wipeWarningDays = Math.min(WIPE_LIMITS.wipeWarningDays.default, limits.wipeOfflineDays - WIPE_LIMITS.wipeWarningDays.step);
  return limits;
}
const limitsMs = () => { const limits = wipeLimits(); return { closed: limits.wipeClosedDays * DAY_MS, offline: limits.wipeOfflineDays * DAY_MS, warning: limits.wipeWarningDays * DAY_MS, interval: limits.wipeIntervalSeconds * 1000 }; };
let activityTimer;
let activityInterval = 0;
let memoryHealth = async () => null;
let memoryFailing = false;
let offlineMark = null;
let offlineLeader = !navigator.locks;
let offlineLocking = null;
const ITERATIONS = 600000;
const PREFIX = /^\s*(?:autodestrucci[oó]n|borrado\s+seguro)(?:\s+|[:-]\s*|$)/iu;
let wiping = false;
let shutdown = () => {};
let queue = Promise.resolve();
let nonce = readRecord()?.nonce || activityNonce();
const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel("eco-security") : null;

function readRecord() {
  try { return JSON.parse(localStorage.getItem(KEY) || "null"); }
  catch { return null; }
}

function activityNonce() {
  try { const value = localStorage.getItem(CHANNEL_KEY) || crypto.randomUUID(); localStorage.setItem(CHANNEL_KEY, value); return value; } catch { return crypto.randomUUID(); }
}

const MEMORY_KEY = "eco.persistentMemory";
export function memoryConfigured() {
  try {
    const config = JSON.parse(localStorage.getItem(MEMORY_KEY) || "null");
    return Boolean(config && (config.backend === "google-drive" ? config.sheet : ["supabase", "database"].includes(config.backend) && config.connector));
  } catch { return false; }
}

export function checkLocalActivity() {
  return serial(async () => {
    if (wiping) return true;
    if (!memoryConfigured()) {
      try { localStorage.removeItem(ACTIVITY_KEY); } catch {}
      return trackOffline();
    }
    const now = Date.now();
    let previous = null;
    try { previous = localStorage.getItem(ACTIVITY_KEY); } catch {}
    const timestamp = Number(previous);
    if (previous !== null && Number.isFinite(timestamp) && timestamp > 0 && now - timestamp > limitsMs().closed) { await erase(); return true; }
    try { localStorage.setItem(ACTIVITY_KEY, String(now)); } catch {}
    return trackOffline();
  });
}

function offlineTotal() {
  let value = 0;
  try { value = Number(localStorage.getItem(OFFLINE_KEY)); } catch {}
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function offlineText(remaining) {
  const minutes = Math.max(1, Math.ceil(remaining / 60000));
  const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60), rest = minutes % 60;
  return days ? days + " d " + hours + " h" : hours ? hours + " h " + rest + " min" : rest + " min";
}

function renderOffline(total = offlineTotal()) {
  const node = document.getElementById("offlineCountdown");
  if (!node) return;
  const limits = limitsMs();
  const visible = !wiping && total >= limits.warning && total < limits.offline;
  node.hidden = !visible;
  if (!visible) return;
  const text = offlineText(limits.offline - total);
  node.querySelector("span").textContent = text;
  node.setAttribute("aria-label", "Borrado sin memoria compartida en " + text);
  node.title = "Eco se borrará en " + text + " si no recupera la memoria compartida";
}

async function trackOffline() {
  let failing = false;
  try { const state = await memoryHealth(); failing = state !== null && (state || memoryFailing); } catch {}
  const now = performance.now();
  let total = offlineTotal();
  if (failing && offlineLeader) {
    if (offlineMark !== null && now > offlineMark) total += now - offlineMark;
    offlineMark = now;
    if (total >= limitsMs().offline) { await erase(); return true; }
    try { localStorage.setItem(OFFLINE_KEY, String(Math.round(total))); } catch {}
  } else offlineMark = null;
  renderOffline(total);
  return false;
}

export function setMemoryHealth(callback) { memoryHealth = callback; }

export function reportMemoryConnection(ok) {
  if (wiping) return;
  memoryFailing = !ok;
  if (!ok) { if (offlineMark === null && offlineLeader) offlineMark = performance.now(); return; }
  offlineMark = null;
  try { localStorage.removeItem(OFFLINE_KEY); } catch {}
  renderOffline(0);
}

const activityWake = () => { checkLocalActivity().catch(() => {}); };
export async function startLocalActivityWatch() {
  stopLocalActivityWatch();
  if (!offlineLeader && !offlineLocking) offlineLocking = navigator.locks.request("eco-memory-offline", () => { offlineLeader = true; return new Promise(() => {}); }).catch(() => {});
  if (await checkLocalActivity()) return true;
  activityInterval = limitsMs().interval;
  activityTimer = setInterval(activityWake, activityInterval);
  window.addEventListener("focus", activityWake);
  window.addEventListener("pageshow", activityWake);
  document.addEventListener("visibilitychange", activityWake);
  return false;
}
export function applyWipeLimits() {
  if (wiping) return;
  renderOffline();
  const interval = limitsMs().interval;
  if (!activityInterval || interval === activityInterval) return;
  clearInterval(activityTimer);
  activityInterval = interval;
  activityTimer = setInterval(activityWake, interval);
}
export function stopLocalActivityWatch() {
  activityInterval = 0;
  clearInterval(activityTimer);
  window.removeEventListener("focus", activityWake);
  window.removeEventListener("pageshow", activityWake);
  document.removeEventListener("visibilitychange", activityWake);
}

function writeRecord(value) {
  if (wiping) return;
  localStorage.setItem(KEY, JSON.stringify(value));
  nonce = value.nonce;
  try { localStorage.setItem(CHANNEL_KEY, nonce); } catch {}
}

const base64 = bytes => btoa(String.fromCharCode(...bytes));
const unbase64 = text => Uint8Array.from(atob(text), char => char.charCodeAt(0));
const normalize = word => String(word || "").normalize("NFC").trim();

async function digest(word, salt) {
  const bytes = new TextEncoder().encode(normalize(word));
  try {
    const key = await crypto.subtle.importKey("raw", bytes, "PBKDF2", false, ["deriveBits"]);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", salt: unbase64(salt), iterations: ITERATIONS, hash: "SHA-256" }, key, 256));
  } finally { bytes.fill(0); }
}

function serial(operation) {
  const run = () => navigator.locks ? navigator.locks.request("eco-security", operation) : operation();
  const pending = queue.then(run);
  queue = pending.catch(() => {});
  return pending;
}

async function verify(word, record) {
  if (!record || wiping || record.lockedUntil > Date.now() || !normalize(word) || normalize(word).length > 128) return false;
  const actual = await digest(word, record.salt);
  const expected = unbase64(record.hash);
  let difference = actual.length ^ expected.length;
  for (let index = 0; index < actual.length; index++) difference |= actual[index] ^ expected[index];
  actual.fill(0);
  expected.fill(0);
  if (wiping || readRecord()?.hash !== record.hash) return false;
  if (difference) {
    record.failures = (record.failures || 0) + 1;
    record.lockedUntil = record.failures >= 5 ? Date.now() + Math.min(900000, 30000 * 2 ** Math.min(5, record.failures - 5)) : 0;
    writeRecord(record);
    return false;
  }
  return true;
}

export const isWiping = () => wiping;
export const isSecurityCommand = text => PREFIX.test(String(text || "").normalize("NFC"));
export const safeDraft = text => isSecurityCommand(text) ? "" : text;
export function securityState() {
  const record = readRecord();
  return { enabled: Boolean(record?.hash), lockedUntil: record?.lockedUntil || 0 };
}
export function setSecurityShutdown(callback) { shutdown = callback; }

export function configureSecurity(word, current = "") {
  return serial(async () => {
    if (wiping) return false;
    const value = normalize(word);
    if (value.length < 8 || value.length > 128 || /[\r\n]/.test(value)) return false;
    const record = readRecord();
    if (record && !await verify(current, record)) return false;
    const salt = base64(crypto.getRandomValues(new Uint8Array(32)));
    const hash = base64(await digest(value, salt));
    if (wiping || readRecord()?.hash !== record?.hash) return false;
    writeRecord({ salt, hash, iterations: ITERATIONS, nonce: crypto.randomUUID(), armedAt: Date.now(), consumed: [], failures: 0, lockedUntil: 0 });
    window.dispatchEvent(new Event("eco-security-changed"));
    return true;
  });
}

export function securityNotice() {
  const node = document.getElementById("securityNotice");
  if (node) { node.hidden = false; node.textContent = "No se pudo verificar la solicitud."; }
}

export async function interceptSecurityCommand(text) {
  if (!isSecurityCommand(text)) return false;
  const word = String(text).normalize("NFC").replace(PREFIX, "");
  try {
    await serial(async () => {
      if (await verify(word, readRecord())) await erase();
      else securityNotice();
    });
  } catch { securityNotice(); }
  return true;
}

export function eraseWithWord(word, confirmed) {
  return serial(async () => {
    if (!confirmed || !await verify(word, readRecord())) return false;
    await erase();
    return true;
  });
}

export async function inspectSecurityRecord(record, eco, redact) {
  if (!isSecurityCommand(record?.content)) return false;
  await serial(async () => {
    const state = readRecord();
    const created = Date.parse(record.date);
    if (!state || wiping || ![eco, "*"].includes(String(record.to).trim()) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.id || "") || !Number.isFinite(created) || created < state.armedAt || created > Date.now() + 120000 || state.consumed.includes(record.id)) return;
    if (state.lockedUntil > Date.now()) return;
    state.consumed = [...state.consumed, record.id];
    try { writeRecord(state); } catch {}
    const word = record.content.normalize("NFC").replace(PREFIX, "");
    if (!await verify(word, state)) return;
    try { Promise.resolve(redact?.()).catch(() => {}); } catch {}
    await erase();
  }).catch(() => {});
  return true;
}

export function redactSecurityData(value) {
  if (typeof value === "string") {
    const normalized = value.normalize("NFC");
    const pattern = /(?:autodestrucci[oó]n|borrado\s+seguro)\b[^\r\n]*/giu;
    return pattern.test(normalized) ? normalized.replace(pattern, "[orden de seguridad oculta]") : value;
  }
  if (Array.isArray(value)) return value.map(redactSecurityData);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactSecurityData(item)]));
  return value;
}

const bounded = promise => Promise.race([Promise.resolve(promise).catch(() => {}), new Promise(resolve => setTimeout(resolve, 1500))]);

function receiveSignal(value) {
  if (value?.type === "wipe" && nonce && value.nonce === nonce) erase(false);
}
channel?.addEventListener("message", event => receiveSignal(event.data));
window.addEventListener("storage", event => {
  if (event.key === OFFLINE_KEY) renderOffline();
  if (event.key?.startsWith("eco.") && Object.hasOwn(WIPE_LIMITS, event.key.slice(4))) applyWipeLimits();
  if (event.key === KEY && event.newValue) nonce = readRecord()?.nonce || nonce;
  if (event.key === CHANNEL_KEY && event.newValue) nonce = readRecord()?.nonce || event.newValue;
  if (event.key === SIGNAL_KEY && event.newValue) {
    try { receiveSignal(JSON.parse(event.newValue)); } catch {}
  }
});

async function erase(broadcast = true) {
  if (wiping) return;
  wiping = true;
  stopLocalActivityWatch();
  document.documentElement.style.display = "none";
  if (broadcast && nonce) {
    const signal = { type: "wipe", nonce };
    try { channel?.postMessage(signal); localStorage.setItem(SIGNAL_KEY, JSON.stringify(signal)); } catch {}
  }
  try { shutdown(); } catch {}
  const scope = new URL("./", location.href).href;
  const workers = bounded((async () => {
    const registrations = await navigator.serviceWorker?.getRegistrations() || [];
    await Promise.all(registrations.filter(registration => registration.scope.startsWith(scope)).map(async registration => {
      for (const worker of [registration.active, registration.waiting, registration.installing]) worker?.postMessage({ type: "eco-wipe" });
      await registration.unregister();
    }));
  })());
  const databases = bounded((async () => {
    const names = new Set(["eco"]);
    try { for (const database of await indexedDB.databases?.() || []) if (/^eco(?:$|[-.])/.test(database.name || "")) names.add(database.name); } catch {}
    await Promise.all([...names].map(name => new Promise(resolve => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = request.onerror = () => resolve();
    })));
  })());
  const cachesCleared = bounded((async () => {
    await workers;
    if (globalThis.caches) await Promise.all((await caches.keys()).filter(name => name.startsWith("eco-v")).map(name => caches.delete(name)));
  })());
  for (const name of ["localStorage", "sessionStorage"]) {
    try {
      const storage = globalThis[name];
      for (const key of Object.keys(storage)) if (key.startsWith("eco.")) { try { storage.removeItem(key); } catch {} }
    } catch {}
  }
  nonce = "";
  channel?.close();
  await Promise.all([workers, databases, cachesCleared]);
  location.replace("about:blank");
  try { window.close(); } catch {}
}
