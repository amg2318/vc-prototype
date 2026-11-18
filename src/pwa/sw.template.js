// Offline service worker. Not bundled by Vite: a plugin in vite.config.ts copies
// it to dist/sw.js at build time and fills in the two placeholders below.
// URLs are relative to the service worker's own location, so the same file
// works at "/" and under a GitHub Pages sub-path.

const CACHE = 'vc-proto-__CACHE_VERSION__';
const PRECACHE = __PRECACHE_MANIFEST__;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    // Network first so a new deploy is picked up when online; cached app shell offline.
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put('./', copy));
          return response;
        })
        .catch(() => caches.match('./', { ignoreVary: true })),
    );
    return;
  }

  // Assets have content hashes in their names, so cache first is safe.
  // ignoreVary: servers may send `Vary: Origin`, and module-script requests
  // carry an Origin header that the precache requests didn't.
  event.respondWith(caches.match(request, { ignoreVary: true }).then((cached) => cached ?? fetch(request)));
});
