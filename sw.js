// The wall display must never go blank, and it is never relaunched by hand.
//
// index.html, app.js and styles.css are one generation and must be served as
// one. Refreshing them independently in the background can hand the page a new
// stylesheet against an old script, which is worse than serving either
// generation whole: the CSS scopes its rules to markup the old script does not
// emit, so the times lose their columns and their colour. Those three are
// network-first, on a timeout, falling back together to the last cached set.
//
// Everything else keeps the old behaviour. The zmanim library is 228KB and
// never changes, so it stays cache-first and instant. Minyan times stay
// network-first with the last confirmed copy behind them.
//
// Bump VERSION on any change to the three coupled files: install re-fetches the
// whole list into a fresh cache, so a half-updated cache cannot survive it.
const VERSION = 'v2';
const CACHE = `shabbos-clock-${VERSION}`;
const FILES = ['./', 'index.html', 'styles.css', 'app.js',
  'vendor/kosher-zmanim.min.js', 'data/shuls.json', 'manifest.webmanifest',
  'icons/icon-180.png'];

// The three that move together. A navigation request covers './' and index.html.
const COUPLED = /\/(app\.js|styles\.css|index\.html)$/;
// Long enough for a slow wifi handshake, short enough that a dead network never
// leaves the wall blank: past this we show the cached generation instead.
const NET_TIMEOUT = 4000;

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

  const url = new URL(e.request.url);
  const freshFirst = url.pathname.includes('minyanim.json')
    || e.request.mode === 'navigate'
    || COUPLED.test(url.pathname);

  // Started and registered synchronously: waitUntil keeps the worker alive long
  // enough for the background refresh to finish writing to the cache.
  const network = fetch(e.request)
    .then(async (res) => {
      if (res.ok) (await caches.open(CACHE)).put(e.request, res.clone());
      return res;
    })
    .catch(() => null);
  e.waitUntil(network);

  e.respondWith((async () => {
    const cached = await caches.match(e.request, { ignoreSearch: true });
    if (!freshFirst) return cached ?? await network ?? Response.error();
    // Nothing cached yet: the network is the only answer, so wait for it.
    if (!cached) return await network ?? Response.error();
    const timeout = new Promise((r) => { setTimeout(() => r(null), NET_TIMEOUT); });
    return await Promise.race([network, timeout]) ?? cached;
  })());
});
