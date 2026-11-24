/* Tidenblick Nordsee – Service Worker
   - App-Dateien: sofort aus dem Cache, im Hintergrund aktualisiert
   - BSH-Daten: zuerst Netz, bei fehlender Verbindung die zuletzt gespeicherten Daten
   - Bibliotheken/Schriften (CDN): aus dem Cache, im Hintergrund aktualisiert
   - Kartenkacheln: nur Netz (nicht gespeichert) */
const VERSION = 'v4';
const SHELL_CACHE = `tidenblick-shell-${VERSION}`;
const DATA_CACHE = `tidenblick-data-${VERSION}`;
const LIB_CACHE = `tidenblick-lib-${VERSION}`;

const SHELL = ['./', 'index.html', 'app.js', 'styles.css', 'stations.js', 'presets.js', 'manifest.webmanifest',
  'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png'];
const LIBS = [
  'https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js',
  'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js',
  'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css',
  'https://cdn.jsdelivr.net/npm/suncalc@1.9.0/suncalc.js',
];
const LIB_HOSTS = ['cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com', 'api.fontshare.com', 'cdn.fontshare.com'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL_CACHE);
    await shell.addAll(SHELL);
    const lib = await caches.open(LIB_CACHE);
    // Einzeln, damit eine nicht erreichbare Bibliothek die Installation nicht verhindert
    await Promise.all(LIBS.map((u) => fetch(new Request(u, { mode: 'no-cors' })).then((r) => lib.put(u, r)).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = [SHELL_CACHE, DATA_CACHE, LIB_CACHE];
    for (const k of await caches.keys()) if (k.startsWith('tidenblick-') && !keep.includes(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

async function staleWhileRevalidate(request, cacheName, opts = {}) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request, opts);
  const update = fetch(request).then((res) => {
    if (res && (res.ok || res.type === 'opaque')) cache.put(request, res.clone());
    return res;
  }).catch(() => null);
  if (cached) { update.catch(() => {}); return cached; }
  const res = await update;
  return res || Response.error();
}

async function networkFirstData(request) {
  const cache = await caches.open(DATA_CACHE);
  const cached = await cache.match(request);
  // Mit gespeicherten Daten nach 8 s aufgeben (schwaches Netz), sonst länger warten
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), cached ? 8000 : 30000);
  try {
    const res = await fetch(request, { signal: ctl.signal });
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch (err) {
    if (!cached) throw err;
    // Markieren, damit die App „Keine Verbindung – gespeicherte Daten“ anzeigen kann
    const headers = new Headers(cached.headers);
    headers.set('x-offline-cache', '1');
    return new Response(await cached.blob(), { status: cached.status, statusText: cached.statusText, headers });
  } finally {
    clearTimeout(timer);
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.hostname === 'gdi.bsh.de') { event.respondWith(networkFirstData(req)); return; }
  if (LIB_HOSTS.includes(url.hostname)) { event.respondWith(staleWhileRevalidate(req, LIB_CACHE)); return; }
  if (url.origin === self.location.origin) {
    // Navigation (auch mit #Hash/Query) liefert immer die gespeicherte index.html
    if (req.mode === 'navigate') {
      event.respondWith((async () => {
        const cache = await caches.open(SHELL_CACHE);
        const cached = await cache.match('index.html');
        const update = fetch(req).then((res) => { if (res.ok) cache.put('index.html', res.clone()); return res; }).catch(() => null);
        return cached || (await update) || Response.error();
      })());
      return;
    }
    event.respondWith(staleWhileRevalidate(req, SHELL_CACHE, { ignoreSearch: true }));
  }
  // alles andere (z. B. Kartenkacheln): direkt aus dem Netz
});
