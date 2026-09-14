/* Shabbos Clock — wall display for Teaneck.
   Zmanim, Hebrew date, parsha and Yom Tov are computed here and are always right.
   Minyan times are only ever shown when they were pulled from a real schedule. */

const KZ = window.KosherZmanim;
const PLACE = { name: 'Teaneck', lat: 40.9068, lon: -74.0104, elev: 30, tz: 'America/New_York' };
const GEO = new KZ.GeoLocation(PLACE.name, PLACE.lat, PLACE.lon, PLACE.elev, PLACE.tz);
const STORE = 'shabbos-clock-settings';
const CACHE = 'shabbos-clock-minyanim';
const STALE_HOURS = 36;
const ROTATE_MS = 45000;
const PER_PAGE = 3;

const DEFAULTS = {
  shuls: ['beth-aaron', 'ohr-saadya'],
  layout: 'board', perShul: '3', theme: 'auto', accent: 'brass', clockSize: '1',
  seconds: false, showHorizon: true, showZmanim: false,
};

const CHOICES = {
  layout: ['board', 'clock'],
  perShul: ['2', '3', '4'],
  theme: ['auto', 'night', 'day'],
  accent: ['brass', 'copper', 'sage', 'ice'],
  clockSize: ['0.8', '1', '1.25'],
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
  for (const key of ['seconds', 'showHorizon', 'showZmanim']) out[key] = Boolean(out[key]);
  return out;
}

let settings = sanitise(readJSON(STORE));
let minyanim = readJSON(CACHE) ?? { days: {} };
let shuls = [];
let page = 0;

const $ = (id) => document.getElementById(id);
function readJSON(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } }
function save() { localStorage.setItem(STORE, JSON.stringify(settings)); }

/* Dates and zmanim ------------------------------------------------------ */

const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, 12);
const toDate = (dt) => (dt ? dt.toJSDate() : null);

function zmanim(day) {
  const cal = new KZ.ComplexZmanimCalendar(GEO);
  cal.setDate(KZ.Luxon.DateTime.fromJSDate(day).setZone(PLACE.tz));
  return cal;
}

function dayInfo(now) {
  const cal = zmanim(now);
  const sunset = toDate(cal.getSunset());
  const tzeis = toDate(cal.getTzais());
  const civil = new JewishDay(now);
  // The Hebrew date turns at sunset.
  const hebrewFor = now >= sunset ? addDays(now, 1) : now;
  return { cal, sunset, tzeis, civil, hebrewFor, hebrew: new JewishDay(hebrewFor) };
}

function JewishDay(d) {
  this.jc = new KZ.JewishCalendar(new Date(d.getFullYear(), d.getMonth(), d.getDate()));
}

const fmtHeb = new KZ.HebrewDateFormatter();
fmtHeb.setHebrewFormat(true);
const fmtEng = new KZ.HebrewDateFormatter();

function occasionOf(jc, from) {
  const name = fmtEng.formatYomTov(jc);   // already includes the Chanukah day number
  const parsha = fmtEng.formatParsha(jc);
  if (name && parsha) return `${name} · ${parsha}`;
  return name || parsha || fmtEng.formatParsha(new KZ.JewishCalendar(nextShabbos(from)));
}

// Counted from the day being displayed, so once Shabbos is out this moves on to
// next week's parsha instead of repeating the one just read.
function nextShabbos(from) {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7));
  return d;
}

/* Is work forbidden right now? Drives the no-touch lock. */
function isLocked(now, info) {
  const candles = toDate(info.cal.getCandleLighting());
  if (info.civil.jc.isAssurBemelacha() && now < info.tzeis) return true;
  return info.civil.jc.isTomorrowShabbosOrYomTov() && now >= candles;
}

// Walks forward to the end of the current rest period, so Friday night shows
// havdalah and a three-day Yom Tov shows the day it actually ends.
function restEndsAt(now) {
  for (let i = 0; i < 4; i += 1) {
    const day = addDays(now, i);
    const jc = new JewishDay(day).jc;
    if (!jc.isAssurBemelacha() || jc.isTomorrowShabbosOrYomTov()) continue;
    const tzeis = toDate(zmanim(day).getTzais());
    if (tzeis > now) return tzeis;
  }
  return now;
}

