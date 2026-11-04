// Service worker de Sentinel : rend l'application installable et garde l'interface (scripts, styles, polices, icônes).
// Il ne met jamais en cache les réponses de l'API ni les pages : un SIEM n'affiche pas de données périmées et ne laisse
// ni adresse IP ni preuve sur l'appareil. Sans réseau, une page dit que Sentinel est injoignable.
const CACHE = 'sentinel-interface-v1';
const OFFLINE = '/offline.html';
const PRECACHE = [OFFLINE, '/offline.css', '/favicon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

/** Fichiers de l'interface : nommés par leur contenu (`/assets/`), stables (polices, icônes) ou de la page hors ligne. */
const isInterfaceFile = (url) =>
  url.pathname.startsWith('/assets/') || url.pathname.startsWith('/fonts/') || url.pathname.startsWith('/icons/') || PRECACHE.includes(url.pathname);

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // API, ingestion et santé : toujours le réseau, sans copie.
  if (url.pathname.startsWith('/api/') || url.pathname === '/ingest' || url.pathname === '/health') return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match(OFFLINE)));
    return;
  }
  if (isInterfaceFile(url)) {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok) await cache.put(request, response.clone());
        return response;
      }),
    );
  }
});
