let wiping = false;
const CACHE_NAME = "eco-v0.16.2";
const VERSION_QUERY = "?v=0.16.2";
const SHELL_FILES = [
  "./",
  "index.html",
  "css/app.css" + VERSION_QUERY,
  "js/app.js" + VERSION_QUERY,
  "manifest.webmanifest" + VERSION_QUERY,
  "assets/icon.svg" + VERSION_QUERY
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith("eco-v") && key !== CACHE_NAME).map((key) => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (wiping || event.request.method !== "GET" || url.origin !== location.origin) {
    return;
  }
  event.respondWith(
    fetch(new Request(event.request, { cache: "no-store" }))
      .then((response) => {
        const copy = response.clone();
        if (!wiping) event.waitUntil(caches.open(CACHE_NAME).then(cache => { if (!wiping) return cache.put(event.request, copy); }).catch(() => {}));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

self.addEventListener("message", event => {
  if (event.data?.type === "eco-activate") { self.skipWaiting(); return; }
  if (event.data?.type !== "eco-wipe") return;
  wiping = true;
  event.waitUntil(Promise.all([self.registration.unregister(), caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith("eco-v")).map(key => caches.delete(key))))]));
});
