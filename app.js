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
  layout: 'board', perShul: '8', theme: 'auto', accent: 'brass', clockSize: '1',
  face: 'sturdy', seconds: false, showHorizon: false, showZmanim: false,
};

const CHOICES = {
  layout: ['board', 'clock'],
  perShul: ['4', '8', '12'],
  theme: ['auto', 'night', 'day'],
  accent: ['brass', 'copper', 'sage', 'ice', 'purple'],
  clockSize: ['0.8', '1', '1.25'],
  face: ['sturdy', 'classic', 'elegant', 'clean'],
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
  if (!today && !tomorrow) return { state: 'unavailable' };

  // Combine today and tomorrow's minyanim, then filter to future ones
  const allRows = [
    ...(today ? flatten(today, now) : []),
    ...(tomorrow ? flatten(tomorrow, addDays(now, 1)) : [])
  ].filter((r) => r.at > now);

  if (!allRows.length) return { state: 'awaiting' };
  return { state: 'ok', rows: allRows };
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
let lastBoard = '';
let lastMarks = '';

function render() {
  const now = new Date();
  const info = dayInfo(now);

  document.body.classList.toggle('day', themeIsDay(now, info));
  document.body.dataset.accent = settings.accent;
  document.body.dataset.face = settings.face;
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
  renderZmanim(info);
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
// The shape clockFace parses, so the horizon sets its meridiems exactly as the
// cards do rather than inventing a second convention.
const clockTimeLong = (d) => { const t = hhmm(d); return `${t.hour}:${t.minute} ${t.meridiem.toUpperCase()}`; };

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
  }
  // On an ordinary weekday there is no transition to announce. Hide the element
  // rather than leaving an empty one contributing a gap to the column.
  $('edge').innerHTML = parts.join(' &nbsp;·&nbsp; ');
  $('edge').hidden = !parts.length;
}

// Netz, shkiya and tzeis, in the tile beside the clock. They used to appear
// only on the horizon, so turning that off — which is now the default — left
// them nowhere. These are the three that pace the day; the setting adds the
// rest for anyone who wants them.
let lastZmanim = '';

function renderZmanim(info) {
  const cal = info.cal;
  const rows = [['Netz', toDate(cal.getSunrise())]];
  if (settings.showZmanim) {
    rows.push(['Shema', toDate(cal.getSofZmanShmaGRA())],
      ['Mincha ged.', toDate(cal.getMinchaGedola())],
      ['Plag', toDate(cal.getPlagHamincha())]);
  }
  rows.push(['Shkiya', info.sunset], ['Tzeis', info.tzeis]);

  const html = rows.filter(([, d]) => d).map(([name, d]) =>
    `<div class="zrow"><span class="zname">${esc(name)}</span>`
    + `<span class="ztime">${clockFace(clockTimeLong(d))}</span></div>`).join('');
  if (html !== lastZmanim) {
    lastZmanim = html;
    $('zmanimList').innerHTML = html;
  }
}

// One writer for the board, so every state updates the cache. Writing the DOM
// directly anywhere else leaves lastBoard stale and the next identical render
// gets skipped.
function paintBoard(html) {
  if (html === lastBoard) return;
  lastBoard = html;
  $('shuls').innerHTML = html;
}

