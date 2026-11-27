import { isWiping } from "./security.js";
const REQUEST_TIMEOUT_MS = 45000;
const MODEL_TIMEOUT_MS = 300000;
const controllers = new Set();

export function abortNetwork() {
  for (const controller of controllers) controller.abort(new Error("red cancelada"));
  controllers.clear();
}

export async function timedFetch(url, init = {}, timeoutMs) {
  if (isWiping()) throw new Error("Connection cancelled");
  const isModel = String(url).toLowerCase().includes("openrouter");
  const ms = typeof timeoutMs === "number" ? timeoutMs : isModel ? MODEL_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  controllers.add(controller);
  const abort = () => controller.abort(external?.reason || new Error("cancelado"));
  const external = init.signal;
  if (external && !external.aborted) external.addEventListener("abort", abort, { once: true });
  let timedOut = false;
  const onTimeout = () => { timedOut = true; controller.abort(); };
  const timer = setTimeout(onTimeout, ms);
  try {
    const response = await window.fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    return new Response([204, 205, 304].includes(response.status) ? null : text, { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch (error) {
    if (timedOut && isModel) throw new Error("El modelo tardó demasiado en responder; reintenta");
    throw error;
  } finally {
    controllers.delete(controller);
    clearTimeout(timer);
    external?.removeEventListener("abort", abort);
  }
}
