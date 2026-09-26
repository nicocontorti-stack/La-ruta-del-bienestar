// Service worker mínimo: hace que el sitio sea instalable como app (PWA).
// No guarda caché: todo pasa directo a la red, así los precios siempre están al día.
self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  e.respondWith(fetch(e.request));
});
