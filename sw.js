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
// Bump it for data/shuls.json too — that one is cache-first, so an edit to it
// (a new shul, a havdalah offset) reaches the wall no other way.
const VERSION = 'v6';
// caches.keys() is ORIGIN-wide, not per-worker. This is served from
// jmand2.github.io/shabbos/, so every other project page on that account shares
// the origin — and an activate that deleted everything it did not recognise
// would wipe their caches too. Ours are the ones carrying this prefix.
const PREFIX = 'shabbos-clock-';
const CACHE = `${PREFIX}${VERSION}`;
const FILES = ['./', 'index.html', 'styles.css', 'app.js',
  'flights.css', 'flights.js',
  'vendor/kosher-zmanim.min.js', 'data/shuls.json', 'manifest.webmanifest',
  'icons/icon-180.png'];

// The files that move together. A navigation request covers './' and index.html.
// flights.js and flights.css are a pair in the same way app.js and styles.css
// are: the module builds the markup its stylesheet expects, so serving one
// generation's script against another's styles breaks it the same way.
const COUPLED = /\/(app\.js|styles\.css|index\.html|flights\.js|flights\.css)$/;
// Long enough for a slow wifi handshake, short enough that a dead network never
// leaves the wall blank: past this we show the cached generation instead.
const NET_TIMEOUT = 4000;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys
      .filter((k) => k.startsWith(PREFIX) && k !== CACHE)
      .map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;

  const url = new URL(e.request.url);
  // The forecast is the one thing here that is wrong the moment it is old, and
  // it is the only cross-origin request the display makes. Cache-first would
  // have painted an hour-old sky and only corrected it on the next render.
  const freshFirst = url.pathname.includes('minyanim.json')
    || url.hostname.endsWith('open-meteo.com')
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
