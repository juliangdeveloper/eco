import { DATABASE_NAME, STORAGE_PREFIX } from "./config.js";

const DATABASE_VERSION = 1;
const STORES = ["sessions", "skills"];

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

export function db() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      for (const name of STORES) {
        if (!request.result.objectStoreNames.contains(name)) {
          request.result.createObjectStore(name, { keyPath: "id" });
        }
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function store(name, value) {
  const database = await db();
  return new Promise((resolve, reject) => {
    const request = database.transaction(name, "readwrite").objectStore(name).put(value);
    request.onsuccess = () => resolve(value);
    request.onerror = () => reject(request.error);
  });
}

export async function all(name) {
  const database = await db();
  return new Promise((resolve, reject) => {
    const request = database.transaction(name).objectStore(name).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function remove(name, id) {
  const database = await db();
  return new Promise((resolve, reject) => {
    const request = database.transaction(name, "readwrite").objectStore(name).delete(id);
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
  });
}
