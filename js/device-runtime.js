import { isWiping } from "./security.js";
import { featureDefinitions, featureValue, policyState } from "./environment.js";
import { sandboxDocument } from "./device-sandbox.js";

const MAX_BYTES = 131072;
const STARTUP_TIMEOUT_MS = 5000;
const BROWSER_RESPONSE_TIMEOUT_MS = 20000;
const MAX_PHOTO_DIMENSION = 640;
const MAX_PHOTO_BYTES = 96000;
const PHOTO_QUALITY = 0.8;
const PHOTO_SCALE = 0.75;
const FRAME_TIMEOUT_MS = 10000;
const FRAME_SETTLE_MS = 300;
const ACTIVATION_METHODS = new Set(["requestDevice", "requestPort", "requestPermission", "requestFullscreen", "showOpenFilePicker", "showSaveFilePicker", "showDirectoryPicker"]);
const ACTIVATION_FEATURES = new Set(["nfc"]);
const STORAGE_READ_METHODS = new Set(["estimate", "persisted"]);
const executions = new Set();
const normalizeArgs = args => args === undefined ? [] : Array.isArray(args) ? args : [args];
const CALL_SIGNATURE = "Use device.call(path, [args])";
const BLOCKED_ERRORS = new Set(["NotAllowedError", "SecurityError"]);
const DENIED_MESSAGE = "The browser is blocking access to: ";
const DENIED_HELP = ". Allow it for this site in Settings > Safari > Camera or Microphone (or from the aA icon in the address bar) and try again.";
const PERMISSION_LABELS = { camera: "camera", microphone: "microphone", geolocation: "location" };

