// /sw.js
const VERSION = 'v1';
const OFFLINE_URL = '/offline.html';
const CORE_ASSETS = [
  OFFLINE_URL,
  '/404.html',
  '/', // tu home (opcional si es SPA)
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(`core-${VERSION}`).then(cache => cache.addAll(CORE_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => !k.includes(VERSION)).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;

  // Sólo navegaciones (document)
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        // intenta red
        const fresh = await fetch(req);
        return fresh;
      } catch {
        // si falla, offline
        const cache = await caches.open(`core-${VERSION}`);
        const offline = await cache.match(OFFLINE_URL);
        return offline || Response.error();
      }
    })());
    return;
  }

  // Para assets: cache primero, luego red
  e.respondWith((async () => {
    const cache = await caches.open(`core-${VERSION}`);
    const hit = await cache.match(req);
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (req.url.startsWith(self.location.origin)) cache.put(req, res.clone());
      return res;
    } catch {
      // Si falla y no hay cache, deja pasar
      return hit || Response.error();
    }
  })());
});
