import { APP_VERSION } from "./config.js";
import { isWiping, memoryConfigured } from "./security.js";
import { json } from "./storage.js";

export const HELP_DEDUPE_MS = 60 * 60 * 1000;
export const HELP_THREAD = "h-help";
export const HELP_RETRIES = 3;
const SKIP = new Set(["tap to continue."]);
const SECRET = /(?:sk-[\w-]{8,}|AIza[\w-]{20,}|ya29\.[\w.-]+|gh[pousr]_[\w]+|github_pat_[\w]+|eyJ[\w-]+\.[\w-]+\.[\w-]+|Bearer\s+\S+|(?:api[_ -]?key|token|secret|password|contraseña|clave)\s*[:=]\s*[^\n,;]+)/gi;
const inflight = new Map();
const pendingIds = new Map();

export function foldHelp(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

export function sanitizeHelpText(value) {
  return String(value || "").replace(SECRET, "[hidden]").replace(/https?:\/\/[^\s]+/gi, (url) => {
    try {
      const parsed = new URL(url);
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString();
    } catch {
      return "[link]";
    }
  }).replace(/\s+/g, " ").trim();
}

export function browserSummary(source = typeof navigator === "undefined" ? {} : navigator) {
  const ua = String(source.userAgent || "");
  const hints = source.userAgentData;
  let browser = "";
  let version = "";
  const brands = hints?.brands || hints?.uaList || [];
  const brand = brands.find((item) => item && !/Not.?A.?Brand/i.test(item.brand));
  if (brand?.brand) {
    browser = brand.brand;
    version = String(brand.version || "");
  } else if (/CriOS\/([\d.]+)/.test(ua)) { browser = "Chrome"; version = RegExp.$1; }
  else if (/FxiOS\/([\d.]+)/.test(ua)) { browser = "Firefox"; version = RegExp.$1; }
  else if (/EdgiOS\/([\d.]+)/.test(ua)) { browser = "Edge"; version = RegExp.$1; }
  else if (/OPiOS\/([\d.]+)/.test(ua)) { browser = "Opera"; version = RegExp.$1; }
  else if (/Edg\/([\d.]+)/.test(ua)) { browser = "Edge"; version = RegExp.$1; }
  else if (/Chrome\/([\d.]+)/.test(ua) && !/Chromium/.test(ua)) { browser = "Chrome"; version = RegExp.$1; }
  else if (/Firefox\/([\d.]+)/.test(ua)) { browser = "Firefox"; version = RegExp.$1; }
  else if (/Version\/([\d.]+).*Safari/.test(ua)) { browser = "Safari"; version = RegExp.$1; }
  else if (/Safari\//.test(ua)) browser = "Safari";
  let os = String(hints?.platform || "");
  if (!os || /^unknown$/i.test(os)) {
    if (/iPad/.test(ua) || (source.platform === "MacIntel" && (source.maxTouchPoints || 0) > 1)) os = "iPadOS";
    else if (/iPhone|iPod/.test(ua)) os = "iOS";
    else if (/Mac OS X|Macintosh/.test(ua)) os = "macOS";
    else if (/Android/.test(ua)) os = "Android";
    else if (/Windows/.test(ua)) os = "Windows";
    else if (/Linux/.test(ua) || source.platform === "Linux") os = "Linux";
  }
  const major = version.split(".")[0];
  return [browser ? browser + (major ? " " + major : "") : "", os].filter(Boolean).join(" / ") || "unknown browser";
}

export function helpContent(notice, version = APP_VERSION, summary = browserSummary()) {
  return "Eco " + version + " · " + summary + "\n" + notice;
}

export function shouldReportHelp(notice, reports = {}, now = Date.now()) {
  const key = foldHelp(notice);
  if (!key || SKIP.has(key)) return false;
  const last = Number(reports[key]);
  return !Number.isFinite(last) || now - last >= HELP_DEDUPE_MS;
}

function rememberHelp(notice, now = Date.now()) {
  const reports = json("helpReports") || {};
  const key = foldHelp(notice);
  reports[key] = now;
  for (const [item, at] of Object.entries(reports)) if (!Number.isFinite(Number(at)) || now - Number(at) >= HELP_DEDUPE_MS) delete reports[item];
  reports[key] = now;
  json("helpReports", reports);
  return reports;
}

export function helpSaved(result) {
  return Boolean(result && !result.error && (result.ok || result.id) && !result.en_cola);
}

async function defaultHelpSave(payload) {
  const { memoryCall } = await import("./passive-skills.js");
  return memoryCall("guardar", payload);
}

export async function sendHelpRecord(notice, save = defaultHelpSave, pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  const key = foldHelp(notice);
  const id = pendingIds.get(key) || (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : "00000000-0000-4000-8000-000000000000");
  pendingIds.set(key, id);
  const payload = { id, type: "help", to: "todos", thread: HELP_THREAD, tags: "help", content: helpContent(notice) };
  for (let attempt = 1; attempt <= HELP_RETRIES; attempt++) {
    try {
      const result = await save(payload);
      if (helpSaved(result)) {
        rememberHelp(notice);
        pendingIds.delete(key);
        return true;
      }
      throw new Error(result?.error || result?.aviso || "Help record was not saved.");
    } catch {
      if (attempt >= HELP_RETRIES) return false;
      await pause(400 * attempt);
    }
  }
  return false;
}

export function requestHelp(text, save, pause) {
  const notice = sanitizeHelpText(text);
  if (!shouldReportHelp(notice, json("helpReports") || {})) return Promise.resolve(false);
  try { if (isWiping() || !memoryConfigured()) return Promise.resolve(false); } catch { return Promise.resolve(false); }
  const key = foldHelp(notice);
  if (inflight.has(key)) return inflight.get(key);
  const job = sendHelpRecord(notice, save || defaultHelpSave, pause).finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}
