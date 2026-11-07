const REQUEST_TIMEOUT_MS = 45000;

export async function timedFetch(url, init = {}) {
  const controller = new AbortController();
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
    clearTimeout(timer);
    external?.removeEventListener("abort", abort);
  }
}
