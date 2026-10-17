// Everything is network-first with a cache fallback: the app works offline, and
// articles you already opened stay readable without a connection.
const SHELL_CACHE = 'wikicastro-shell-v1';
const API_CACHE = 'wikicastro-api-v1';
const API_CACHE_MAX = 300;
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'icon.svg', 'manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => ![SHELL_CACHE, API_CACHE].includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function trim(cache) {
  const keys = await cache.keys();
  await Promise.all(keys.slice(0, Math.max(0, keys.length - API_CACHE_MAX)).map((k) => cache.delete(k)));
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (url.hostname.endsWith('.wikipedia.org') && url.pathname === '/w/api.php') {
    event.respondWith((async () => {
      const cache = await caches.open(API_CACHE);
      try {
        const res = await fetch(request);
        if (res.ok) {
          await cache.put(request, res.clone());
          trim(cache);
        }
        return res;
      } catch (err) {
        const hit = await cache.match(request);
        if (hit) return hit;
        throw err;
      }
    })());
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(SHELL_CACHE).then((c) => c.put(request, copy));
          }
          return res;
        })
        .catch(() => caches.match(request).then((hit) => hit || caches.match('index.html'))),
    );
  }
});
