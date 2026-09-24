/* Shabbos Clock — what the person chose, and the sheet they chose it in.

   Loaded as ordinary scripts, in the order index.html lists them, sharing one
   script scope. Not ES modules: jsdom cannot load <script type="module"> at
   all, and both behavioural suites work by loading the real index.html and
   running the real app inside it. Splitting the file was worth doing; giving up
   that harness to get import statements was not. */

const STORE = 'shabbos-clock-settings';
const DEFAULTS = {
  shuls: ['beth-aaron', 'ohr-saadya'],
  layout: 'board', perShul: 'auto', theme: 'auto', accent: 'brass', clockSize: '1',
  face: 'sturdy', seconds: false, showHorizon: false, showZmanim: false,
  showWeather: true, units: 'F',
};

const CHOICES = {
  layout: ['board', 'clock'],
  perShul: ['auto', '4', '8', '12'],
  theme: ['auto', 'night', 'day'],
  accent: ['brass', 'copper', 'sage', 'ice', 'purple'],
  clockSize: ['0.8', '1', '1.25'],
  face: ['sturdy', 'classic', 'elegant', 'clean'],
  units: ['F', 'C'],
};

// A stored value outside the allowed set blanks its select, and for perShul it
// would empty every card via Number('nonsense') -> NaN.
function sanitise(raw) {
  const out = { ...DEFAULTS, ...raw };
  for (const [key, allowed] of Object.entries(CHOICES)) {
    if (!allowed.includes(String(out[key]))) out[key] = DEFAULTS[key];
    else out[key] = String(out[key]);
  }
  if (!Array.isArray(out.shuls)) out.shuls = DEFAULTS.shuls;
  for (const key of ['seconds', 'showHorizon', 'showZmanim', 'showWeather']) {
    out[key] = Boolean(out[key]);
  }
  return out;
}

let settings = sanitise(readJSON(STORE));
function save() { localStorage.setItem(STORE, JSON.stringify(settings)); }

/* Status ---------------------------------------------------------------- */
// Everything an unattended appliance cannot tell you from across the room. It
// lives behind Settings because the board itself should stay a board — the
// footer's one line is the right amount out there, and this is the rest of it.

