const DENIED_ROOTS = new Set(["window", "self", "globalThis", "top", "parent", "frames", "document", "location", "history", "localStorage", "sessionStorage", "indexedDB", "caches", "cookieStore", "crypto", "credentials", "Function", "eval", "Worker", "SharedWorker", "ServiceWorker", "ServiceWorkerContainer", "XMLHttpRequest", "WebSocket", "EventSource", "BroadcastChannel", "MessageChannel", "MessagePort", "SharedArrayBuffer", "Atomics", "chrome", "safari", "clientInformation", "external", "navigation", "customElements", "open", "close", "print", "alert", "prompt", "confirm", "fetch", "importScripts", "postMessage", "reportError", "queueMicrotask", "setTimeout", "setInterval", "clearTimeout", "clearInterval", "requestAnimationFrame", "cancelAnimationFrame", "opener", "frameElement", "event", "closed", "origin", "isSecureContext", "scheduler", "trustedTypes", "caches", "webkitStorageInfo", "webkitRequestFileSystem"]);
const DENIED_NAVIGATOR = new Set(["credentials", "serviceWorker", "storage", "locks", "login", "mediaSession"]);
export const SAFE_EVENTS = Object.freeze(["start", "end", "error", "result", "nomatch", "audiostart", "audioend", "soundstart", "soundend", "speechstart", "speechend", "voiceschanged", "boundary", "mark", "pause", "resume", "ended", "mute", "unmute", "devicechange", "reading", "readingerror", "stop", "change", "load", "loaded", "close", "open", "success", "complete", "finish", "update", "addtrack", "removetrack"]);

function blockedValue(value) {
  if (value == null) return true;
  if (value === window || value === document || value === location || value === history) return true;
  if (typeof Node !== "undefined" && value instanceof Node) return true;
  if (typeof Window !== "undefined" && value instanceof Window) return true;
  if (typeof Storage !== "undefined" && value instanceof Storage) return true;
  if (typeof Crypto !== "undefined" && value instanceof Crypto) return true;
  if (typeof Location !== "undefined" && value instanceof Location) return true;
  return false;
}

export function isSafeBrowserPath(path) {
  if (typeof path !== "string" || path.length > 200) return false;
  const parts = path.split(".");
  const root = parts[0];
  if (!root || DENIED_ROOTS.has(root)) return false;
  if (root === "navigator") {
    if (!parts[1] || DENIED_NAVIGATOR.has(parts[1])) return false;
  }
  return true;
}

export function browserFeature(path) {
  const root = String(path || "").split(".")[0];
  return { name: "browser", path: root, policies: [], events: SAFE_EVENTS };
}

export function listSafeCapabilities(scope = typeof window !== "undefined" ? window : {}) {
  const found = [];
  const seen = new Set();
  const add = (name, value) => {
    if (seen.has(name) || !/^[A-Za-z][A-Za-z0-9]*$/.test(name) || DENIED_ROOTS.has(name) || blockedValue(value)) return;
    seen.add(name);
    found.push({ path: name, available: true, type: typeof value === "function" ? "constructor" : "object" });
  };
  try {
    for (const name of Object.getOwnPropertyNames(scope)) {
      try { add(name, scope[name]); } catch {}
    }
  } catch {}
  for (const name of ["speechSynthesis", "SpeechSynthesisUtterance", "SpeechRecognition", "webkitSpeechRecognition", "SpeechGrammarList", "webkitSpeechGrammarList", "AudioContext", "webkitAudioContext"]) {
    try { if (name in scope && scope[name] != null) add(name, scope[name]); } catch {}
  }
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

export function speechRecognitionCtor(scope = typeof window !== "undefined" ? window : {}) {
  return scope.SpeechRecognition || scope.webkitSpeechRecognition || null;
}

export function encodeSpeechEvent(value) {
  if (!value || typeof value !== "object" || !value.results || typeof value.results.length !== "number") return null;
  const results = [];
  for (let index = 0; index < value.results.length; index++) {
    const row = value.results[index];
    const alternatives = [];
    const count = row.length || 0;
    for (let alt = 0; alt < count; alt++) alternatives.push({ transcript: String(row[alt]?.transcript || ""), confidence: Number(row[alt]?.confidence) || 0 });
    results.push({ isFinal: Boolean(row.isFinal), alternatives });
  }
  return { type: String(value.type || "result"), resultIndex: Number(value.resultIndex) || 0, results };
}