/* Minyan data ----------------------------------------------------------- */

const timeToDate = (base, text) => {
  const m = /^(\d{1,2}):(\d{2})\s*([AP])M$/i.exec(text);
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (m[3].toUpperCase() === 'P') h += 12;
  return new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, Number(m[2]));
};

function scheduleFor(slug, now) {
  const today = minyanim.days?.[isoOf(now)]?.[slug];
  const tomorrow = minyanim.days?.[isoOf(addDays(now, 1))]?.[slug];
  if (!today) return { state: 'unavailable' };
  const rows = flatten(today, now);
  if (rows.some((r) => r.at > now)) return { state: 'ok', when: 'today', rows };
  if (tomorrow) return { state: 'ok', when: 'tomorrow', rows: flatten(tomorrow, addDays(now, 1)) };
  return { state: 'awaiting' };
}

function flatten(sections, base) {
  return ['shacharis', 'mincha', 'maariv'].flatMap((group) =>
    (sections[group] ?? []).map((row) => ({ ...row, group, at: timeToDate(base, row.time) })))
    .filter((row) => row.at);
}

async function refreshMinyanim() {
  try {
    const res = await fetch(`data/minyanim.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    if (!data.days) return;
    minyanim = data;
    localStorage.setItem(CACHE, JSON.stringify(data));
    render();
  } catch { /* keep showing the last confirmed data */ }
}

/* Rendering ------------------------------------------------------------- */

function shownShuls() {
  const chosen = shuls.filter((s) => settings.shuls.includes(s.slug));
  if (chosen.length <= PER_PAGE) return chosen;
  const pages = Math.ceil(chosen.length / PER_PAGE);
  const start = (page % pages) * PER_PAGE;
  return chosen.slice(start, start + PER_PAGE);
}

const GROUPS = { shacharis: 'Shacharis', mincha: 'Mincha', maariv: 'Maariv' };

function render() {
  const now = new Date();
  const info = dayInfo(now);

  document.body.classList.toggle('day', themeIsDay(now, info));
  document.body.dataset.accent = settings.accent;
  const locked = isLocked(now, info);
  document.body.classList.toggle('locked', locked);
  document.body.classList.toggle('clock-only', settings.layout === 'clock');
  if (locked) $('sheet').hidden = true;   // never leave settings open into Shabbos
  document.documentElement.style.setProperty('--clock-scale', settings.clockSize);

  $('hebrewDate').textContent = fmtHeb.format(info.hebrew.jc);
  $('occasion').textContent = occasionOf(info.hebrew.jc, info.hebrewFor);
  $('civilDate').textContent = now.toLocaleDateString('en-US',
    { weekday: 'long', month: 'long', day: 'numeric' });

  renderEdge(now, info);
  renderShuls(now);
  renderHorizon(now, info);
  renderFreshness();
}

function themeIsDay(now, info) {
  if (settings.theme !== 'auto') return settings.theme === 'day';
  return now >= toDate(info.cal.getSunrise()) && now < info.sunset;
}

// Formatted by hand: some iOS builds separate the meridiem with U+202F rather
// than a space, which breaks any parse of toLocaleTimeString output.
function hhmm(d) {
  return { hour: d.getHours() % 12 || 12,
    minute: String(d.getMinutes()).padStart(2, '0'),
    meridiem: d.getHours() < 12 ? 'am' : 'pm' };
}

const clockTime = (d) => { const t = hhmm(d); return `${t.hour}:${t.minute}${t.meridiem[0]}`; };

function renderEdge(now, info) {
  const jc = info.civil.jc;
  const candles = toDate(info.cal.getCandleLighting());
  const restingNow = jc.isAssurBemelacha() && now < info.tzeis;
  const restingNext = jc.isTomorrowShabbosOrYomTov();
  const parts = [];
  if (restingNow && restingNext) {
    // Another day of rest starts tonight. Into Shabbos, lighting is at the usual
    // time; into a second day of Yom Tov, nothing is lit until nightfall.
    const intoShabbos = now.getDay() === 5;
    const lightAt = intoShabbos ? candles : info.tzeis;
    if (now < lightAt) {
      parts.push(`Candle lighting ${intoShabbos ? '' : 'after '}<b>${clockTime(lightAt)}</b>`);
    } else {
      parts.push(`Havdalah <b>${clockTime(restEndsAt(now))}</b>`);
    }
  } else if (isLocked(now, info)) {
    parts.push(`Havdalah <b>${clockTime(restEndsAt(now))}</b>`);
  } else if (restingNext && now < candles) {
    parts.push(`Candle lighting <b>${clockTime(candles)}</b>`);
  } else {
    parts.push(`Shkiya ${clockTime(info.sunset)}`, `Tzeis ${clockTime(info.tzeis)}`);
  }
  if (settings.showZmanim) {
    parts.push(`Netz ${clockTime(toDate(info.cal.getSunrise()))}`,
      `Shema ${clockTime(toDate(info.cal.getSofZmanShmaGRA()))}`,
      `Mincha gedola ${clockTime(toDate(info.cal.getMinchaGedola()))}`,
      `Plag ${clockTime(toDate(info.cal.getPlagHamincha()))}`);
  }
  $('edge').innerHTML = parts.join(' &nbsp;·&nbsp; ');
}

function renderShuls(now) {
  const list = shownShuls();
  if (!list.length) {
    $('shuls').innerHTML = '<p class="none">No shuls chosen. Open Settings to pick some.</p>';
    return;
  }

  // Count total minyanim across all cards to scale font size
  let totalMinyanim = 0;
  const cardsData = list.map((shul) => {
    const s = scheduleFor(shul.slug, now);
    if (s.state === 'unavailable') {
      return { shul, html: card(shul.name, `<p class="unavailable">Times unavailable — check ${esc(shul.name)}'s own schedule.</p>`) };
    }
    if (s.state === 'awaiting') {
      return { shul, html: card(shul.name, '<p class="unavailable">Done for today. Tomorrow\'s times not confirmed yet.</p>') };
    }
    const ahead = s.rows.filter((r) => r.at > now).sort((a, b) => a.at - b.at)
      .slice(0, Number(settings.perShul));
    totalMinyanim += ahead.length;
    const next = ahead[0];
    const body = ['shacharis', 'mincha', 'maariv'].map((group) => {
      const rows = ahead.filter((r) => r.group === group);
      if (!rows.length) return '';
      // If all labels in this group contain a slash (like "Mincha/Maariv"), skip the header
      const allCombined = rows.every((r) => r.label.includes('/'));
      const header = allCombined ? '' : `<p class="group">${GROUPS[group]}${s.when === 'tomorrow' ? ' · tomorrow' : ''}</p>`;
      return header +
        rows.map((r) => {
          const label = r.label.toLowerCase() === group ? (r.note ?? '') : r.label;
          return `<div class="minyan${r === next ? ' next' : ''}">` +
            `<span class="label">${esc(label)}</span><span>${esc(r.time)}</span></div>`;
        }).join('');
    }).join('');
    return { shul, html: card(shul.name, body || '<p class="none">Nothing further listed.</p>') };
  });

  // Scale minyan font size based on total count
  // Fewer minyanim = larger text for readability across the room
  const scale = totalMinyanim <= 2 ? 1.2 : totalMinyanim <= 4 ? 1.1 : 1;
  document.documentElement.style.setProperty('--minyan-scale', scale);

  $('shuls').innerHTML = cardsData.map((c) => c.html).join('');
}

