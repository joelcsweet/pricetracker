const CACHE = 'pricetracker-v2';
const PRECACHE = ['/pricetracker/', '/pricetracker/index.html'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // Never cache API calls to the Worker
  if (e.request.url.includes('workers.dev')) return;
  if (e.request.method !== 'GET') return;

  const isHTML     = e.request.mode === 'navigate';
  const isManifest = e.request.url.endsWith('manifest.json');

  // Network-first for HTML and the manifest so updates (incl. start_url) always win
  if (isHTML || isManifest) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
          return res;
        })
        .catch(() => caches.match(e.request).then(r => r || caches.match('/pricetracker/')))
    );
    return;
  }

  // Cache-first for other static assets (fonts, icons)
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return res;
      });
    })
  );
});
