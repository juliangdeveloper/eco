import { isWiping } from "./security.js";
import { featureDefinitions, featureValue, policyState } from "./environment.js";
import { sandboxDocument } from "./device-sandbox.js";

const MAX_BYTES = 131072;
const executions = new Set();

export function stopDeviceTools() {
  for (const stop of executions) { try { stop(); } catch {} }
  executions.clear();
}
const forbidden = new Set(["composedPath", "watchPosition", "addEventListener", "removeEventListener", "dispatchEvent", "constructor", "prototype", "__proto__", "caller", "callee", "arguments", "call", "apply", "bind", "eval", "valueOf", "toString", "toLocaleString", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable", "window", "parent", "top", "self", "globalThis", "document", "ownerDocument", "defaultView", "source", "ports", "view", "target", "currentTarget", "srcElement", "path"]);
const bytes = value => new TextEncoder().encode(JSON.stringify(value)).length;
const validPart = value => /^[A-Za-z][A-Za-z0-9]*$/.test(value) && !forbidden.has(value);

export function executeDeviceTool(tool, params, signal) {
  if (isWiping()) return Promise.resolve({ ok: false, error: "Acceso cancelado" });
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
      signal?.removeEventListener("abort", abort);
      for (const cleanup of cleanups) cleanup();
      for (const card of cards) card.remove();
      for (const { value, feature } of [...handles.values()].reverse()) stopObject(value, feature);
      channel.port1.postMessage({ kind: "stop" });
      channel.port1.close();
      frame.remove();
      resolve({ untrusted: true, ...result });
    };
    const abort = () => finish({ ok: false, error: "Acceso al dispositivo cancelado" });
    const timer = setTimeout(() => finish({ ok: false, error: "La herramienta del dispositivo agotó su tiempo. Puedes volver a intentarlo." }), Math.min(60000, Math.max(1000, tool.timeout_ms || 30000)));
    executions.add(abort);
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener("abort", abort, { once: true });

    function encode(value, feature, depth = 0, seen = new Set()) {
      if (value === null || value === undefined) return null;
      if (["string", "number", "boolean"].includes(typeof value)) return value;
      if (value === window || value === document || value === navigator || value === localStorage || value === indexedDB || value === crypto || value instanceof Node || value instanceof Window || value instanceof Storage || typeof CryptoKey !== "undefined" && value instanceof CryptoKey) throw new Error("Objeto fuera de las capacidades permitidas");
      if (typeof value !== "object" || depth > 8) throw new Error("Resultado no serializable");
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
      if (depth > 10) throw new Error("Parámetros demasiado profundos");
      if (!value || typeof value !== "object") return value;
      if (value.$handle) {
        if (!handles.has(value.$handle)) throw new Error("Referencia no disponible");
        return handles.get(value.$handle).value;
      }
      if (value.$callback) {
        if (!["resolve", "reject"].includes(value.$callback)) throw new Error("Callback inválido");
        return value.$callback === "resolve" ? done : fail;
      }
      if (value.$bytes) return new Uint8Array(value.$bytes);
      if (Array.isArray(value)) return value.map(item => decode(item, done, fail, depth + 1));
      return Object.fromEntries(Object.entries(value).map(([key, item]) => {
        if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error("Parámetro no permitido");
        return [key, decode(item, done, fail, depth + 1)];
      }));
    }

    function locate(path) {
      if (typeof path !== "string" || path.length > 200) throw new Error("Ruta inválida");
      const parts = path.split(".");
      let feature, value, remaining;
      if (parts[0] === "handles") {
        const entry = handles.get(parts[1]);
        if (!entry) throw new Error("Referencia no disponible en esta ejecución");
        ({ value, feature } = entry);
        remaining = parts.slice(2);
      } else {
        feature = features.find(entry => path === entry.path || path.startsWith(entry.path + "."));
        if (!feature) throw new Error("Ruta fuera de las capacidades permitidas");
        value = featureValue(feature.path);
        remaining = parts.slice(feature.path.split(".").length);
      }
      if (value === undefined || value === null) throw new Error("Esta API no está disponible en este navegador");
      let owner = window;
      if (!remaining.length && feature.path.startsWith("navigator.")) owner = navigator;
      for (const part of remaining) {
        if (!validPart(part)) throw new Error("Miembro no permitido");
        if (typeof value === "function" && value !== featureValue(feature.path)) throw new Error("No se pueden recorrer funciones");
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
        const reject = error => fail(new Error(String(error?.message || error?.name || error || "Permiso denegado")));
        const args = decode(message.args, respond, reject);
        if (message.kind === "get") { respond(entry.value); return; }
        if (message.kind === "listen") {
          const event = args[0];
          if (!entry.feature.events.includes(event)) throw new Error("Evento no permitido para esta capacidad");
          const target = entry.feature.eventTarget === "window" ? window : entry.value;
          if (!target?.addEventListener) throw new Error("Esta capacidad no admite eventos");
          const listener = value => { cleanup(); respond(value); };
          const cleanup = () => { target.removeEventListener(event, listener); cleanups.delete(cleanup); };
          cleanups.add(cleanup);
          target.addEventListener(event, listener, { once: true });
          return;
        }
        if (typeof entry.value !== "function") throw new Error("El método no existe en este navegador");
        if (message.kind === "construct" && message.path !== entry.feature.path) throw new Error("Constructor no permitido");
        const result = message.kind === "construct" ? Reflect.construct(entry.value, args) : Reflect.apply(entry.value, entry.owner, args);
        const callbacks = JSON.stringify(message.args).includes('"$callback"');
        if (result?.then) result.then(respond, reject);
        else if (!callbacks) respond(result);
      });
    }

    function requestAccess(message) {
      const card = document.createElement("div");
      card.className = "deviceRequest message assistant";
      card.dataset.deviceRequest = "true";
      const text = document.createElement("p");
      text.textContent = tool.name + " quiere acceder a " + message.path;
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = "Ver parámetros";
      const pre = document.createElement("pre");
      pre.textContent = JSON.stringify(message.args, null, 2);
      details.append(summary, pre);
      const allow = document.createElement("button");
      allow.type = "button";
      allow.textContent = "Permitir una vez";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.textContent = "Cancelar";
      let cancelled = false;
      const reply = result => {
        card.remove(); cards.delete(card);
        if (!settled) channel.port1.postMessage({ kind: "response", id: message.id, ...result });
      };
      allow.onclick = () => {
        if (settled || allow.disabled) return;
        allow.disabled = true;
        let task;
        try { task = invoke(message, () => cancelled); } catch (error) { task = Promise.reject(error); }
        task.then(result => {
          if (bytes(result) > MAX_BYTES) throw new Error("Resultado mayor de 128 KiB");
          reply({ result });
        }).catch(error => {
          const blocked = features.flatMap(entry => entry.policies).filter(name => policyState(name) === "blocked");
          reply({ error: String(error.message || error) + (blocked.length ? ". La página contenedora bloquea: " + [...new Set(blocked)].join(", ") + ". Abre Eco directamente o solicita ajustar allow en el iframe." : "") });
        });
      };
      cancel.onclick = () => { cancelled = true; reply({ error: "Acceso cancelado por la persona" }); };
      card.append(text, details, allow, cancel);
      cards.add(card);
      document.getElementById("deviceRequests").append(card);
      card.scrollIntoView({ block: "nearest" });
    }

    channel.port1.onmessage = ({ data }) => {
      if (settled) return;
      try {
        if (bytes(data) > MAX_BYTES) throw new Error("Mensaje demasiado grande");
        if (data.kind === "ready") { if (started) throw new Error("Inicio duplicado"); started = true; channel.port1.postMessage({ kind: "run", code: tool.code, params }); return; }
        if (data.kind === "done") { finish(data.error ? { ok: false, error: data.error } : { ok: true, data: data.result }); return; }
        if (!["call", "get", "construct", "listen"].includes(data.kind) || !Number.isInteger(data.id) || !Array.isArray(data.args)) throw new Error("Solicitud inválida");
        if (data.id < 1 || requestIds.has(data.id)) throw new Error("Solicitud repetida");
        requestIds.add(data.id);
        if (++operations > 40 || cards.size >= 8) throw new Error("Demasiadas solicitudes del dispositivo");
        locate(data.path);
        requestAccess(data);
      } catch (error) { finish({ ok: false, error: String(error.message || error) }); }
    };
    frame.onload = () => frame.contentWindow.postMessage({ kind: "connect" }, "*", [channel.port2]);
    frame.srcdoc = sandboxDocument();
    document.body.append(frame);
  });
}
