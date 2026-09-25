// The wall display must never go blank, and it is never relaunched by hand.
//
// THE MODEL: one VERSION is exactly one immutable app-shell generation.
//
// install downloads the complete shell into a cache of its own. From then on
// those files are served from that cache and never individually refetched, so
// the page cannot assemble itself out of two generations. A deploy publishes a
// new VERSION, whose worker installs a new complete shell beside the old one
// and takes over only once every file of it has landed. If the network dies
// half way through an install, the new generation simply never activates and
// the old one goes on serving — whole.
//
// This used to be network-first per coupled file with a cache fallback, which
// is a weaker promise than the comments here were making. Under the wrong
// timing a reload could take index.html and display.js from the network and
// calendar.js and styles.css from cache: the CSS scopes its rules to markup the
// old script does not emit, so the times lose their columns and their colour.
//
// VERSION IS NOT TYPED BY HAND. .github/workflows/stamp.yml rewrites the line
// below with the commit being deployed. Cache-first is only safe if the version
// always changes when the code does, and "remember to bump it" is exactly the
// kind of promise that gets broken on the one commit where it matters.
//
// Data is not part of the shell: minyan times stay network-first with the last
// confirmed copy behind them, and the forecast and version.json are not touched
// at all.
const VERSION = 'df25aaf';   // rewritten on deploy by .github/workflows/stamp.yml
// caches.keys() is ORIGIN-wide, not per-worker. This is served from
// jmand2.github.io/shabbos/, so every other project page on that account shares
// the origin — and an activate that deleted everything it did not recognise
// would wipe their caches too. Ours are the ones carrying this prefix.
const PREFIX = 'shabbos-clock-';
const CACHE = `${PREFIX}${VERSION}`;
const APP = ['util.js', 'calendar.js', 'settings.js', 'minyanim.js', 'weather.js', 'sports.js', 'display.js', 'app.js'];
const FILES = ['./', 'index.html', 'styles.css', ...APP,
  'flights.css', 'flights.js',
  'vendor/kosher-zmanim.min.js', 'data/shuls.json', 'manifest.webmanifest',
  'icons/icon-180.png'];

// The files that move together. A navigation request covers './' and index.html.
// flights.js and flights.css are a pair in the same way app.js and styles.css
// are: the module builds the markup its stylesheet expects, so serving one
// generation's script against another's styles breaks it the same way.
const COUPLED = new RegExp(`/(${[...APP, 'styles.css', 'index.html', 'flights.js', 'flights.css']
  .map((f) => f.replace('.', '\\.')).join('|')})$`);
// Long enough for a slow wifi handshake, short enough that a dead network never
// leaves the wall blank: past this we show the cached generation instead.
const NET_TIMEOUT = 4000;

// addAll is atomic by contract: one failed request rejects the whole thing, the
// cache is left untouched and this worker never activates. That is the property
// the model rests on, so it is deliberately not softened with per-file catches.
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

// One cache entry per path, with the query stripped.
//
// app.js asks for `data/minyanim.json?t=<now>` to defeat the HTTP cache, which
// made every single fetch a NEW cache key. Nothing was ever replaced, the cache
// grew without bound, and the lookup below used ignoreSearch — which returns
// the FIRST match in insertion order, i.e. the OLDEST copy ever stored. A slow
// network past the timeout therefore served the oldest schedule on file rather
// than the newest. Normalising the key means one entry per path, always the
// most recent, and it lines up with the precache, which stores by plain URL.
const cacheKey = (req) => {
  const u = new URL(req.url);
  u.search = '';
  return u.toString();
};

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;

  const url = new URL(e.request.url);

  // The forecast is not cached here at all — not even fresh-first. app.js keeps
  // the last one in localStorage, where it is parsed data it can reason about
  // and date from the observation inside it. A worker-cached copy replayed as a
  // 200 is indistinguishable from a live fetch at the response level, which is
  // a trap worth simply not having. Two caches for one thing, and only one of
  // them can tell you how old it is.
  if (url.hostname.endsWith('open-meteo.com')) return;

  // Nor version.json. A cached copy of the file whose entire job is to say
  // which build this is would be the most misleading thing on the screen.
  if (url.pathname.endsWith('version.json')) return;

  // Nor the scoreboard, and for exactly the reason given above for the
  // forecast. sports.js stamps every answer with `at: Date.now()` and then
  // decides what a game may still claim from that stamp — a live score is only
  // shown for fifteen minutes after the snapshot it came from. A worker replay
  // of a cached scoreboard is a 200 like any other, so a slow network past the
  // timeout handed back an old board and it was dated NOW, buying a licence it
  // had not earned. The app keeps its own copy in localStorage where it is
  // parsed data it can date honestly.
  if (url.hostname.endsWith('espn.com')) return;

  // The shell: served from this generation's cache, full stop. No timeout, no
  // background refresh, no per-file staleness — the whole point is that these
  // cannot disagree with one another. A miss can only mean install did not
  // precache that request, so the network answers for that one alone.
  const isShell = e.request.mode === 'navigate' || COUPLED.test(url.pathname)
    || /\/(vendor\/kosher-zmanim\.min\.js|data\/shuls\.json|manifest\.webmanifest)$/
      .test(url.pathname);

  if (isShell) {
    e.respondWith(caches.match(cacheKey(e.request))
      .then((hit) => hit ?? fetch(e.request).catch(() => Response.error())));
    return;
  }

  // Started and registered synchronously: waitUntil keeps the worker alive long
  // enough for the background refresh to finish writing to the cache.
  const network = fetch(e.request)
    .then(async (res) => {
      if (res.ok) (await caches.open(CACHE)).put(cacheKey(e.request), res.clone());
      return res;
    })
    .catch(() => null);
  e.waitUntil(network);

  e.respondWith((async () => {
    // No ignoreSearch: the keys are normalised above, so there is exactly one
    // entry per path and no oldest-match to fall into.
    const cached = await caches.match(cacheKey(e.request));
    // Nothing cached yet: the network is the only answer, so wait for it.
    if (!cached) return await network ?? Response.error();
    const timeout = new Promise((r) => { setTimeout(() => r(null), NET_TIMEOUT); });
    return await Promise.race([network, timeout]) ?? cached;
  })());
});
