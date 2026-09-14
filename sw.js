// The wall display must never go blank, and it is never relaunched by hand.
// Shell: serve from cache instantly, refresh the cache in the background.
// Minyan data: network first, last confirmed copy if the network is down.
const CACHE = 'shabbos-clock';
const FILES = ['./', 'index.html', 'styles.css', 'app.js',
  'vendor/kosher-zmanim.min.js', 'data/shuls.json', 'manifest.webmanifest',
  'icons/icon-180.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;

  // Started and registered synchronously: waitUntil keeps the worker alive long
  // enough for the background refresh to finish writing to the cache.
  const network = fetch(e.request)
    .then(async (res) => {
      if (res.ok) (await caches.open(CACHE)).put(e.request, res.clone());
      return res;
    })
    .catch(() => null);
  e.waitUntil(network);

  const dataRequest = e.request.url.includes('minyanim.json');
  e.respondWith((async () => {
    const cached = await caches.match(e.request, { ignoreSearch: true });
    const first = dataRequest ? await network : cached;
    return first ?? (dataRequest ? cached : await network) ?? Response.error();
  })());
});
