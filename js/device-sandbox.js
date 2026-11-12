const workerSource = `
const pending = new Map();
let sequence = 0;
const size = value => new TextEncoder().encode(JSON.stringify(value)).length;
const normalizeArgs = args => args === undefined ? [] : Array.isArray(args) ? args : [args];
const request = (kind, path, args) => new Promise((resolve, reject) => {
  const id = ++sequence;
  const message = { kind, id, path, args: normalizeArgs(args) };
  if (size(message) > 65536) return reject(new Error("Parameters too large"));
  pending.set(id, { resolve, reject });
  postMessage(message);
});
const listenStream = (path, event) => {
  const id = ++sequence;
  const queue = [];
  const waiters = [];
  let stopped = false;
  pending.set(id, {
    resolve: (value) => {
      if (waiters.length) waiters.shift().resolve(value);
      else queue.push(value);
    },
    reject: (error) => {
      stopped = true;
      pending.delete(id);
      while (waiters.length) waiters.shift().reject(error);
    }
  });
  postMessage({ kind: "listen", id, path, args: [event, { stream: true }] });
  return {
    next: () => new Promise((resolve, reject) => {
      if (stopped && !queue.length) return reject(new Error("Listener stopped"));
      if (queue.length) return resolve(queue.shift());
      waiters.push({ resolve, reject });
    }),
    stop: () => request("unlisten", path, [id]).then(() => {
      stopped = true;
      pending.delete(id);
      while (waiters.length) waiters.shift().reject(new Error("Listener stopped"));
    })
  };
};
const device = Object.freeze({
  call: (path, args) => request("call", path, args),
  get: path => request("get", path),
  set: (path, value) => request("set", path, [value]),
  construct: (path, args) => request("construct", path, args),
  listen: (path, event, options) => options && options.stream ? listenStream(path, event) : request("listen", path, [event]),
  capture: (stream, options) => request("capture", "handles." + stream?.$handle, [options || {}]),
  callback: kind => ({ $callback: kind })
});
onmessage = async ({ data }) => {
  if (data.kind === "response") {
    const item = pending.get(data.id);
    if (!item) return;
    if (!data.more) pending.delete(data.id);
    if (data.error) item.reject(new Error(data.error)); else item.resolve(data.result);
    return;
  }
  if (data.kind !== "run") return;
  try {
    const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
    const result = await new AsyncFunction("params", "device", '"use strict"; ' + data.code)(data.params, device);
    if (size(result ?? null) > 131072) throw new Error("Result larger than 128 KiB");
    postMessage({ kind: "done", result: result ?? null });
  } catch (error) { postMessage({ kind: "done", error: String(error.message || error) }); }
};
postMessage({ kind: "worker-ready" });
`;

export function sandboxDocument() {
  const boot = `
  let worker;
  addEventListener("message", event => {
    if (event.source !== parent || worker || !event.ports[0]) return;
    const port = event.ports[0];
    const blob = new Blob([${JSON.stringify(workerSource)}], { type: "text/javascript" });
    const url = URL.createObjectURL(blob);
    try { worker = new Worker(url); }
    catch { URL.revokeObjectURL(url); port.postMessage({kind:"done",error:"This browser does not support isolated tools. Try a current version of Safari or Chromium."}); return; }
    worker.onmessage = event => {
      if (event.data.kind === "worker-ready") { URL.revokeObjectURL(url); port.postMessage({kind:"ready"}); return; }
      port.postMessage(event.data);
    };
    worker.onerror = event => { URL.revokeObjectURL(url); event.preventDefault(); port.postMessage({kind:"done",error:"Could not run the isolated code"}); };
    port.onmessage = event => {
      if (event.data.kind === "stop") { worker.terminate(); port.close(); return; }
      worker.postMessage(event.data);
    };
    port.start();
  });`;
  return '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\' \'unsafe-eval\'; worker-src blob:; connect-src \'none\'; form-action \'none\'; base-uri \'none\'"></head><body><script>' + boot + '</script></body></html>';
}
