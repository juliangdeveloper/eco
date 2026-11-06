import { all, remove, store } from "./storage.js";

const KEYS_STORE = "keys";
const SECRETS_STORE = "secrets";
const VAULT_KEY_ID = "vault";
const CIPHER = "AES-GCM";
const KEY_LENGTH = 256;
const IV_BYTES = 12;

let keyPromise = null;

async function findRecord(storeName, id) {
  const rows = await all(storeName);
  return rows.find((row) => row.id === id) || null;
}

async function createKey() {
  const existing = await findRecord(KEYS_STORE, VAULT_KEY_ID);
  if (existing && existing.key) {
    return existing.key;
  }
  const key = await crypto.subtle.generateKey({ name: CIPHER, length: KEY_LENGTH }, false, ["encrypt", "decrypt"]);
  await store(KEYS_STORE, { id: VAULT_KEY_ID, key });
  return key;
}

export function getKey() {
  if (!keyPromise) {
    keyPromise = createKey().catch((error) => {
      keyPromise = null;
      throw error;
    });
  }
  return keyPromise;
}

export async function saveSecret(connectorId, value) {
  const key = await getKey();
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const plain = new TextEncoder().encode(JSON.stringify(value));
  const data = await crypto.subtle.encrypt({ name: CIPHER, iv }, key, plain);
  await store(SECRETS_STORE, { id: connectorId, iv, data, updatedAt: Date.now() });
}

export async function readSecret(connectorId) {
  const record = await findRecord(SECRETS_STORE, connectorId);
  if (!record) {
    return null;
  }
  try {
    const key = await getKey();
    const plain = await crypto.subtle.decrypt({ name: CIPHER, iv: record.iv }, key, record.data);
    return JSON.parse(new TextDecoder().decode(plain));
  } catch {
    return null;
  }
}

export async function hasSecret(connectorId) {
  return Boolean(await findRecord(SECRETS_STORE, connectorId));
}

export async function deleteSecret(connectorId) {
  await remove(SECRETS_STORE, connectorId);
}
