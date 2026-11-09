const KEY = "eco.security";
const SIGNAL_KEY = "eco.securitySignal";
const ITERATIONS = 600000;
const PREFIX = /^\s*(?:autodestrucci[oó]n|borrado\s+seguro)(?:\s+|[:-]\s*|$)/iu;
let wiping = false;
let shutdown = () => {};
let queue = Promise.resolve();
let nonce = readRecord()?.nonce || "";
const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel("eco-security") : null;

function readRecord() {
  try { return JSON.parse(localStorage.getItem(KEY) || "null"); }
  catch { return null; }
}

function writeRecord(value) {
  if (wiping) return;
  localStorage.setItem(KEY, JSON.stringify(value));
  nonce = value.nonce;
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
  if (event.key === KEY && event.newValue) nonce = readRecord()?.nonce || nonce;
  if (event.key === SIGNAL_KEY && event.newValue) {
    try { receiveSignal(JSON.parse(event.newValue)); } catch {}
  }
});

async function erase(broadcast = true) {
  if (wiping) return;
  wiping = true;
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
