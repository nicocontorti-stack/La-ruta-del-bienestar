// Service worker: hace que el sitio sea instalable (PWA) y deja escuchar audiolibros sin internet.
// El catálogo sigue pasando directo a la red (precios siempre al día).
// Solo la página de audiolibros tiene respaldo sin conexión (los capítulos guardados los lee la propia página).
const PAGINAS = 'audiolibros-paginas-v1';
const RECURSOS = ['/audiolibros.html', '/icon-192.png', '/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(PAGINAS).then((c) => Promise.all(RECURSOS.map((u) => c.add(u).catch(() => {})))).then(() => self.skipWaiting())
  );
});
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const u = new URL(req.url);
  if (u.origin !== location.origin) return;
  if (RECURSOS.includes(u.pathname)) {
    e.respondWith(
      fetch(req).then((r) => {
        if (r.ok) { const copia = r.clone(); caches.open(PAGINAS).then((c) => c.put(u.pathname, copia)); }
        return r;
      }).catch(() => caches.match(u.pathname, { ignoreSearch: true }).then((r) => r || Response.error()))
    );
    return;
  }
  e.respondWith(fetch(req));
});