export function stopDeviceTools() {
  for (const stop of executions) { try { stop(); } catch {} }
  executions.clear();
}
const forbidden = new Set(["composedPath", "watchPosition", "addEventListener", "removeEventListener", "dispatchEvent", "constructor", "prototype", "__proto__", "caller", "callee", "arguments", "call", "apply", "bind", "eval", "valueOf", "toString", "toLocaleString", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable", "window", "parent", "top", "self", "globalThis", "document", "ownerDocument", "defaultView", "source", "ports", "view", "target", "currentTarget", "srcElement", "path"]);
const bytes = value => new TextEncoder().encode(JSON.stringify(value)).length;
const validPart = value => /^[A-Za-z][A-Za-z0-9]*$/.test(value) && !forbidden.has(value);

export async function executeDeviceTool(tool, params, signal) {
  if (isWiping()) return { ok: false, error: "Access cancelled" };
  if (isWiping()) return Promise.resolve({ ok: false, error: "Access cancelled" });
  return new Promise((resolve) => {
    const frame = document.createElement("iframe");
    frame.hidden = true;
    frame.sandbox = "allow-scripts";
    frame.setAttribute("aria-hidden", "true");
    const channel = new MessageChannel();
    const handles = new Map();
    const cards = new Set();
    const cleanups = new Set();
    let settled = false;
    let operations = 0;
    let started = false;
    const requestIds = new Set();
    let handleIndex = 0;
    const features = featureDefinitions();
    frame.allow = [...new Set(features.flatMap(entry => entry.policies))].filter(name => policyState(name) !== "unknown").map(name => name + " 'none'").join("; ");
    const stopObject = (value, feature) => {
      try {
        if (feature?.cleanupChildren && typeof value?.[feature.cleanupChildren] === "function") value[feature.cleanupChildren]().forEach(child => stopObject(child));
        else for (const method of ["stop", "cancel", "releaseLock", "release", "disconnect", "close"]) {
          if (typeof value?.[method] === "function") {
            try { Promise.resolve(value[method]()).catch(() => {}); } catch {}
          }
        }
      } catch {}
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      executions.delete(abort);
      clearTimeout(timer);
      clearTimeout(startupTimer);
      signal?.removeEventListener("abort", abort);
      for (const cleanup of cleanups) cleanup();
      for (const card of cards) card.remove();
      const panel = document.getElementById("deviceRequests");
      if (!panel.children.length && panel.open) panel.close();
      for (const { value, feature } of [...handles.values()].reverse()) stopObject(value, feature);
      channel.port1.postMessage({ kind: "stop" });
      channel.port1.close();
      frame.remove();
      resolve({ untrusted: true, ...result });
    };
    const abort = () => finish({ ok: false, error: "Device access cancelled" });
    const startupTimer = setTimeout(() => finish({ ok: false, error: "The isolated tool could not start in this browser. Update Safari and try again." }), STARTUP_TIMEOUT_MS);
    const timer = setTimeout(() => finish({ ok: false, error: cards.size ? "Device access has not been authorized yet. Authorize it and try again." : "The device tool did not finish. Try again." }), Math.min(60000, Math.max(1000, tool.timeout_ms || 30000)));
    executions.add(abort);
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener("abort", abort, { once: true });

    function encode(value, feature, depth = 0, seen = new Set()) {
      if (value === null || value === undefined) return null;
      if (["string", "number", "boolean"].includes(typeof value)) return value;
      if (value === window || value === document || value === navigator || value === localStorage || value === indexedDB || value === crypto || value instanceof Node || value instanceof Window || value instanceof Storage || typeof CryptoKey !== "undefined" && value instanceof CryptoKey) throw new Error("Object outside the allowed capabilities");
      if (typeof value !== "object" || depth > 8) throw new Error("Result is not serializable");
      if (seen.has(value)) return null;
      seen.add(value);
      if (ArrayBuffer.isView(value)) return { $bytes: Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) };
      if (value instanceof ArrayBuffer) return { $bytes: Array.from(new Uint8Array(value)) };
      if (Array.isArray(value)) return value.map(item => encode(item, feature, depth + 1, new Set(seen)));
      const prototype = Object.getPrototypeOf(value);
      if (prototype === Object.prototype || prototype === null) return Object.fromEntries(Object.entries(value).filter(([key]) => validPart(key)).map(([key, item]) => [key, encode(item, feature, depth + 1, new Set(seen))]));
      if (typeof value.toJSON === "function") return encode(value.toJSON(), feature, depth + 1, new Set(seen));
      let current = prototype;
      const fields = new Set();
      let methods = false;
      while (current && current !== Object.prototype) {
        for (const name of Object.getOwnPropertyNames(current)) {
          if (!validPart(name)) continue;
          const property = Object.getOwnPropertyDescriptor(current, name);
          if (typeof property.value === "function") methods = true;
          else fields.add(name);
        }
        current = Object.getPrototypeOf(current);
      }
      if (!methods && fields.size) return Object.fromEntries([...fields].map(name => [name, encode(value[name], feature, depth + 1, new Set(seen))]));
      let id = [...handles].find(([, entry]) => entry.value === value)?.[0];
      if (!id) { id = "h" + (++handleIndex); handles.set(id, { value, feature }); }
      return { $handle: id, type: prototype?.constructor?.name || "Object" };
    }

    function decode(value, done, fail, depth = 0) {
      if (depth > 10) throw new Error("Parameters nested too deeply");
      if (!value || typeof value !== "object") return value;
      if (value.$handle) {
        if (!handles.has(value.$handle)) throw new Error("Reference not available");
        return handles.get(value.$handle).value;
      }
      if (value.$callback) {
        if (!["resolve", "reject"].includes(value.$callback)) throw new Error("Invalid callback");
        return value.$callback === "resolve" ? done : fail;
      }
      if (value.$bytes) return new Uint8Array(value.$bytes);
      if (Array.isArray(value)) return value.map(item => decode(item, done, fail, depth + 1));
      return Object.fromEntries(Object.entries(value).map(([key, item]) => {
        if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error("Parameter not allowed");
        return [key, decode(item, done, fail, depth + 1)];
      }));
    }

    function locate(path) {
      if (typeof path !== "string" || path.length > 200) throw new Error("path must be text of up to 200 characters. " + CALL_SIGNATURE);
      const parts = path.split(".");
      let feature, value, remaining;
      if (parts[0] === "handles") {
        const entry = handles.get(parts[1]);
        if (!entry) throw new Error("Reference not available in this run");
        ({ value, feature } = entry);
        remaining = parts.slice(2);
      } else {
        feature = features.find(entry => path === entry.path || path.startsWith(entry.path + "."));
        if (!feature) throw new Error("Path outside the allowed capabilities");
        value = featureValue(feature.path);
        remaining = parts.slice(feature.path.split(".").length);
      }
      if (value === undefined || value === null) throw new Error("This API is not available in this browser");
      let owner = window;
      if (!remaining.length && feature.path.startsWith("navigator.")) owner = navigator;
      for (const part of remaining) {
        if (!validPart(part)) throw new Error("Member not allowed");
        if (typeof value === "function" && value !== featureValue(feature.path)) throw new Error("Functions cannot be traversed");
        owner = value;
        value = value[part];
      }
      return { value, owner, feature };
    }

    function invoke(message, cancelled) {
      return new Promise((done, fail) => {
        const entry = locate(message.path);
        const respond = value => {
          if (settled || cancelled()) { stopObject(value, entry.feature); return; }
          try { done(encode(value, entry.feature)); } catch (error) { fail(error); }
        };
        const reject = error => {
          const wrapped = new Error(String(error?.message || error?.name || error || "Permission denied"));
          if (error?.name) wrapped.name = error.name;
          fail(wrapped);
        };
        if (entry.feature.name === "storage" && message.kind !== "get" && !STORAGE_READ_METHODS.has(message.path.split(".").pop())) throw new Error("Only querying storage space is allowed");
        const args = decode(message.args, respond, reject);
        if (message.kind === "capture") {
          if (!(entry.value instanceof MediaStream)) throw new Error("device.capture needs a reference to a MediaStream from this run");
          captureFrame(entry.value, args[0]).then(respond, reject);
          return;
        }
        if (message.kind === "get") { respond(entry.value); return; }
        if (message.kind === "listen") {
          const event = args[0];
          if (!entry.feature.events.includes(event)) throw new Error("Event not allowed for this capability");
          const target = entry.feature.eventTarget === "window" ? window : entry.value;
          if (!target?.addEventListener) throw new Error("This capability does not support events");
          const listener = value => { cleanup(); respond(value); };
          const cleanup = () => { target.removeEventListener(event, listener); cleanups.delete(cleanup); };
          cleanups.add(cleanup);
          target.addEventListener(event, listener, { once: true });
          return;
        }
        if (typeof entry.value !== "function") throw new Error("The method does not exist in this browser");
        if (message.kind === "construct" && message.path !== entry.feature.path) throw new Error("Constructor not allowed");
        const result = message.kind === "construct" ? Reflect.construct(entry.value, args) : Reflect.apply(entry.value, entry.owner, args);
        const callbacks = JSON.stringify(message.args).includes('"$callback"');
        if (result?.then) result.then(respond, reject);
        else if (!callbacks) respond(result);
      });
    }

    async function captureFrame(stream, options = {}) {
      const video = document.createElement("video");
      video.muted = true;
      video.autoplay = true;
      video.playsInline = true;
      video.setAttribute("aria-hidden", "true");
      video.style.cssText = "position:fixed;width:2px;height:2px;opacity:0;pointer-events:none;bottom:0;left:0";
      let frameTimer;
      let failFrame;
      const cleanup = () => {
        clearTimeout(frameTimer);
        video.pause();
        video.srcObject = null;
        video.remove();
        stream.getTracks().forEach(track => track.stop());
        failFrame?.(new Error("Capture cancelled"));
      };
      cleanups.add(cleanup);
      try {
        if (!stream.getVideoTracks().some(track => track.readyState === "live")) throw new Error("The stream has no active camera");
        video.srcObject = stream;
        document.body.append(video);
        video.setAttribute("playsinline", "");
        video.setAttribute("muted", "");
        await new Promise((resolve, reject) => {
          failFrame = reject;
          frameTimer = setTimeout(() => reject(new Error("The camera did not deliver an image")), FRAME_TIMEOUT_MS);
          video.onerror = () => reject(new Error("Could not read the camera image"));
          const ready = () => {
            if (!video.videoWidth || !video.videoHeight) return;
            if (typeof video.requestVideoFrameCallback === "function") video.requestVideoFrameCallback(() => resolve());
            else setTimeout(resolve, FRAME_SETTLE_MS);
          };
          const start = () => video.play().then(ready, reject);
          if (video.readyState >= HTMLMediaElement.HAVE_METADATA) start();
          else video.onloadedmetadata = start;
        });
        clearTimeout(frameTimer);
        if (settled) throw new Error("Capture cancelled");
        const requested = Number(options?.maxDimension);
        const maximum = Number.isFinite(requested) && requested > 0 ? Math.min(MAX_PHOTO_DIMENSION, requested) : MAX_PHOTO_DIMENSION;
        const scale = Math.min(1, maximum / Math.max(video.videoWidth, video.videoHeight));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Could not prepare the photo");
        let dataUrl;
        do {
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          dataUrl = canvas.toDataURL("image/jpeg", PHOTO_QUALITY);
          if (dataUrl.length <= MAX_PHOTO_BYTES) break;
          canvas.width = Math.max(1, Math.floor(canvas.width * PHOTO_SCALE));
          canvas.height = Math.max(1, Math.floor(canvas.height * PHOTO_SCALE));
        } while (canvas.width > 1 && canvas.height > 1);
        if (!dataUrl.startsWith("data:image/jpeg;base64,") || dataUrl.length > MAX_PHOTO_BYTES) throw new Error("Could not compress the photo");
        return { dataUrl, mimeType: "image/jpeg", width: canvas.width, height: canvas.height };
      } finally {
        cleanups.delete(cleanup);
        cleanup();
      }
    }

    function canRunWithoutTap(message) {
      const entry = locate(message.path);
      const method = message.path.split(".").pop();
      if (message.kind === "get" || message.kind === "capture") return true;
      return !ACTIVATION_METHODS.has(method) && !ACTIVATION_FEATURES.has(entry.feature.name);
    }

    function browserPermissions(message) {
      const method = message.path.split(".").pop();
      if (method === "getUserMedia") {
        const constraints = decode(message.args, null, null)[0] || {};
        return [constraints.video && "camera", constraints.audio && "microphone"].filter(Boolean);
      }
      if (message.path.startsWith("navigator.geolocation") && method === "getCurrentPosition") return ["geolocation"];
      return [];
    }

    async function permissionState(name) {
      try { return (await navigator.permissions.query({ name })).state; } catch { return "unknown"; }
    }

    async function deniedError(needs) {
      const states = await Promise.all(needs.map(permissionState));
      const denied = needs.filter((name, index) => states[index] === "denied");
      return denied.length ? DENIED_MESSAGE + denied.map(name => PERMISSION_LABELS[name]).join(", ") + DENIED_HELP : "";
    }

    async function requestAccess(message) {
      const automatic = canRunWithoutTap(message);
      const needs = browserPermissions(message);
      if (settled) return;
      const denied = await deniedError(needs);
      if (denied) { channel.port1.postMessage({ kind: "response", id: message.id, error: denied }); return; }
      if (automatic) {
        let cancelled = false;
        const timeout = setTimeout(() => {
          cancelled = true;
          finish({ ok: false, error: "The browser did not respond to the access request. Check its permissions and try again." });
        }, BROWSER_RESPONSE_TIMEOUT_MS);
        const cleanup = () => clearTimeout(timeout);
        cleanups.add(cleanup);
        let task;
        try { task = invoke(message, () => cancelled); } catch (error) { task = Promise.reject(error); }
        task.then(result => {
          if (bytes(result) > MAX_BYTES) throw new Error("Result larger than 128 KiB");
          if (!settled) channel.port1.postMessage({ kind: "response", id: message.id, result });
        }).catch(async error => {
          cleanup(); cleanups.delete(cleanup);
          if (settled || cancelled) return;
          if (BLOCKED_ERRORS.has(error?.name)) {
            const blocked = await deniedError(needs);
            if (!blocked) { showCard(message, needs); return; }
            channel.port1.postMessage({ kind: "response", id: message.id, error: blocked });
            return;
          }
          channel.port1.postMessage({ kind: "response", id: message.id, error: String(error.message || error) });
        }).finally(() => { cleanup(); cleanups.delete(cleanup); });
        return;
      }
      showCard(message, needs);
    }

    function showCard(message, needs) {

      const card = document.createElement("div");
      card.className = "deviceRequest message assistant";
      card.dataset.deviceRequest = "true";
      const text = document.createElement("p");
      text.textContent = tool.name + (message.kind === "capture" ? " wants to take a photo" : " wants to access " + message.path);
      const allow = document.createElement("button");
      allow.type = "button";
      allow.textContent = "Continue";
      allow.className = "primary";
      let cancelled = false;
      let replied = false;
      let browserTimer;
      const panel = document.getElementById("deviceRequests");
      const dismiss = event => {
        if (event.defaultPrevented || panel.firstElementChild !== card) return;
        event.preventDefault();
      };
      panel.addEventListener("cancel", dismiss);
      const cleanup = () => { clearTimeout(browserTimer); panel.removeEventListener("cancel", dismiss); };
      cleanups.add(cleanup);
      const reply = result => {
        if (replied) return;
        replied = true;
        cleanup(); cleanups.delete(cleanup);
        card.remove(); cards.delete(card);
        if (!panel.children.length && panel.open) panel.close();
        if (!settled) channel.port1.postMessage({ kind: "response", id: message.id, ...result });
      };
      const run = () => {
        if (settled || allow.disabled) return;
        allow.disabled = true;
        allow.textContent = "Waiting for the browser…";
        browserTimer = setTimeout(() => {
          cancelled = true;
          reply({ error: "The browser did not respond to the permission request. Check Safari's camera or microphone permission and try again. If Eco is inside another page, open it directly." });
        }, BROWSER_RESPONSE_TIMEOUT_MS);
        let task;
        try { task = invoke(message, () => cancelled); } catch (error) { task = Promise.reject(error); }
        task.then(result => {
          if (bytes(result) > MAX_BYTES) throw new Error("Result larger than 128 KiB");
          reply({ result });
        }).catch(async error => {
          const denied = BLOCKED_ERRORS.has(error?.name) ? await deniedError(needs) : "";
          if (denied) { reply({ error: denied }); return; }
          const blocked = features.flatMap(entry => entry.policies).filter(name => policyState(name) === "blocked");
          reply({ error: String(error.message || error) + (blocked.length ? ". The embedding page blocks: " + [...new Set(blocked)].join(", ") + ". Open Eco directly or ask for the iframe's allow attribute to be adjusted." : "") });
        });
      };
      allow.onclick = run;
      card.append(text, allow);
      cards.add(card);
      panel.append(card);
      if (!panel.open) panel.showModal();
    }

    channel.port1.onmessage = ({ data }) => {
      if (settled) return;
      try {
        if (bytes(data) > MAX_BYTES) throw new Error("Message too large");
        if (data.kind === "ready") { if (started) throw new Error("Duplicate start"); started = true; clearTimeout(startupTimer); channel.port1.postMessage({ kind: "run", code: tool.code, params }); return; }
        if (data.kind === "done") { finish(data.error ? { ok: false, error: data.error } : { ok: true, data: data.result }); return; }
        if (!["call", "get", "construct", "listen", "capture"].includes(data.kind)) throw new Error("kind must be call, get, construct, listen or capture. " + CALL_SIGNATURE);
        if (!Number.isInteger(data.id) || data.id < 1) throw new Error("id must be a positive integer. " + CALL_SIGNATURE);
        data.args = normalizeArgs(data.args);
        if (requestIds.has(data.id)) throw new Error("Repeated id: each request needs a unique id");
        requestIds.add(data.id);
        if (++operations > 40 || cards.size >= 8) throw new Error("Too many device requests");
        locate(data.path);
        requestAccess(data).catch(error => finish({ ok: false, error: String(error.message || error) }));
      } catch (error) { finish({ ok: false, error: String(error.message || error) }); }
    };
    frame.onload = () => frame.contentWindow.postMessage({ kind: "connect" }, "*", [channel.port2]);
    frame.srcdoc = sandboxDocument();
    document.body.append(frame);
  });
}
