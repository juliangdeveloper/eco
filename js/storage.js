import { DATABASE_NAME, STORAGE_PREFIX } from "./config.js";

const DATABASE_VERSION = 4;
const STORES = ["sessions", "skills", "connectors", "secrets", "keys", "routines", "deviceTools"];

const key = (name) => STORAGE_PREFIX + name;

export function setting(name, value) {
  if (value === undefined) return localStorage.getItem(key(name)) || "";
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
  localStorage.setItem(key(name), JSON.stringify(value));
  return value;
}

const OPEN_TIMEOUT_MS = 8000;
const TRANSACTION_TIMEOUT_MS = 12000;
let databasePromise = null;
const pendingWrites = new Set();

export function closeDatabase() {
  const pending = databasePromise;
  databasePromise = null;
  pending?.then((database) => database.close()).catch(() => {});
}

export function db() {
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
    const timer = setTimeout(() => fail("No se pudo abrir el almacenamiento. Cierra otras pestañas de Eco y vuelve a intentar."), OPEN_TIMEOUT_MS);
    request.onupgradeneeded = () => {
      for (const name of STORES) {
        if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, { keyPath: "id" });
      }
    };
    request.onblocked = () => fail("Otra pestaña de Eco bloquea el almacenamiento. Ciérrala y vuelve a intentar.");
    request.onsuccess = () => {
      const database = request.result;
      if (finished) { database.close(); return; }
      finished = true;
      clearTimeout(timer);
      database.onversionchange = () => { database.close(); databasePromise = null; };
      database.onclose = () => { databasePromise = null; };
      resolve(database);
    };
    request.onerror = () => fail("No se pudo abrir el almacenamiento local.");
  });
  return databasePromise;
}

async function transact(name, mode, operation) {
  const database = await db();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(name, mode);
    let value;
    let error;
    const timer = setTimeout(() => { error = new Error("El almacenamiento no responde. Tus mensajes pendientes se conservan para recuperarlos."); transaction.abort(); }, TRANSACTION_TIMEOUT_MS);
    transaction.oncomplete = () => { clearTimeout(timer); resolve(value); };
    transaction.onabort = transaction.onerror = () => { clearTimeout(timer); reject(error || new Error("No se pudo guardar en el almacenamiento local.")); };
    operation(transaction.objectStore(name), (result) => { value = result; });
  });
}

export function store(name, value) {
  const snapshot = structuredClone(value);
  const write = transact(name, "readwrite", (table, done) => { table.put(snapshot); done(snapshot); });
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

export function remove(name, id) {
  return transact(name, "readwrite", (table) => table.delete(id));
}

export function flushWrites() {
  return Promise.allSettled([...pendingWrites]);
}