const card = (name, body) => `<article class="card"><h2>${esc(name)}</h2>${body}</article>`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function renderHorizon(now, info) {
  const figure = document.querySelector('.horizon');
  figure.hidden = !settings.showHorizon;
  if (figure.hidden) return;

  const start = toDate(info.cal.getAlos72());
  const end = info.tzeis;
  const span = end - start;
  const at = (d) => Math.min(100, Math.max(0, ((d - start) / span) * 100));

  $('horizonElapsed').style.width = `${at(now)}%`;
  $('horizonStart').textContent = `Alos ${clockTime(start)}`;
  $('horizonEnd').textContent = `Tzeis ${clockTime(end)}`;

  const marks = shownShuls().flatMap((shul) => {
    const s = scheduleFor(shul.slug, now);
    return s.state === 'ok' && s.when === 'today' ? s.rows : [];
  }).filter((r) => r.at >= start && r.at <= end).sort((a, b) => a.at - b.at);

  const next = marks.find((r) => r.at > now);
  $('horizonMarks').innerHTML =
    `<span class="sun" style="left:${at(now)}%"></span>` +
    marks.map((r) => `<span class="tick${r === next ? ' next' : ''}" style="left:${at(r.at)}%">` +
      `${r === next ? esc(r.time) : ''}</span>`).join('');
}

