import { sessionSnapshot } from "./session-data.js";
import { isWiping } from "./security.js";
import { DATABASE_NAME, STORAGE_PREFIX } from "./config.js";

const DATABASE_VERSION = 8;
const STORES = ["sessions", "skills", "connectors", "secrets", "keys", "routines", "deviceTools", "state", "facePacks", "attachments", "magic"];

const key = (name) => STORAGE_PREFIX + name;

export function setting(name, value) {
  if (value === undefined) return localStorage.getItem(key(name)) || "";
  if (isWiping()) return null;
  localStorage.setItem(key(name), value);
  return value;
}

export function json(name, value) {
  if (value === undefined) {
    try {
      return JSON.parse(localStorage.getItem(key(name)) || "null");
    } catch {
      return null;
    }
  }
  if (isWiping()) return null;
  localStorage.setItem(key(name), JSON.stringify(value));
  return value;
}

const OPEN_TIMEOUT_MS = 8000;
const TRANSACTION_TIMEOUT_MS = 12000;
let databasePromise = null;
const pendingWrites = new Set();
const transactions = new Set();

export function closeDatabase() {
  for (const transaction of transactions) { try { transaction.abort(); } catch {} }
  transactions.clear();
  const pending = databasePromise;
  databasePromise = null;
  pending?.then((database) => database.close()).catch(() => {});
}

export function db() {
  if (isWiping()) return Promise.reject(new Error("Storage closed"));
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    let finished = false;
    const fail = (message) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      databasePromise = null;
      reject(new Error(message));
    };
    const timer = setTimeout(() => fail("Storage could not be opened. Close other Eco tabs and try again."), OPEN_TIMEOUT_MS);
    request.onupgradeneeded = () => {
      for (const name of STORES) {
        if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, { keyPath: "id" });
      }
    };
    request.onblocked = () => fail("Another Eco tab is blocking storage. Close it and try again.");
    request.onsuccess = () => {
      const database = request.result;
      if (finished) { database.close(); return; }
      finished = true;
      clearTimeout(timer);
      database.onversionchange = () => { database.close(); databasePromise = null; };
      database.onclose = () => { databasePromise = null; };
      resolve(database);
    };
    request.onerror = () => fail("Local storage could not be opened.");
  });
  return databasePromise;
}

async function transact(name, mode, operation) {
  const database = await db();
  if (isWiping()) throw new Error("Storage closed");
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(name, mode);
    transactions.add(transaction);
    let value;
    let error;
    const timer = setTimeout(() => { error = new DOMException("Storage is not responding. Don't close Eco until it saves.", "TimeoutError"); try { transaction.abort(); } catch { error = null; } }, TRANSACTION_TIMEOUT_MS);
    transaction.oncomplete = () => { clearTimeout(timer); transactions.delete(transaction); resolve(value); };
    transaction.onabort = transaction.onerror = (event) => { clearTimeout(timer); transactions.delete(transaction); reject(error || event.target?.error || transaction.error || new Error("Could not save to local storage.")); };
    try { operation(transaction.objectStore(name), (result) => { value = result; }); }
    catch (cause) { error = cause; transaction.abort(); }
  });
}

const WRITE_ATTEMPTS = 3;
const RETRY_DELAY_MS = 200;
const failedWrites = new Map();
let reclaiming = null;

function reportStorageError(error, scope = "sessions") {
  if (isWiping()) return;
  window.dispatchEvent(new CustomEvent("eco-storage-error", { detail: { name: error?.name || "Error", scope } }));
}

async function reclaimSpace() {
  navigator.storage?.persist?.().catch(() => {});
  const sessions = await all("sessions");
  for (const session of sessions.sort((a, b) => a.updatedAt - b.updatedAt)) {
    await transact("sessions", "readwrite", table => {
      const request = table.get(session.id);
      request.onsuccess = () => { if (request.result) table.put(sessionSnapshot(request.result, true)); };
    });
  }
}

export function retryFailedWrites() {
  return Promise.all([...failedWrites.values()].map(({ name, value }) => store(name, value)));
}

export function store(name, value) {
  const snapshot = name === "sessions" ? sessionSnapshot(value) : structuredClone(value);
  const id = name + ":" + snapshot.id;
  const write = (async () => {
    let failure;
    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
      try {
        const result = await transact(name, "readwrite", (table, done) => { table.put(snapshot); done(snapshot); });
        failedWrites.delete(id);
        if (!failedWrites.size) window.dispatchEvent(new CustomEvent("eco-storage-saved", { detail: { scope: name } }));
        return result;
      } catch (error) {
        failure = error;
        if (error.name === "InvalidStateError") {
          const previous = databasePromise;
          databasePromise = null;
          previous?.then(database => database.close()).catch(() => {});
        }
        if (isWiping() || error.name === "DataCloneError") break;
        if (error.name === "QuotaExceededError") {
          try {
            reclaiming ||= reclaimSpace().finally(() => { reclaiming = null; });
            await reclaiming;
            if (name === "sessions") Object.assign(snapshot, sessionSnapshot(snapshot, true));
          } catch {}
        }
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * (attempt + 1)));
      }
    }
    if (!isWiping()) failedWrites.set(id, { name, value: snapshot });
    reportStorageError(failure, name);
    throw failure;
  })();
  pendingWrites.add(write);
  write.finally(() => pendingWrites.delete(write)).catch(() => {});
  return write;
}

export function insertIfMissing(name, value) {
  return transact(name, "readwrite", (table, done) => {
    const request = table.get(value.id);
    request.onsuccess = () => {
      if (request.result) done(request.result);
      else { table.put(value); done(value); }
    };
  });
}

export function all(name) {
  return transact(name, "readonly", (table, done) => {
    const request = table.getAll();
    request.onsuccess = () => done(request.result);
  });
}

export function get(name, id) {
  return transact(name, "readonly", (table, done) => {
    const request = table.get(id);
    request.onsuccess = () => done(request.result || null);
  });
}

export function remove(name, id) {
  return transact(name, "readwrite", (table) => table.delete(id));
}

export function flushWrites() {
  return Promise.allSettled([...pendingWrites]);
}
