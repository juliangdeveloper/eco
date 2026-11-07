import { APP_VERSION } from "./config.js";
import { all, json, remove, store } from "./storage.js";
import { isWiping } from "./security.js";

const MARKER_KEY = "reloadResume";
const OWNER_KEY = "eco.reloadOwner";
const HISTORY_KEY = "reloadHistory";
const MIN_RELOAD_INTERVAL_MS = 60000;
const RELOAD_WINDOW_MS = 600000;
const MAX_RELOADS_PER_WINDOW = 3;
const RESUME_TTL_MS = 1800000;
const SW_WAIT_MS = 10000;
const MAX_REASON_CHARS = 500;
let api;
let reloading = false;

export function reloadPending() { return reloading; }

export async function resumeMarker() {
  const marker = (await all("state")).find(row => row.id === MARKER_KEY)?.value || json(MARKER_KEY);
  if (!marker || marker.owner !== sessionStorage.getItem(OWNER_KEY)) return null;
  if (Date.now() - marker.createdAt > RESUME_TTL_MS) {
    await clearResumeMarker();
    return null;
  }
  return marker;
}

export async function clearResumeMarker() {
  await remove("state", MARKER_KEY);
  localStorage.removeItem("eco." + MARKER_KEY);
  sessionStorage.removeItem(OWNER_KEY);
}

export function setupReload(options) { api = options; }

export function prepareReload(args = {}) {
  if (isWiping() || reloading) return { ok: false, error: "Eco no puede recargarse ahora." };
  const now = Date.now();
  const history = (json(HISTORY_KEY) || []).filter((stamp) => now - stamp < RELOAD_WINDOW_MS);
  if (history.length >= MAX_RELOADS_PER_WINDOW || history.some((stamp) => now - stamp < MIN_RELOAD_INTERVAL_MS)) {
    return { ok: false, error: "Límite de recargas: espera al menos un minuto; máximo tres cada diez minutos.", retry_after_ms: Math.max(MIN_RELOAD_INTERVAL_MS - (now - (history.at(-1) || 0)), history.length >= MAX_RELOADS_PER_WINDOW ? RELOAD_WINDOW_MS - (now - history[0]) : 0) };
  }
  return { ok: true, reload: true, motivo: String(args.motivo || "Actualizar Eco").slice(0, MAX_REASON_CHARS) };
}

async function applyWorker() {
  const registration = await navigator.serviceWorker?.getRegistration();
  if (!registration) return;
  await registration.update().catch(() => {});
  const worker = registration.installing || registration.waiting;
  if (!worker || worker.state === "activated" || worker.state === "redundant") return;
  await new Promise((resolve, reject) => {
    const finish = () => {
      if (!["activated", "redundant"].includes(worker.state)) return;
      clearTimeout(timer);
      worker.removeEventListener("statechange", finish);
      resolve();
    };
    const timer = setTimeout(() => {
      worker.removeEventListener("statechange", finish);
      reject(new Error("La actualización todavía no está lista. Inténtalo después."));
    }, SW_WAIT_MS);
    worker.addEventListener("statechange", finish);
    worker.postMessage({ type: "eco-activate" });
    finish();
  });
}

export async function commitReload(raw) {
  const args = typeof raw === "string" ? JSON.parse(raw) : raw;
  const check = prepareReload(args);
  if (!check.ok) throw new Error(check.error);
  reloading = true;
  try {
    await applyWorker();
    if (isWiping()) return;
    const marker = await api.checkpoint(check.motivo);
    const owner = crypto.randomUUID();
    sessionStorage.setItem(OWNER_KEY, owner);
    await store("state", { id: MARKER_KEY, value: { ...marker, owner, before: APP_VERSION, reason: check.motivo, createdAt: Date.now() } });
    const now = Date.now();
    json(HISTORY_KEY, [...(json(HISTORY_KEY) || []).filter((stamp) => now - stamp < RELOAD_WINDOW_MS), now]);
    api.stop();
    const target = new URL(location.href);
    target.searchParams.set("eco_reload", String(now));
    location.replace(target.href);
    await new Promise(() => {});
  } catch (error) {
    reloading = false;
    await clearResumeMarker();
    throw error;
  }
}
