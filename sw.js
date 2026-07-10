/* =========================================================================
   OUTFIT LINE — service worker
   Caches the app shell (HTML/CSS/JS/icons) so the app opens instantly and
   works with no signal. Your actual clothing photos + tags never touch
   this cache — they live in IndexedDB (see app.js), which the browser
   keeps regardless of the service worker.

   Bump CACHE_NAME any time you edit index.html / style.css / app.js and
   re-deploy, so returning visits pick up the new files instead of the
   stale cached copies.
   ========================================================================= */

const CACHE_NAME = "outfit-line-v2";
const APP_SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      )
    ).then(() => self.clients.claim())
  );
});

// Cache-first for the app shell, so the app is fully usable offline.
// Anything not in the shell (e.g. a live Gemini API call) just goes to
// the network as normal — this service worker never intercepts those.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // let cross-origin (Gemini API) pass through untouched

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((response) => {
          // Opportunistically cache newly-seen same-origin files
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          return response;
        })
        .catch(() => caches.match("./index.html")); // offline fallback for navigations
    })
  );
});
