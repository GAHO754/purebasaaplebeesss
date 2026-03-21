const CACHE_NAME = "applebees-pwa-v5";

const ASSETS = [
  "/",
  "index.html",
  "offline.html",

  // HTML
  "canjear.html",
  "panel.html",
  "register.html",
  "registrar.html",
  "manager.html",

  // CSS
  "style.css",
  "panel.css",
  "registrar.css",
  "manager.css",

  // JS
  "auth.js",
  "firebase-config.js",
  "ocr.js",
  "panel.js",
  "registrar.js",
  "manager.js",

  // PWA
  "manifest.json",

  // ICONOS
  "manzanas.png",
  "LogoApplebees.png",
  "logo_anim_transparent.gif",

  // FONDOS
  "imageapplenavidad.png",
  "imageanonuevo.png",

  // PROMOS
  "promo1.png",
  "promo2.png",
  "promo3.png",
  "promo4.png",
  "promo5.png",
  "promo6.png"
];


// INSTALAR
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});


// ACTIVAR
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      )
    )
  );
  self.clients.claim();
});


// FETCH
self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Solo manejar requests de tu dominio
  if (url.origin !== self.location.origin) return;

  // HTML → network first
  if (
    req.mode === "navigate" ||
    req.headers.get("accept")?.includes("text/html")
  ) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          return res;
        })
        .catch(async () => {
          const cached = await caches.match(req);
          return cached || caches.match("/offline.html");
        })
    );
    return;
  }

  // Assets → cache first
  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req))
  );
});
