import { json, setting } from "./storage.js";

const GRANTS_KEY = "deviceGrants";
const MAX_GRANTS = 24;

export async function deviceGrantIdentity(tool) {
  let device = setting("deviceId");
  if (!device) device = setting("deviceId", crypto.randomUUID());
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(tool.code));
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  return { id: JSON.stringify([device, tool.name, hash]), device, name: tool.name, hash };
}

export function listDeviceGrants() {
  const rows = json(GRANTS_KEY);
  return Array.isArray(rows) ? rows.filter(row => row?.device === setting("deviceId") && typeof row.id === "string" && typeof row.name === "string") : [];
}

export function hasDeviceGrant(identity) {
  return listDeviceGrants().some(row => row.id === identity.id);
}

export function allowDeviceGrant(identity) {
  const rows = listDeviceGrants().filter(row => row.name !== identity.name);
  json(GRANTS_KEY, [...rows, identity].slice(-MAX_GRANTS));
  window.dispatchEvent(new Event("eco-device-grants"));
}

export function revokeDeviceGrant(id) {
  json(GRANTS_KEY, listDeviceGrants().filter(row => row.id !== id));
  window.dispatchEvent(new Event("eco-device-grants"));
}

export function forgetDeviceGrants(name) {
  json(GRANTS_KEY, listDeviceGrants().filter(row => row.name !== name));
  window.dispatchEvent(new Event("eco-device-grants"));
}