function renderFreshness() {
  const stamp = minyanim.generated_at ? new Date(minyanim.generated_at) : null;
  if (!stamp) { $('freshness').textContent = 'No minyan data yet'; return; }
  const hours = (Date.now() - stamp) / 3.6e6;
  $('freshness').textContent = hours > STALE_HOURS
    ? `Times last confirmed ${stamp.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
    : 'Times from teaneckminyanim.com';
}

let lastTime = '';
function tick() {
  const now = new Date();
  const t = hhmm(now);
  const secs = settings.seconds
    ? `<span class="sec">:${String(now.getSeconds()).padStart(2, '0')}</span>` : '';
  const currentTime = `${t.hour}:${t.minute}`;

  // Wrap each character in a span for flip animation
  const timeHTML = currentTime.split('').map((char, i) => {
    const wasChar = lastTime[i] || '';
    const changed = char !== wasChar;
    return char === ':'
      ? ':'
      : `<span class="digit${changed ? ' flip' : ''}">${char}</span>`;
  }).join('');

  $('clock').innerHTML = `${timeHTML}${secs}<span class="mer">${t.meridiem}</span>`;
  lastTime = currentTime;
}

/* Settings -------------------------------------------------------------- */

function buildSettings() {
  $('shulPicker').innerHTML = shuls.map((s) =>
    `<label><input type="checkbox" value="${esc(s.slug)}"${settings.shuls.includes(s.slug) ? ' checked' : ''}>` +
    `<span>${esc(s.name)}</span></label>`).join('');
  $('shulPicker').addEventListener('change', (e) => {
    const { value, checked } = e.target;
    settings.shuls = checked
      ? [...settings.shuls, value]
      : settings.shuls.filter((s) => s !== value);
    save(); render();
  });

  for (const [id, key] of [['layout', 'layout'], ['perShul', 'perShul'], ['theme', 'theme'],
    ['accent', 'accent'], ['clockSize', 'clockSize']]) {
    $(id).value = settings[key];
    $(id).addEventListener('change', () => { settings[key] = $(id).value; save(); render(); });
  }
  for (const key of ['seconds', 'showHorizon', 'showZmanim']) {
    $(key).checked = settings[key];
    $(key).addEventListener('change', () => { settings[key] = $(key).checked; save(); render(); tick(); });
  }
  $('gear').addEventListener('click', () => { $('sheet').hidden = false; });
  $('close').addEventListener('click', () => { $('sheet').hidden = true; });
}

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
  render();
  refreshMinyanim();

  setInterval(render, 30000);
  setInterval(refreshMinyanim, 1800000);
  setInterval(() => { page += 1; render(); }, ROTATE_MS);
  scheduleOvernightReload();

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  keepAwake();
}

// The display is never relaunched by hand, so refresh it once in the quiet hours.
function scheduleOvernightReload() {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(),
    now.getDate() + (now.getHours() < 3 ? 0 : 1), 3, 0, 0);
  setTimeout(() => {
    if (document.body.classList.contains('locked')) scheduleOvernightReload();
    else location.reload();
  }, next - now);
}

async function keepAwake() {
  try {
    await navigator.wakeLock.request('screen');
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') keepAwake();
    }, { once: true });
  } catch { /* iPad also needs Settings > Display > Auto-Lock set to Never */ }
}

start().catch((err) => {
  console.error(err);
  document.getElementById('edge').textContent = 'Zmanim unavailable — reload when back online.';
});
