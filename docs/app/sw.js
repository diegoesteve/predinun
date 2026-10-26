// Service worker de la app: abre sin señal con lo último que se vio, y recibe los avisos al celular.
//   - La app (html, js, css, íconos): lo guardado primero, y se actualiza en segundo plano.
//   - Los datos (../data/app.json y los arroyos): de la red primero; sin conexión, lo último guardado.
// Cambiar VERSION cuando cambie la lista de APP.
const VERSION = 'crecidas-app-1';
const APP = ['./', 'index.html', 'app.js', 'app.css', 'manifest.webmanifest', 'iconos/icono-192.png', 'iconos/icono-512.png'];

self.addEventListener('install', ev => {
  ev.waitUntil(caches.open(VERSION).then(c => Promise.all(APP.map(u => c.add(new Request(u, { cache: 'reload' })).catch(() => null)))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', ev => {
  ev.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

async function redPrimero(req, clave) {
  const cache = await caches.open(VERSION);
  try {
    const r = await fetch(req);
    if (r.ok) cache.put(clave, r.clone());
    return r;
  } catch (e) {
    const g = await cache.match(clave);
    if (g) return g;
    throw e;
  }
}
async function guardadoPrimero(ev, req) {
  const cache = await caches.open(VERSION);
  const g = await cache.match(req, { ignoreSearch: true });
  const nueva = fetch(req).then(r => { if (r.ok) cache.put(req.url.split('?')[0], r.clone()); return r; }).catch(() => null);
  if (g) { ev.waitUntil(nueva); return g; }
  return (await nueva) || Response.error();
}

self.addEventListener('fetch', ev => {
  const req = ev.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes('/data/')) { ev.respondWith(redPrimero(req, url.origin + url.pathname)); return; }
  if (req.mode === 'navigate') {
    ev.respondWith(redPrimero(req, new URL('./', self.location).href).catch(async () => (await caches.match(new URL('./', self.location).href)) || Response.error()));
    return;
  }
  if (url.pathname.includes('/app/')) ev.respondWith(guardadoPrimero(ev, req));
});

// Aviso al celular (web push): lo manda scripts/notificar_app.py
self.addEventListener('push', ev => {
  let d = {};
  try { d = ev.data ? ev.data.json() : {}; } catch (e) { d = { titulo: 'Crecidas', texto: ev.data ? ev.data.text() : '' }; }
  ev.waitUntil(self.registration.showNotification(d.titulo || 'Crecidas', {
    body: d.texto || '', icon: 'iconos/icono-192.png', badge: 'iconos/icono-192.png', tag: d.tag || 'crecidas',
    renotify: true, data: { url: d.url || './' },
  }));
});
self.addEventListener('notificationclick', ev => {
  ev.notification.close();
  const destino = new URL(ev.notification.data && ev.notification.data.url || './', self.location).href;
  ev.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(ls => {
    for (const c of ls) if (c.url.startsWith(new URL('./', self.location).href)) return c.focus();
    return self.clients.openWindow(destino);
  }));
});
