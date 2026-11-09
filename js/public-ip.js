import { timedFetch } from "./network.js";

export const IP_ENDPOINTS = Object.freeze(["https://api.ipify.org?format=json", "https://api64.ipify.org?format=json", "https://icanhazip.com"]);
const LOOKUP_TIMEOUT_MS = 4000;
const CACHE_MS = 60 * 1000;
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const IPV6 = /^(?=.*:)[0-9a-f:.]{2,45}$/i;
let cached = null;
let pending = null;

export const validIp = value => typeof value === "string" && (IPV4.test(value) || IPV6.test(value) && value.split("::").length <= 2);

async function lookup(url) {
  const response = await timedFetch(url, { cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });
  if (!response.ok) throw new Error("HTTP " + response.status);
  const text = (await response.text()).trim();
  let value = text;
  if (text.startsWith("{")) value = String(JSON.parse(text).ip || "").trim();
  if (!validIp(value)) throw new Error("Invalid IP");
  return value;
}

export async function publicIp(force = false) {
  if (!force && cached && Date.now() - cached.at < CACHE_MS) return { ip: cached.ip, source: cached.source };
  if (pending) return pending;
  pending = (async () => {
    for (const url of IP_ENDPOINTS) {
      try {
        const ip = await lookup(url);
        const source = new URL(url).host;
        cached = { ip, source, at: Date.now() };
        return { ip, source };
      } catch {}
    }
    return { ip: "", source: "" };
  })().finally(() => { pending = null; });
  return pending;
}