function renderShuls(now) {
  const list = shownShuls();
  if (!list.length) {
    paintBoard('<p class="none">No shuls chosen. Open Settings to pick some.</p>');
    return;
  }

  const cap = Number(settings.perShul);
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  // Counted per card, not pooled. Averaging across the board let one heavy shul
  // hide behind two light ones and clip its own times.
  const perCardLines = [];
  let lines = 0;

  const cards = list.map((shul) => {
    lines = 0;
    const s = scheduleFor(shul.slug, now);
    if (s.state === 'unavailable') {
      lines += 1;
      perCardLines.push(lines);
      return card(shul.name, `<p class="unavailable">Times unavailable — check ${esc(shul.name)}'s own schedule.</p>`);
    }
    if (s.state === 'awaiting') {
      lines += 1;
      perCardLines.push(lines);
      return card(shul.name, '<p class="unavailable">Done for today. Tomorrow\'s times not confirmed yet.</p>');
    }

    // Chronological, then capped so the type can stay large.
    const ahead = [...s.rows].sort((a, b) => a.at - b.at).slice(0, cap);
    const next = ahead[0];

    const byDay = new Map();
    for (const r of ahead) {
      const key = r.at >= midnight ? 'tomorrow' : 'today';
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(r);
    }

    let body = '';
    for (const [day, rows] of byDay) {
      // Tomorrow is always announced. Without this, a board late at night shows
      // tomorrow's 5:10 AM with nothing saying it is not tonight.
      if (day === 'tomorrow' || byDay.size > 1) {
        body += `<p class="group">${day === 'tomorrow' ? 'Tomorrow' : 'Today'}</p>`;
        lines += 1;
      }

      // Same tefillah on one line, but only while its times stay consecutive.
      // Grouping every row that shares a label merges times that are hours
      // apart and then places the row by the earliest of them: Beth Aaron
      // lists Night Selichos at both 5:00 AM and 9:45 PM, which put the last
      // minyan of the day above times sixteen hours earlier. Runs keep the
      // board in the order things actually happen. The label is always the
      // tefillah — never blanked, or Mincha and Maariv collapse into one
      // unlabelled row.
      const runs = [];
      for (const r of rows) {
        const label = r.label.toLowerCase() === r.group ? GROUPS[r.group] : r.label;
        const open = runs[runs.length - 1];
        if (open && open.label === label) open.times.push(r);
        else runs.push({ label, times: [r] });
      }

      // A run of times wraps, so count the lines it will actually occupy.
      // Narrower cards (more shuls across) fit fewer per line.
      const perLine = list.length <= 2 ? 4 : 3;
      for (const { label, times } of runs) {
        lines += Math.ceil(times.length / perLine);
        body += `<span class="label">${esc(label)}</span>`
          + `<span class="times">`
          + times.map((r) => `<span class="time${r === next ? ' next' : ''}">${clockFace(r.time)}</span>`).join('')
          + `</span>`;
      }
    }
    perCardLines.push(lines);
    return card(shul.name, body || '<p class="none">Nothing further listed.</p>');
  });

  // Scale on LINES, which is what actually consumes height, and on the fullest
  // card rather than the average of them.
  const perCard = Math.max(1, ...perCardLines);
  const scale = perCard <= 4 ? 1.15 : perCard <= 6 ? 1 : perCard <= 8 ? 0.9
    : perCard <= 10 ? 0.82 : perCard <= 13 ? 0.72 : 0.64;
  document.documentElement.style.setProperty('--minyan-scale', scale);

  // Cards hug their content, so the clock inherits the rest of the column. A
  // sparse evening gives it room; a full Friday board takes it back.
  const fill = perCard <= 3 ? 1.45 : perCard <= 5 ? 1.25 : perCard <= 7 ? 1.1
    : perCard <= 9 ? 1 : 0.85;
  document.documentElement.style.setProperty('--clock-fill', fill);

  paintBoard(cards.join(''));
  fitBoard();
}

// Fit to the box, in both directions.
//
// The line count is only a first guess. This measures, and — the part that was
// missing — it GROWS as well as shrinks. Cards fill their cells, so any room
// left over is legibility left on the table: on a wall display read across a
// room, empty panel is worse than large numerals. Shrink-only sizing is why
// every card was a small table floating in a large blank rectangle.
//
// Binary search on the scale: find the largest value where the tallest card
// still fits its cell, both ways.
const MIN_SCALE = 0.45;
const MAX_SCALE = 2.6;

function fitBoard() {
  const cards = [...document.querySelectorAll('.card')];
  if (!cards.length) return;
  // No layout (jsdom, or a hidden board) reports 0 for everything, and a search
  // against zeros would settle on nonsense. Leave the heuristic value alone.
  if (!cards.some((c) => c.clientHeight > 0)) return;

  // Measure the body, not just the card. The card clips (overflow: hidden), so
  // the rows can spill out of the body while the card itself still reports no
  // overflow — the test would pass on content that is already being cut off.
  const boxes = cards.flatMap((c) => [c, c.querySelector('.body')]).filter(Boolean);
  const root = document.documentElement;
  const fits = (v) => {
    root.style.setProperty('--minyan-scale', v);
    return boxes.every((b) => b.scrollHeight <= b.clientHeight + 1
      && b.scrollWidth <= b.clientWidth + 1);
  };

  if (fits(MAX_SCALE)) return;          // everything fits at the ceiling
  if (!fits(MIN_SCALE)) return;         // cannot fit even at the floor

  let lo = MIN_SCALE;
  let hi = MAX_SCALE;
  for (let i = 0; i < 9; i += 1) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid; else hi = mid;
  }
  fits(lo);
}

// The numerals carry the information and the meridiem only disambiguates them,
// so they are separated and set at different weights rather than run together
// as one string. Anything that does not parse is left exactly as it arrived —
// these are real schedule times and are never reformatted into a guess.
function clockFace(text) {
  const m = /^(\d{1,2}):(\d{2})\s*([AP])M$/i.exec(String(text).trim());
  if (!m) return esc(text);
  return `<span class="hm">${m[1]}:${m[2]}</span>`
    + `<span class="ap">${m[3].toLowerCase()}m</span>`;
}

