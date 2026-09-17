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
const FLIGHT_MS = 15000;

const DEFAULTS = {
  shuls: ['beth-aaron', 'ohr-saadya'],
  layout: 'board', perShul: '8', theme: 'auto', accent: 'brass', clockSize: '1',
  face: 'sturdy', seconds: false, showHorizon: true, showZmanim: false,
};

const CHOICES = {
  layout: ['board', 'clock'],
  perShul: ['4', '8', '12'],
  theme: ['auto', 'night', 'day'],
  accent: ['brass', 'copper', 'sage', 'ice'],
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
let lastTicks = '';

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
  }
  // Don't show shkiya/tzeis here - already displayed on horizon
  if (settings.showZmanim) {
    parts.push(`Netz ${clockTime(toDate(info.cal.getSunrise()))}`,
      `Shema ${clockTime(toDate(info.cal.getSofZmanShmaGRA()))}`,
      `Mincha gedola ${clockTime(toDate(info.cal.getMinchaGedola()))}`,
      `Plag ${clockTime(toDate(info.cal.getPlagHamincha()))}`);
  }
  // On an ordinary weekday there is no transition to announce. Hide the element
  // rather than leaving an empty one contributing a gap to the column.
  $('edge').innerHTML = parts.join(' &nbsp;·&nbsp; ');
  $('edge').hidden = !parts.length;
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
  let lines = 0;

  const cards = list.map((shul) => {
    const s = scheduleFor(shul.slug, now);
    if (s.state === 'unavailable') {
      lines += 1;
      return card(shul.name, `<p class="unavailable">Times unavailable — check ${esc(shul.name)}'s own schedule.</p>`);
    }
    if (s.state === 'awaiting') {
      lines += 1;
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
    return card(shul.name, body || '<p class="none">Nothing further listed.</p>');
  });

  // Scale on the number of LINES, which is what actually consumes height, and
  // never below 0.8 — past that the times stop being readable across a room.
  const perCard = lines / Math.max(1, list.length);
  const scale = perCard <= 4 ? 1.15 : perCard <= 6 ? 1 : perCard <= 8 ? 0.9 : 0.8;
  document.documentElement.style.setProperty('--minyan-scale', scale);

  // Cards hug their content, so the clock inherits the rest of the column. A
  // sparse evening gives it room; a full Friday board takes it back.
  const fill = perCard <= 3 ? 1.45 : perCard <= 5 ? 1.25 : perCard <= 7 ? 1.1
    : perCard <= 9 ? 1 : 0.85;
  document.documentElement.style.setProperty('--clock-fill', fill);

  paintBoard(cards.join(''));
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

function renderHorizon(now, info) {
  const figure = document.querySelector('.horizon');
  figure.hidden = !settings.showHorizon;
  if (figure.hidden) return;

  // Past nightfall the day it describes is over. Roll to tomorrow's arc, which
  // is also the day the cards below have already moved to.
  const nightfall = now >= info.tzeis;
  const arcDay = nightfall ? addDays(now, 1) : now;
  const arcCal = nightfall ? zmanim(arcDay) : info.cal;
  const start = toDate(arcCal.getAlos72());
  const end = toDate(arcCal.getTzais());
  const span = end - start;
  const at = (d) => Math.min(100, Math.max(0, ((d - start) / span) * 100));

  $('horizonElapsed').style.width = nightfall ? '0%' : `${at(now)}%`;
  $('horizonStart').textContent = `${nightfall ? 'Tomorrow · ' : ''}Alos ${clockTime(start)}`;
  $('horizonEnd').textContent = `Tzeis ${clockTime(end)}`;

  const marks = shownShuls().flatMap((shul) => {
    const s = scheduleFor(shul.slug, now);
    return s.state === 'ok' ? s.rows : [];
  }).filter((r) => r.at >= start && r.at <= end).sort((a, b) => a.at - b.at);

  // The sun is its own node now: moved in place so its transition runs, and not
  // destroyed every render along with the ticks.
  const sun = $('sun');
  sun.hidden = nightfall;
  if (!nightfall) sun.style.left = `${at(now)}%`;

  const next = marks.find((r) => r.at > now);
  const ticks = marks.map((r) =>
    `<span class="tick${r === next ? ' next' : ''}" style="left:${at(r.at)}%">`
    + `${r === next ? esc(r.time) : ''}</span>`).join('');
  if (ticks !== lastTicks) {
    lastTicks = ticks;
    $('horizonMarks').innerHTML = ticks;
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
  $('dial').hidden = !settings.seconds;
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
  checkFlight(now);
}

/* Something crosses on the hour ---------------------------------------- */

// The grandchildren watch this wall. Once an hour something crosses it, and what
// crosses depends on the hour, so waiting is worth it. Everything here is
// decoration: it never moves a time, and it never blocks a tap.

let lastFlight = -1;

// Same hour always gives the same flight, so a reload mid-wait does not cheat
// anyone out of the one they were promised.
function flightSeed(d) {
  const n = d.getFullYear() * 1e4 + (d.getMonth() + 1) * 100 + d.getDate() + d.getHours() * 7919;
  const x = Math.sin(n) * 43758.5453;
  return x - Math.floor(x);
}

const BIRD = '<svg viewBox="0 0 40 18"><path d="M2 11 Q10 2 20 10 Q30 2 38 11"/></svg>';
const STAR = '<svg viewBox="0 0 60 18"><path d="M4 9 L52 9"/><circle cx="54" cy="9" r="3.5"/></svg>';

function flier(html, { top, size, dur, delay, kind }) {
  const el = document.createElement('span');
  el.className = `flier ${kind}`;
  el.innerHTML = html;
  el.style.top = `${top}%`;
  el.style.setProperty('--size', `${size}px`);
  el.style.setProperty('--dur', `${dur}ms`);
  el.style.animationDelay = `${delay}ms`;
  // Timer rather than animationend: if the animation never fires, the node still
  // goes away, and this display stays up for months.
  setTimeout(() => el.remove(), dur + delay + 1000);
  return el;
}

// Not every WebView has matchMedia. Treat its absence as "motion is fine"
// rather than letting a missing API throw.
function reducedMotion() {
  return typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function launchFlight(now) {
  if (reducedMotion()) return;
  const layer = $('flyway');
  if (!layer) return;
  const info = dayInfo(now);
  const r = flightSeed(now);

  const night = now >= info.tzeis || now < toDate(info.cal.getAlos72());
  if (night) {
    // After dark the sky gets a shooting star instead.
    layer.appendChild(flier(STAR, {
      top: 12 + r * 22, size: 46 + r * 20, dur: 2600, delay: 0, kind: 'star',
    }));
    return;
  }

  const candles = toDate(info.cal.getCandleLighting());
  const rushing = info.civil.jc.isTomorrowShabbosOrYomTov()
    && candles - now > 0 && candles - now < 5400000;

  // Erev Shabbos, the last hour and a half: the whole flock, and in a hurry.
  const count = rushing ? 5 : 1 + Math.floor(r * 3);
  const glider = !rushing && r > 0.88;

  for (let i = 0; i < count; i += 1) {
    const spread = (i % 2 ? -1 : 1) * Math.ceil(i / 2);
    layer.appendChild(flier(BIRD, {
      top: 46 + spread * 3.5 + r * 8,
      size: glider ? 90 : 34 + r * 14,
      dur: glider ? FLIGHT_MS * 1.8 : rushing ? FLIGHT_MS * 0.55 : FLIGHT_MS,
      delay: i * (rushing ? 220 : 700),
      kind: glider ? 'glider' : 'bird',
    }));
  }
}

function checkFlight(now) {
  const hourKey = now.getDate() * 100 + now.getHours();
  if (now.getMinutes() !== 0 || hourKey === lastFlight) return;
  lastFlight = hourKey;
  // This is ornament, and it runs inside the one function that must never fail.
  try { launchFlight(now); } catch (err) { console.error(err); }
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
