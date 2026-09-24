/* Shabbos Clock — startup, intervals and the appliance lifecycle.

   Loaded as ordinary scripts, in the order index.html lists them, sharing one
   script scope. Not ES modules: jsdom cannot load <script type="module"> at
   all, and both behavioural suites work by loading the real index.html and
   running the real app inside it. Splitting the file was worth doing; giving up
   that harness to get import statements was not. */

const ROTATE_MS = 45000;

/* Start ----------------------------------------------------------------- */

const titleCase = (slug) => slug.split('-')
  .map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

async function start() {
  // The clock is the one thing that must never fail to appear.
  tick();
  setInterval(tick, 1000);

  shuls = await fetch('data/shuls.json').then((r) => r.json())
    .catch(() => settings.shuls.map((slug) => ({ slug, name: titleCase(slug) })));

  buildSettings();
  // Not awaited: the board must never wait on a diagnostic.
  loadBuildStamp();
  render();
  refreshMinyanim();

  refreshWeather();
  refreshSports();

  setInterval(render, 30000);
  setInterval(refreshMinyanim, 1800000);
  setInterval(refreshWeather, WEATHER_REFRESH_MS);
  // Self-scheduling: the gap depends on whether anything is being played.
  scheduleSports();
  setInterval(() => { page += 1; render(); }, ROTATE_MS);
  scheduleOvernightReload();

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  watchWake();
  keepAwake();
}

// The display is never relaunched by hand, so refresh it once in the quiet hours.
//
// Never during Shabbos or Yom Tov. But rescheduling that the obvious way — by
// calling this again — lands on the FOLLOWING 3am, because by then the hour is
// already 3. A deploy made on Friday therefore waited until Sunday morning, and
// across a three-day Yom Tov it waited three nights. It now comes back a couple
// of minutes after the rest period actually ends.
const RELOAD_HOUR = 3;
const AFTER_HAVDALAH_MS = 120000;

function reloadWhenFree() {
  if (!document.body.classList.contains('locked')) { location.reload(); return; }
  const end = restEnd(new Date());
  // No end in sight is not a state this should ever be in; an hour is a safe
  // thing to do about it rather than giving up until tomorrow.
  const at = end ? end.tzeis.getTime() + AFTER_HAVDALAH_MS : Date.now() + 3600000;
  setTimeout(reloadWhenFree, Math.max(60000, at - Date.now()));
}

function scheduleOvernightReload() {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(),
    now.getDate() + (now.getHours() < RELOAD_HOUR ? 0 : 1), RELOAD_HOUR, 0, 0);
  setTimeout(reloadWhenFree, next - now);
}

// The lock is released whenever the document stops being visible, so it has to
// be taken again on the way back. This used to register the listener with
// { once: true } from inside keepAwake: the first visibilitychange after a
// successful request is the visible -> hidden edge, where the handler does
// nothing — and { once: true } removed it anyway. The return to visible then
// had nothing listening, and the screen was free to sleep for good.
//
// Registered once, at start, and never removed. Re-requesting while the lock is
// already held is harmless.
// Remembered so the status panel can say which it is. "The screen keeps going
// to sleep" is the most likely complaint about a wall display, and the answer
// is usually either this or iPadOS Auto-Lock.
let wakeState = 'not requested';

async function keepAwake() {
  try {
    await navigator.wakeLock.request('screen');
    wakeState = 'held';
  } catch (err) {
    wakeState = `unavailable — ${err?.name ?? 'refused'}`;
    /* iPad also needs Settings > Display > Auto-Lock set to Never */
  }
}

function watchWake() {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') keepAwake();
  });
}

start().catch((err) => {
  console.error(err);
  // renderEdge hides this element on an ordinary day, so a throw after the first
  // successful render would otherwise post the warning into a hidden line.
  $('edge').hidden = false;
  $('edge').textContent = 'Zmanim unavailable — reload when back online.';
});