const card = (name, body) => `<article class="card"><h2>${esc(name)}</h2><div class="body">${body}</div></article>`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// The strip is the solar day and nothing else: dawn to nightfall, the zmanim
// that actually divide it, and the sun at now. It used to plot every upcoming
// minyan as an unlabelled tick, which put two shuls davening at the same time
// on top of each other, clipped the one labelled tick off the edge when it fell
// near dawn, and disagreed with the cards after tzeis. The cards carry minyan
// times in numerals that can be read across a room; this carries the day.
function renderHorizon(now, info) {
  const figure = document.querySelector('.horizon');
  figure.hidden = !settings.showHorizon;
  if (figure.hidden) return;

  // Past nightfall the day it describes is over, so it moves on to tomorrow's.
  const nightfall = now >= info.tzeis;
  const cal = nightfall ? zmanim(addDays(now, 1)) : info.cal;
  const start = toDate(cal.getAlos72());
  const end = toDate(cal.getTzais());
  const span = end - start;
  const at = (d) => Math.min(100, Math.max(0, ((d - start) / span) * 100));

  $('horizonElapsed').style.width = nightfall ? '0%' : `${at(now)}%`;

  // Its own node, moved in place so the transition runs rather than being
  // destroyed and rebuilt on every render.
  const sun = $('sun');
  sun.hidden = nightfall;
  if (!nightfall) sun.style.left = `${at(now)}%`;

  // Split across two rows by what each mark is. The sun's own two moments go
  // above the line, the halachic boundaries below it. That is not only tidy: it
  // is what keeps them apart. Netz sits ~8% in and shkiya ~95%, so on one row
  // each would crowd the end next to it — "Tomorrow · Alos" ran straight into
  // Netz, and shkiya into tzeis. Split, each row spans almost the whole bar.
  // The two ends anchor to their edges rather than centring on them, or half
  // the label hangs off the screen.
  const marks = [
    { name: nightfall ? 'Tomorrow · Alos' : 'Alos', at: start, cls: 'first' },
    { name: 'Netz', at: toDate(cal.getSunrise()), cls: 'up' },
    { name: 'Chatzos', at: toDate(cal.getChatzos()) },
    { name: 'Shkiya', at: toDate(cal.getSunset()), cls: 'up' },
    { name: 'Tzeis', at: end, cls: 'last' },
  ];
  const html = marks.map((m) => `<span class="zman ${m.cls ?? ''}" style="left:${at(m.at)}%">`
    + `<i></i><b>${esc(m.name)}</b><s>${clockFace(clockTimeLong(m.at))}</s></span>`).join('');
  if (html !== lastMarks) {
    lastMarks = html;
    $('horizonMarks').innerHTML = html;
  }
}

function renderFreshness() {
  const stamp = minyanim.generated_at ? new Date(minyanim.generated_at) : null;
  if (!stamp) { $('freshness').textContent = 'No minyan data yet'; return; }
  const hours = (Date.now() - stamp) / 3.6e6;
  $('freshness').textContent = hours > STALE_HOURS
    ? `Times last confirmed ${stamp.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
    : 'Times from teaneckminyanim.com';
}

// The hand's angle only ever increases. Feeding it seconds * 6 would send it
// backwards through a whole revolution at 59 -> 0, which the detent transition
// would then animate; accumulating the step keeps every move a forward one.
// Steps are taken mod 60 seconds, so the angle stays correct mod 360 even after
// the dial has been switched off for a while.
let handAngle = null;
let handAt = -1;

function paintDial(now) {
  // hidden is a property of HTMLElement, and the dial is an <svg>. Assigning
  // el.hidden there sets a plain expando: no attribute is reflected, the
  // stylesheet's [hidden] never matches, and the dial stays on the screen
  // whatever the setting says. toggleAttribute sets the real attribute.
  $('dial').toggleAttribute('hidden', !settings.seconds);
  const second = now.getSeconds();
  if (second === handAt) return;
  const hand = $('dialHand');
  const first = handAngle === null;
  handAngle = first ? second * 6 : handAngle + (((second - handAt + 60) % 60) * 6);
  handAt = second;
  // On the very first paint the hand would wind up from twelve to wherever it
  // belongs. Place it, then let the detent run from the next step on.
  hand.style.transition = first ? 'none' : '';
  hand.style.transform = `rotate(${handAngle}deg)`;
}

function tick() {
  const now = new Date();
  const t = hhmm(now);
  $('clockTime').textContent = `${t.hour}:${t.minute}`;
  $('clockMer').textContent = t.meridiem;
  paintDial(now);
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
    ['accent', 'accent'], ['clockSize', 'clockSize'], ['face', 'face']]) {
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
  // renderEdge hides this element on an ordinary day, so a throw after the first
  // successful render would otherwise post the warning into a hidden line.
  $('edge').hidden = false;
  $('edge').textContent = 'Zmanim unavailable — reload when back online.';
});
