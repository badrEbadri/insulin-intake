// Bump this name when a new app-shell resource must replace an older offline cache.
const CACHE_NAME = 'insulin-intake-static-v4';

// Every path here must exist; install fails if any required shell file is missing.
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './telegram-config.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/ui.svg',
  './icons/icon-32.png',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  // Precache the shell so a first successful install can load without a network.
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Keep only the current cache after an update, then control open app tabs.
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Ignore writes and cross-origin requests; only cache this site's GET assets.
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;

  event.respondWith(
    // Prefer the local copy, otherwise fetch and save a successful response.
    caches.match(event.request).then((cached) =>
      cached || fetch(event.request).then((response) => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
    )
  );
});
