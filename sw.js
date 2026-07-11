/* =========================================================================
   OUTFIT LINE — service worker
   Caches the app shell (HTML/CSS/JS/icons) so the app still works with no
   signal. Your actual clothing photos + tags never touch this cache — they
   live in IndexedDB (see app.js), which the browser keeps regardless of
   the service worker.

   STRATEGY: network-first. Every load tries the real network first and
   updates the cache with whatever comes back; the cache is only used as a
   fallback when there's genuinely no connection. This means a fresh
   deploy on GitHub shows up immediately on next load — no more manually
   bumping CACHE_NAME and hoping the browser notices sw.js changed.
   ========================================================================= */

const CACHE_NAME = "outfit-line-shell";
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

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // let cross-origin (Claude API) pass through untouched

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() =>
        caches.match(event.request).then((cached) => cached || caches.match("./index.html"))
      )
  );
});
