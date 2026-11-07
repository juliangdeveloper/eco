import { isWiping } from "./security.js";
const REQUEST_TIMEOUT_MS = 45000;
const controllers = new Set();

export function abortNetwork() {
  for (const controller of controllers) controller.abort();
  controllers.clear();
}

export async function timedFetch(url, init = {}) {
  if (isWiping()) throw new Error("Conexión cancelada");
  const controller = new AbortController();
  controllers.add(controller);
  const abort = () => controller.abort();
  const external = init.signal;
  if (external?.aborted) controller.abort();
  else external?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, REQUEST_TIMEOUT_MS);
  try {
    const response = await window.fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    return new Response([204, 205, 304].includes(response.status) ? null : text, { status: response.status, statusText: response.statusText, headers: response.headers });
  } finally {
    controllers.delete(controller);
    clearTimeout(timer);
    external?.removeEventListener("abort", abort);
  }
}