const ago = (t) => {
  if (!t) return 'never';
  const mins = Math.round((Date.now() - new Date(t).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)} days ago`;
};

async function cacheVersion() {
  try {
    const keys = await caches.keys();
    const ours = keys.filter((k) => k.startsWith('shabbos-clock-'));
    return ours.length ? ours.join(', ') : 'none yet';
  } catch { return 'unavailable'; }
}

function shulSources(now) {
  const today = isoOf(now);
  return shuls.filter((s) => settings.shuls.includes(s.slug)).map((s) => {
    const entry = minyanim.days?.[today]?.[s.slug];
    if (!entry) return [s.name, 'no times for today'];
    const src = entry.source === 'shul' ? 'own website' : 'teaneckminyanim.com';
    return [s.name, `${src} · ${ago(entry.fetched_at ?? minyanim.generated_at)}`];
  });
}

async function renderStatus() {
  const el = $('status');
  if (!el || $('sheet').hidden) return;
  const now = new Date();
  const days = Object.keys(minyanim.days ?? {}).sort();
  const forward = days.filter((d) => d >= isoOf(now));
  // flights.js owns the photos and its own passphrase; it publishes this if it
  // is loaded, and the panel simply omits the row when it is not.
  const flights = window.shabbosFlights?.status?.();

  const rows = [
    ['App cache', await cacheVersion()],
    ['Network', navigator.onLine ? 'online' : 'offline'],
    ['Screen wake lock', wakeState],
    ['Minyan data', days.length
      ? `${forward.length} day(s) ahead · ${days[0]} to ${days.at(-1)}` : 'none'],
    ['Last scrape', ago(minyanim.generated_at)],
    ['Weather', weather
      ? `${weatherAge() === null ? 'age unknown' : ago(weather.observed_at)}`
      + `${settings.showWeather ? '' : ' · hidden'}`
      : 'never fetched'],
    ...(flights ? [['Family photos', flights]] : []),
    ...shulSources(now),
  ];

  el.innerHTML = rows.map(([k, v]) =>
    `<div class="srow"><span>${esc(k)}</span><b>${esc(String(v))}</b></div>`).join('');
}

/* Settings -------------------------------------------------------------- */

let statusTimer = null;

// The chosen shuls first and in their own order, with the rest below. Grouping
// them this way is the only affordance ordering needs: 23 alphabetical
// checkboxes give nowhere to express "these three, in this order".
function renderPicker() {
  const chosen = chosenShuls();
  const rest = shuls.filter((s) => !settings.shuls.includes(s.slug));
  const row = (s, i, n) => `<div class="pick${n ? ' on' : ''}">`
    + `<label><input type="checkbox" value="${esc(s.slug)}"${n ? ' checked' : ''}>`
    + `<span>${esc(s.name)}</span></label>`
    + (n ? `<button type="button" class="move" data-dir="-1" data-slug="${esc(s.slug)}"`
      + `${i === 0 ? ' disabled' : ''} aria-label="Move ${esc(s.name)} up">&uarr;</button>`
      + `<button type="button" class="move" data-dir="1" data-slug="${esc(s.slug)}"`
      + `${i === n - 1 ? ' disabled' : ''} aria-label="Move ${esc(s.name)} down">&darr;</button>` : '')
    + `</div>`;
  $('shulPicker').innerHTML =
    (chosen.length ? `<p class="pickhead">On the board${chosen.length > PER_PAGE
      ? ` — ${PER_PAGE} at a time, in this order` : ''}</p>` : '')
    + chosen.map((s, i) => row(s, i, chosen.length)).join('')
    + `<p class="pickhead">Not shown</p>`
    + rest.map((s) => row(s, 0, 0)).join('');
}

function buildSettings() {
  renderPicker();
  $('shulPicker').addEventListener('change', (e) => {
    const { value, checked } = e.target;
    // Appended, not inserted: a shul just ticked goes to the end, where it is
    // visible and can be walked up if it belongs higher.
    settings.shuls = checked
      ? [...settings.shuls, value]
      : settings.shuls.filter((s) => s !== value);
    save(); renderPicker(); render();
  });
  $('shulPicker').addEventListener('click', (e) => {
    const btn = e.target.closest('.move');
    if (!btn) return;
    const from = settings.shuls.indexOf(btn.dataset.slug);
    const to = from + Number(btn.dataset.dir);
    if (from < 0 || to < 0 || to >= settings.shuls.length) return;
    const next = [...settings.shuls];
    [next[from], next[to]] = [next[to], next[from]];
    settings.shuls = next;
    // Back to the first page, so the effect of the move is on screen rather
    // than three pages away.
    page = 0;
    save(); renderPicker(); render();
  });

  for (const [id, key] of [['layout', 'layout'], ['perShul', 'perShul'], ['theme', 'theme'],
    ['accent', 'accent'], ['clockSize', 'clockSize'], ['face', 'face'], ['units', 'units']]) {
    $(id).value = settings[key];
    // The strip is memoised on its own markup, and a unit change produces the
    // same span and the same hours — only different numbers. Clear the cache or
    // the board keeps the degrees it already had.
    $(id).addEventListener('change', () => {
      settings[key] = $(id).value; lastWeather = ''; save(); render();
    });
  }
  for (const key of ['seconds', 'showHorizon', 'showZmanim', 'showWeather']) {
    $(key).checked = settings[key];
    $(key).addEventListener('change', () => { settings[key] = $(key).checked; save(); render(); tick(); });
  }
  $('gear').addEventListener('click', () => {
    $('sheet').hidden = false;
    renderStatus();
    // Refreshed while the sheet is open, so somebody watching can see the
    // network come back rather than having to close and reopen it.
    statusTimer ??= setInterval(renderStatus, 5000);
  });
  $('close').addEventListener('click', () => {
    $('sheet').hidden = true;
    clearInterval(statusTimer);
    statusTimer = null;
  });
}

