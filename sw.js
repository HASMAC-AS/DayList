/* Offline-first service worker (app shell + runtime caching).
   Note: service workers require HTTPS (or http://localhost).
*/
const CACHE = 'daylist-v1';
const APP_SHELL = [
  './',
  './index.html',
  './app.js',
  './manifest.json',
  './icon.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(APP_SHELL);
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => (k === CACHE ? null : caches.delete(k))));
    await self.clients.claim();
  })());
});

function isNavigation(request) {
  return request.mode === 'navigate' ||
    (request.headers.get('accept') || '').includes('text/html');
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);

    // Navigation: cached app shell (offline-first), update in background.
    if (isNavigation(req)) {
      const cached = await cache.match('./index.html');
      const networkPromise = fetch(req).then(async (res) => {
        if (res && res.ok) cache.put('./index.html', res.clone());
        return res;
      }).catch(() => null);

      return cached || (await networkPromise) || new Response('Offline', { status: 503 });
    }

    // Runtime caching: stale-while-revalidate.
    const cached = await cache.match(req);
    const networkPromise = fetch(req).then(async (res) => {
      if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
      return res;
    }).catch(() => null);

    return cached || (await networkPromise) || new Response('', { status: 504 });
  })());
});
