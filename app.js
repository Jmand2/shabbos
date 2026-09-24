/* Shabbos Clock — wall display for Teaneck.
   Zmanim, Hebrew date, parsha and Yom Tov are computed here and are always right.
   Minyan times are only ever shown when they were pulled from a real schedule. */

const KZ = window.KosherZmanim;
const PLACE = { name: 'Teaneck', lat: 40.9068, lon: -74.0104, elev: 30, tz: 'America/New_York' };
const GEO = new KZ.GeoLocation(PLACE.name, PLACE.lat, PLACE.lon, PLACE.elev, PLACE.tz);
const STORE = 'shabbos-clock-settings';
const CACHE = 'shabbos-clock-minyanim';
const WEATHER_CACHE = 'shabbos-clock-weather';
const STALE_HOURS = 36;
// Open-Meteo: no key, no account, CORS from the browser, and it will hand back
// hourly values for the next fortnight — which is what makes a three-day Yom
// Tov no harder than a Tuesday. Always asked for in Fahrenheit and converted on
// screen, so the units toggle costs no refetch and works offline.
const WEATHER_URL = `https://api.open-meteo.com/v1/forecast?latitude=${PLACE.lat}`
  + `&longitude=${PLACE.lon}`
  + '&hourly=temperature_2m,apparent_temperature,precipitation_probability,weather_code,is_day'
  + '&current=temperature_2m,apparent_temperature,weather_code,is_day'
  + '&daily=temperature_2m_max,temperature_2m_min'
  + `&temperature_unit=fahrenheit&timezone=${encodeURIComponent(PLACE.tz)}&forecast_days=4`;
// A wall read from across a room fits about this many columns before they stop
// being legible. Past it the window simply rolls forward with the hour.
const WEATHER_HOURS = 12;
// Below this a strip is a stub, not a forecast. A Shabbos with two hours left
// falls back to the plain hours ahead rather than showing two columns under a
// heading that promises a day.
const WEATHER_MIN_HOURS = 6;
const WEATHER_REFRESH_MS = 1200000;   // 20 min; the model itself updates hourly
// Six missed refreshes. Past this the strip is still worth showing — a forecast
// is about the hours ahead, and those do not expire the way an observation does
// — but it must stop presenting itself as current.
const WEATHER_STALE_MS = 7200000;    // 2 hours
// Past this the "now" reading is not a reading. The hourly row for the current
// hour is at least a forecast ABOUT now, rather than an observation from
// whenever the network last worked.
const WEATHER_DEAD_MS = 21600000;    // 6 hours
const ROTATE_MS = 45000;
const PER_PAGE = 3;

const DEFAULTS = {
  shuls: ['beth-aaron', 'ohr-saadya'],
  layout: 'board', perShul: '8', theme: 'auto', accent: 'brass', clockSize: '1',
  face: 'sturdy', seconds: false, showHorizon: false, showZmanim: false,
  showWeather: true, units: 'F',
};

const CHOICES = {
  layout: ['board', 'clock'],
  perShul: ['4', '8', '12'],
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
let minyanim = readJSON(CACHE) ?? { days: {} };
// The last forecast we were handed. Read before the first fetch returns, so a
// display that wakes up with no network still shows a sky rather than nothing.
let weather = readJSON(WEATHER_CACHE);
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
// havdalah and a three-day Yom Tov shows the day it actually ends. Returns the
// day as well: a shul's havdalah is read off that day's maariv, not off tzeis.
function restEnd(now) {
  for (let i = 0; i < 4; i += 1) {
    const day = addDays(now, i);
    const jc = new JewishDay(day).jc;
    if (!jc.isAssurBemelacha() || jc.isTomorrowShabbosOrYomTov()) continue;
    const tzeis = toDate(zmanim(day).getTzais());
    if (tzeis > now) return { day, tzeis };
  }
  return null;
}
const restEndsAt = (now) => restEnd(now)?.tzeis ?? now;

/* Minyan data ----------------------------------------------------------- */

const timeToDate = (base, text) => {
  const m = /^(\d{1,2}):(\d{2})\s*([AP])M$/i.exec(text);
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (m[3].toUpperCase() === 'P') h += 12;
  return new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, Number(m[2]));
};

// The days the board reaches: today and tomorrow normally, and the whole of a
// rest period when we are in one or about to be. A three-day Yom Tov used to
// show its first two days and never its third — you could stand on day one and
// have no way to see Shabbos.
function daysShown(now, info) {
  const out = [now, addDays(now, 1)];
  const jc = info.civil.jc;
  const inIt = jc.isAssurBemelacha() && now < info.tzeis;
  // restEnd walks forward whenever it is asked, so on an ordinary Tuesday it
  // would happily return the coming Shabbos and stretch the board across the
  // week. Only ask when a rest period is actually current or imminent.
  if (!inIt && !jc.isTomorrowShabbosOrYomTov()) return out;
  const end = restEnd(now);
  if (!end) return out;
  for (let i = 2; i < 5; i += 1) {
    const day = addDays(now, i);
    if (day > end.day) break;
    out.push(day);
  }
  return out;
}

function scheduleFor(slug, now, days) {
  const rows = [];
  let known = false;
  for (const day of days) {
    const entry = minyanim.days?.[isoOf(day)]?.[slug];
    if (!entry) continue;
    known = true;
    rows.push(...flatten(entry, day));
  }
  if (!known) return { state: 'unavailable' };

  const ahead = rows.filter((r) => r.at > now).sort((a, b) => a.at - b.at);
  if (!ahead.length) return { state: 'awaiting' };
  return { state: 'ok', rows: ahead };
}

// Chronological order alone lets today crowd out the rest of a long Yom Tov:
// a cap of eight spent on tonight and tomorrow morning leaves day three
// invisible, which is the whole thing this was meant to fix. So every day on
// the board is guaranteed a share first, and whatever is left of the cap is
// then spent in time order.
function capRows(byDay, cap) {
  if (byDay.size <= 1) return [...byDay.values()].flat().slice(0, cap);
  // An even division, never a fixed floor. A floor of three under "Next 4"
  // returned six times across two days and quietly broke the setting — the cap
  // is what the person asked for and it wins.
  const share = Math.max(1, Math.floor(cap / byDay.size));
  const kept = [];
  const spare = [];
  for (const rows of byDay.values()) {
    kept.push(...rows.slice(0, share));
    spare.push(...rows.slice(share));
  }
  // Late at night today has nothing left, so its share goes unspent — hand it
  // to the days that can use it rather than showing a half-empty card.
  const room = Math.max(0, cap - kept.length);
  spare.sort((a, b) => a.at - b.at);
  // The final slice is the hard ceiling: more days than the cap can seat (a cap
  // of four over five days) drops the furthest, which is the honest thing to
  // give up.
  return [...kept, ...spare.slice(0, room)]
    .sort((a, b) => a.at - b.at)
    .slice(0, cap);
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
  // Everything that claims a band goes first, and the cards fit what is left.
  // renderShuls ends by MEASURING the cell it was given, so anything inserted
  // after it has already been measured around — with the strip painted last,
  // the first frame sized the type against a board that was about to lose
  // 15vh to the weather, and a portrait card clipped its own times until the
  // next render corrected it thirty seconds later.
  renderHorizon(now, info);
  renderWeather(now, info);
  // One list, so the footer describes the same span the cards do.
  const days = daysShown(now, info);
  renderShuls(now, days);
  renderFreshness(now, days);
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

// Nightfall is a fact; havdalah is a practice, and the two shuls that have one
// hold by their own motzei Shabbos maariv plus a fixed few minutes. That is the
// number their members actually wait on, so it beats a computed tzeis — but it
// only exists for a shul we have both an offset and a maariv time for.
function havdalahFor(slug, endDay) {
  const day = minyanim.days?.[isoOf(endDay)]?.[slug];
  // If the shul publishes when its fast or Shabbos ends, that is the answer and
  // no arithmetic can improve on it.
  const published = timeToDate(endDay, day?.edge?.havdalah ?? '');
  if (published) return published;

  const mins = shuls.find((s) => s.slug === slug)?.havdalahAfterMaariv;
  if (!mins) return null;
  const times = (day?.maariv ?? [])
    // Neila and Kol Nidrei sit in the evening bucket but neither is the maariv
    // the practice counts from; measuring off Neila put havdalah an hour early.
    .filter((row) => !/neila|ne'?ilah?|kol ?nidre/i.test(row.label ?? ''))
    .map((row) => timeToDate(endDay, row.time)).filter(Boolean)
    .sort((a, b) => a - b);
  // The maariv that ends the day, not an earlier one sharing the slot.
  const sunset = toDate(zmanim(endDay).getSunset());
  const maariv = times.find((t) => t >= sunset) ?? times[0];
  return maariv ? new Date(maariv.getTime() + mins * 60000) : null;
}

// One time when the shuls on screen agree, one line each when they do not —
// which is the whole point, since they end Shabbos minutes apart. With nothing
// shul-specific to show we fall back to tzeis, the town-wide answer.
function havdalahLines(now) {
  const end = restEnd(now);
  if (!end) return [];
  const shown = shownShuls();
  const per = shown.map((s) => ({ name: s.name, at: havdalahFor(s.slug, end.day) }))
    .filter((r) => r.at);
  if (!per.length) return [`Havdalah <b>${clockTime(end.tzeis)}</b>`];
  const distinct = new Set(per.map((r) => clockTime(r.at)));
  // An unlabelled time has to speak for every shul on screen, so it is only
  // safe when they all agree AND none of them is missing from the list.
  if (distinct.size === 1 && per.length === shown.length) {
    return [`Havdalah <b>${[...distinct][0]}</b>`];
  }
  return ['Havdalah', ...per.map((r) => `${r.name} <b>${clockTime(r.at)}</b>`)];
}

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
      parts.push(`Candles ${intoShabbos ? '' : 'after '}<b>${clockTime(lightAt)}</b>`);
    }
    parts.push(...havdalahLines(now));
  } else if (isLocked(now, info)) {
    parts.push(...havdalahLines(now));
  } else if (restingNext && now < candles) {
    // Both ends, not just the one about to happen. Knowing Shabbos is in at
    // 6:41 is half the question; the other half is when it is out.
    parts.push(`Candles <b>${clockTime(candles)}</b>`, ...havdalahLines(now));
  }
  // On an ordinary weekday there is no transition to announce. Hide the element
  // rather than leaving an empty one contributing a gap to the column.
  // One line per fact. The tile is only as wide as the Hebrew date, so an inline
  // separator always wrapped anyway and left the dot dangling off the first line.
  $('edge').innerHTML = parts.map((p) => `<span class="line">${p}</span>`).join('');
  $('edge').hidden = !parts.length;
}

// Netz, shkiya and tzeis, in the tile beside the clock. They used to appear
// only on the horizon, so turning that off — which is now the default — left
// them nowhere. These are the three that pace the day; the setting adds the
// rest for anyone who wants them.
let lastZmanim = '';

function renderZmanim(info) {
  const cal = info.cal;
  // Each zman by its own name, and then what it is for. "Netz" on its own
  // assumes you already know; the pairing is how a luach reads.
  const rows = [['נץ החמה', 'Earliest Shacharis', toDate(cal.getSunrise()), 'netz']];
  if (settings.showZmanim) {
    rows.push(['סוף זמן שמע', 'Latest Shema', toDate(cal.getSofZmanShmaGRA()), 'mid'],
      ['מנחה גדולה', 'Earliest Mincha', toDate(cal.getMinchaGedola()), 'mid'],
      ['פלג המנחה', 'Early Maariv', toDate(cal.getPlagHamincha()), 'mid']);
  }
  rows.push(['שקיעה', 'Sunset', info.sunset, 'shkiya'],
    ['צאת הכוכבים', 'Nightfall', info.tzeis, 'tzeis']);

  // dir on the Hebrew span, so the pipe and the English stay to its right
  // instead of the bidi algorithm reordering the line.
  const html = rows.filter(([, , d]) => d).map(([heb, eng, d, kind]) =>
    `<div class="zrow ${kind}">`
    + `<div class="zname"><span class="zheb" dir="rtl">${esc(heb)}</span>`
    + `<span class="zsep">|</span><span class="zeng">${esc(eng)}</span></div>`
    + `<div class="ztime">${clockFace(clockTimeLong(d))}</div></div>`).join('');
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

function renderShuls(now, days) {
  const list = shownShuls();
  if (!list.length) {
    paintBoard('<p class="none">No shuls chosen. Open Settings to pick some.</p>');
    return;
  }

  const cap = Number(settings.perShul);
  // Counted per card, not pooled. Averaging across the board let one heavy shul
  // hide behind two light ones and clip its own times.
  const perCardLines = [];
  let lines = 0;

  const cards = list.map((shul) => {
    lines = 0;
    const s = scheduleFor(shul.slug, now, days);
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

    // Grouped by the day each time actually falls on, then capped — the cap
    // has to be spent with the days in view, or it is spent entirely on the
    // first of them.
    const grouped = new Map();
    for (const r of [...s.rows].sort((a, b) => a.at - b.at)) {
      const k = isoOf(r.at);
      if (!grouped.has(k)) grouped.set(k, []);
      grouped.get(k).push(r);
    }
    const ahead = capRows(grouped, cap);
    const next = ahead[0];

    const byDay = new Map();
    for (const r of ahead) {
      const k = isoOf(r.at);
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(r);
    }

    let body = '';
    for (const [iso, rows] of byDay) {
      const when = dayName(now, rows[0].at);
      // Anything that is not today is always announced. Without this, a board
      // late at night shows tomorrow's 5:10 AM with nothing saying it is not
      // tonight — and on a long Yom Tov, three identical mornings in a row.
      if (when.cls !== 'today' || byDay.size > 1) {
        body += `<p class="group ${when.cls}">${esc(when.label)}</p>`;
        lines += 1;
      }
      const day = when.cls;

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
        body += `<span class="label ${day}">${esc(label)}</span>`
          + `<span class="times ${day}">`
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
  const fill = perCard <= 3 ? 1.5 : perCard <= 5 ? 1.3 : perCard <= 7 ? 1.15
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
// Low enough that the board can always shrink to fit. Six zmanim in portrait
// makes the tile half the screen tall, and at a 0.45 floor the loop ran out of
// room and clipped rather than shrinking further.
const MIN_SCALE = 0.3;
// 2.6 let a card with two rows blow its times up to 86px against a 36px label
// — top-heavy, and wide enough to run to the card's clip edge. A card with
// little to say should read as a calm card, not a billboard. Down again from
// 1.8 now that the weather strip has taken a band off the cards: in a shorter
// cell the old ceiling put a two-row card's numerals hard against its own
// padding, which is the billboard the note above is about.
const MAX_SCALE = 1.7;

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
  // Scroll metrics are not enough. A time that is wider than its grid track
  // overflows and is clipped by the card, and the browser still reports
  // scrollWidth === clientWidth to the pixel — the same blindness that let
  // alignment overflow through before. So compare the rows' own rectangles
  // against the body they are supposed to sit in.
  const rows = cards.map((c) => [c.querySelector('.body'),
    [...c.querySelectorAll('.time, .label, .group')]]).filter(([b]) => b);
  const root = document.documentElement;
  const fits = (v) => {
    root.style.setProperty('--minyan-scale', v);
    if (!boxes.every((b) => b.scrollHeight <= b.clientHeight + 1
      && b.scrollWidth <= b.clientWidth + 1)) return false;
    return rows.every(([body, els]) => {
      const box = body.getBoundingClientRect();
      return els.every((el) => {
        const r = el.getBoundingClientRect();
        return r.right <= box.right + 1 && r.bottom <= box.bottom + 1
          && r.left >= box.left - 1;
      });
    });
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

// Today and Tomorrow by name; anything further out by weekday, because "in two
// days" is not how anyone refers to the second day of Yom Tov. The class stays
// today/tomorrow so the existing tone rules keep working, with everything past
// tomorrow taking tomorrow's quieter tone.
function dayName(now, at) {
  const a = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const b = new Date(at.getFullYear(), at.getMonth(), at.getDate());
  const diff = Math.round((b - a) / 86400000);
  if (diff <= 0) return { label: 'Today', cls: 'today' };
  if (diff === 1) return { label: 'Tomorrow', cls: 'tomorrow' };
  return { label: at.toLocaleDateString('en-US', { weekday: 'long' }), cls: 'tomorrow' };
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

/* Weather --------------------------------------------------------------- */
// What the strip is for: to answer "do we need coats when we walk back", for as
// long as the walking lasts. So it is keyed to the rest period, not to the
// calendar day — one Shabbos or three days of Yom Tov, the same code either way.

// The API returns local wall-clock stamps with no offset ("2026-09-23T14:00"),
// because we asked for its own timezone. Parsed by hand rather than by Date:
// an ISO string without an offset is local time in every current engine, but
// this is a wall display that must not depend on that staying true.
function localHour(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(iso));
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : null;
}

const degrees = (f) => (f == null || Number.isNaN(f) ? null
  : Math.round(settings.units === 'C' ? (f - 32) * (5 / 9) : f));

// WMO code -> the glyph to draw and what to call it. Grouped the way someone
// glancing at a wall groups them: the difference between 61 and 63 is "rain",
// and the difference between rain and snow is the whole point.
const SKY = new Map([
  [0, ['clear', 'Clear']], [1, ['clear', 'Mostly clear']],
  [2, ['partly', 'Partly cloudy']], [3, ['cloud', 'Overcast']],
  [45, ['fog', 'Fog']], [48, ['fog', 'Freezing fog']],
  [51, ['drizzle', 'Light drizzle']], [53, ['drizzle', 'Drizzle']],
  [55, ['drizzle', 'Heavy drizzle']],
  [56, ['drizzle', 'Freezing drizzle']], [57, ['drizzle', 'Freezing drizzle']],
  [61, ['rain', 'Light rain']], [63, ['rain', 'Rain']], [65, ['rain', 'Heavy rain']],
  [66, ['rain', 'Freezing rain']], [67, ['rain', 'Freezing rain']],
  [71, ['snow', 'Light snow']], [73, ['snow', 'Snow']], [75, ['snow', 'Heavy snow']],
  [77, ['snow', 'Snow grains']],
  [80, ['rain', 'Showers']], [81, ['rain', 'Showers']], [82, ['rain', 'Heavy showers']],
  [85, ['snow', 'Snow showers']], [86, ['snow', 'Snow showers']],
  [95, ['storm', 'Thunderstorms']], [96, ['storm', 'Thunderstorms']],
  [99, ['storm', 'Thunderstorms']],
]);

// After dark a clear sky is not a sun, and a partly cloudy one is not a sun
// behind a cloud. is_day comes back per hour, so each column knows.
function skyOf(code, isDay) {
  const [kind, label] = SKY.get(Number(code)) ?? ['cloud', ''];
  if (isDay) return { kind, label };
  if (kind === 'clear') return { kind: 'clear-night', label };
  if (kind === 'partly') return { kind: 'partly-night', label };
  return { kind, label };
}

// Built from overlapping discs and a rounded bar rather than one hand-authored
// arc path. At 30px across a room the silhouette is all that survives, and
// discs give a correct one that nobody has to maintain by eye. Every glyph is
// drawn in the same 24x24 grid and centred in it, so a row of twelve sits on a
// common line instead of the sun riding high over the clouds.
//
// The discs are opaque and the GROUP carries the transparency (see .wcloud in
// the stylesheet). Fading each shape instead made every overlap a darker patch,
// and a cloud drawn that way reads as three caterpillar humps rather than one
// cloud — which is exactly how it looked at 26px.
const CLOUD = '<circle cx="8.2" cy="13.8" r="4"/><circle cx="13.2" cy="11" r="5.9"/>'
  + '<circle cx="17.6" cy="14.2" r="3.9"/><rect x="5.4" y="14.2" width="13.6" height="4.6" rx="2.3"/>';

const ray = (d) => `<path d="${d}"/>`;
const SUN = '<circle cx="12" cy="12" r="4.6"/><g class="wrays">'
  + ['M12 3.2v2.8', 'M12 18v2.8', 'M3.2 12h2.8', 'M18 12h2.8',
    'M5.7 5.7 7.7 7.7', 'M16.3 16.3 18.3 18.3',
    'M18.3 5.7 16.3 7.7', 'M7.7 16.3 5.7 18.3'].map(ray).join('')
  + '</g>';
// Tucked up and left so the cloud can sit over its lower right without eating
// the disc. Its own rays, not the full sun's scaled down: at this size the
// long ones read as scratches.
const SUN_SMALL = '<circle cx="7.2" cy="6.8" r="3.2"/><g class="wrays">'
  + ['M7.2 0.4v2', 'M0.8 6.8h2', 'M2.5 2.1 3.9 3.5', 'M11.9 2.1 10.5 3.5'].map(ray).join('')
  + '</g>';
// Two circles differenced, solved for their intersections rather than eyeballed
// — a shallow bite is a blue disc at this size, not a moon.
const MOON = '<path d="M18.87 14.16A7.2 7.2 0 1 1 8.7 5.6A7 7 0 0 0 18.87 14.16Z"/>';
const MOON_SMALL = '<path d="M12.28 9.6A4.7 4.7 0 1 1 6.2 3.52A4.6 4.6 0 0 0 12.28 9.6Z"/>';
// Precipitation hangs below the cloud's 18.8 edge, inside the box either way.
const DROPS = (n) => [9.2, 13.2, 17.2].slice(0, n)
  .map((x) => `<path d="M${x} 19.6l-1 2.6"/>`).join('');
const FLAKE = (x) => `<path d="M${x} 19.2v3.6M${x - 1.6} 20.1l3.2 1.8M${x + 1.6} 20.1l-3.2 1.8"/>`;

function skyGlyph(kind) {
  const body = {
    clear: `<g class="wsun">${SUN}</g>`,
    'clear-night': `<g class="wsun">${MOON}</g>`,
    partly: `<g class="wsun">${SUN_SMALL}</g><g class="wcloud">${CLOUD}</g>`,
    'partly-night': `<g class="wsun">${MOON_SMALL}</g><g class="wcloud">${CLOUD}</g>`,
    cloud: `<g class="wcloud">${CLOUD}</g>`,
    fog: `<g class="wcloud">${CLOUD}</g>`
      + '<g class="wfog"><path d="M6.4 20.6h11"/><path d="M8.6 22.8h9.6"/></g>',
    drizzle: `<g class="wcloud">${CLOUD}</g><g class="wwet">${DROPS(2)}</g>`,
    rain: `<g class="wcloud">${CLOUD}</g><g class="wwet">${DROPS(3)}</g>`,
    snow: `<g class="wcloud">${CLOUD}</g><g class="wsnow">${FLAKE(9.4)}${FLAKE(16.4)}</g>`,
    // Filled, not stroked. A 2px zigzag under a solid cloud reads as a crack.
    storm: `<g class="wcloud">${CLOUD}</g>`
      + '<g class="wbolt"><path d="M14 18.6 10.6 21.6h1.8l-1.5 2.2L14.9 20.6h-1.8Z"/></g>',
  }[kind] ?? `<g class="wcloud">${CLOUD}</g>`;
  return `<svg class="wicon ${kind}" viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
}

// The name of the rest period the strip sits in or is about to. "Shabbos" when
// nothing else applies, the Yom Tov by name when it does — a three-day chag
// says Succos rather than Shabbos, which is what makes the span legible.
function restName(day) {
  const jc = new JewishDay(day).jc;
  return fmtEng.formatYomTov(jc) || 'Shabbos';
}

// The span the strip describes. Not "today": a Friday afternoon should already
// be showing Shabbos, and Shabbos morning should still be showing it.
function weatherSpan(now, info) {
  const jc = info.civil.jc;
  const inIt = jc.isAssurBemelacha() && now < info.tzeis;
  if (!inIt && !jc.isTomorrowShabbosOrYomTov()) return { name: '', until: null };
  const end = restEnd(now);
  if (!end) return { name: '', until: null };
  return { name: restName(inIt ? now : addDays(now, 1)), until: end.tzeis };
}

// A rolling window, from the hour we are in, optionally clipped to the end of
// the rest period so the strip never runs past the havdalah it is captioned
// with.
function hoursWithin(now, span) {
  const h = weather?.hourly;
  if (!Array.isArray(h?.time)) return [];
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours());
  const rows = [];
  for (let i = 0; i < h.time.length && rows.length < WEATHER_HOURS; i += 1) {
    const at = localHour(h.time[i]);
    if (!at || at < from) continue;
    if (span.until && at > span.until) break;
    rows.push({
      at,
      temp: h.temperature_2m?.[i],
      pop: h.precipitation_probability?.[i],
      sky: skyOf(h.weather_code?.[i], h.is_day?.[i] !== 0),
    });
  }
  return rows;
}

// The span and the hours have to be decided together, or the caption promises
// something the columns do not deliver. An hour before havdalah the clipped
// window is two columns — not a forecast — so it opens back up to the plain
// hours ahead, and the heading gives up the claim in the same breath. Havdalah
// itself is not lost: it is on the tile, which is where it belongs.
function weatherWindow(now, info) {
  const span = weatherSpan(now, info);
  const rows = hoursWithin(now, span);
  if (rows.length >= WEATHER_MIN_HOURS || !span.until) return { span, rows };
  const open = { name: '', until: null };
  return { span: open, rows: hoursWithin(now, open) };
}

// Today's high and low, read off the daily block for the date we are on rather
// than derived from the hourly window — the window starts at now, so by evening
// its own maximum is not the day's.
function todayRange(now) {
  const d = weather?.daily;
  const i = (d?.time ?? []).indexOf(isoOf(now));
  if (i < 0) return null;
  const hi = degrees(d.temperature_2m_max?.[i]);
  const lo = degrees(d.temperature_2m_min?.[i]);
  return hi == null || lo == null ? null : { hi, lo };
}

// Age is measured from the observation the payload carries, never from the clock
// at the moment we parsed it.
//
// Date.now() looked right and was not: the service worker can hand back a
// CACHED response — that is the whole point of it — and a cached response is
// res.ok like any other. Every replay of an hours-old forecast was therefore
// stamped as freshly fetched, which defeated exactly the staleness this was
// added to expose. `current.time` travels with the data and cannot be
// re-stamped by anything downstream.
//
// null when there is no observation to measure from, which is treated as
// unknown rather than fresh.
const weatherAge = () => (weather?.observed_at ? Date.now() - weather.observed_at : null);

let lastWeather = '';

function renderWeather(now, info) {
  const el = $('weather');
  const { span, rows } = weatherWindow(now, info);
  el.hidden = !settings.showWeather || !rows.length;
  if (el.hidden) { lastWeather = ''; return; }

  const age = weatherAge();
  // An observation has a moment attached to it and goes wrong as that moment
  // recedes; the hourly series does not, because every row already names its
  // own hour. So when the fetch is old the "now" block is read off the current
  // hour's row instead of off a stale observation.
  const dead = age === null || age > WEATHER_DEAD_MS;
  const cur = dead ? {} : (weather?.current ?? {});
  const sky = dead ? rows[0].sky : skyOf(cur.weather_code, cur.is_day !== 0);
  const temp = degrees(cur.temperature_2m) ?? degrees(rows[0].temp);
  const range = todayRange(now);
  // Only worth the line when it disagrees with the thermometer by enough to
  // change what you put on. Otherwise it is noise beside the real number.
  const feels = degrees(cur.apparent_temperature);
  const feelsLine = feels != null && temp != null && Math.abs(feels - temp) >= 3
    ? `<span class="wfeels">Feels ${feels}°</span>` : '';

  const heading = span.name && span.until
    ? `${esc(span.name)}<span class="wuntil">through ${clockTime(span.until)}</span>`
    : `<span class="wuntil">Next ${rows.length} hours</span>`;

  // The hour, not the whole time: twelve columns of "2:00 PM" is a wall of
  // punctuation, and every column is on the hour by construction.
  const hourOf = (d) => `${d.getHours() % 12 || 12}${d.getHours() < 12 ? 'a' : 'p'}`;

  const cols = rows.map((r, i) => {
    const t = degrees(r.temp);
    // Rain worth mentioning only. A 10% chance printed under every column
    // trains the eye to skip the row on the day it matters.
    const wet = r.pop >= 25 ? `<span class="wpop">${Math.round(r.pop)}%</span>` : '';
    return `<div class="wcol${i === 0 ? ' now' : ''}">`
      + `<span class="whour">${i === 0 ? 'Now' : esc(hourOf(r.at))}</span>`
      + skyGlyph(r.sky.kind)
      + `<span class="wtemp">${t == null ? '' : `${t}°`}</span>`
      + `${wet}</div>`;
  }).join('');

  const html = `<div class="wnow">${skyGlyph(sky.kind)}`
    + `<div class="wnow-read"><span class="wbig">${temp == null ? '--' : `${temp}°`}</span>`
    + `<span class="wlabel">${esc(sky.label)}</span>`
    + (range ? `<span class="wrange">${range.hi}° / ${range.lo}°</span>` : '')
    + `${feelsLine}</div></div>`
    + `<div class="whours"><p class="whead">${heading}</p><div class="wcols">${cols}</div></div>`;

  if (html !== lastWeather) {
    lastWeather = html;
    el.innerHTML = html;
  }
}

async function refreshWeather() {
  try {
    const res = await fetch(WEATHER_URL, { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    // Anything without an hourly series is not a forecast, and overwriting a
    // good cache with it would blank the strip until the next fetch.
    if (!Array.isArray(data?.hourly?.time)) return;
    // Read off the payload, not the clock. A missing or unparseable observation
    // time leaves this null, and null reads as unknown — which routes through
    // the same path as a dead forecast rather than through the fresh one.
    data.observed_at = localHour(data.current?.time)?.getTime() ?? null;
    weather = data;
    localStorage.setItem(WEATHER_CACHE, JSON.stringify(data));
    const now = new Date();
    const info = dayInfo(now);
    renderWeather(now, info);
    // The strip appearing for the first time takes a band off the cards, so
    // they have to be re-measured against what is left of the board.
    fitBoard();
    // The footer credits open-meteo only once there is something to credit, so
    // it has to be repainted with the strip rather than waiting for the next
    // thirty-second render.
    renderFreshness(now, daysShown(now, info));
  } catch { /* keep the last sky: a forecast an hour old beats an empty band */ }
}

// The oldest thing on screen, not the newest thing in the file.
//
// generated_at goes fresh if ANY shul was fetched successfully, while the
// scraper retains the previous entry for any that failed. So a shul quietly
// showing yesterday's schedule sat under a line claiming the data was confirmed
// minutes ago. Each entry now carries its own stamp, and the line describes the
// worst of the ones actually displayed.
function shownStamp(now, days) {
  const file = minyanim.generated_at ? new Date(minyanim.generated_at) : null;
  const stamps = [];
  // Every day the board reaches, not just today. Once the window widened to
  // cover a three-day Yom Tov this still asked about today alone, so a Shabbos
  // entry retained from an older run sat two columns away from a line calling
  // the board current.
  for (const day of days) {
    const iso = isoOf(day);
    for (const s of shownShuls()) {
      const entry = minyanim.days?.[iso]?.[s.slug];
      if (!entry) continue;
      // No per-shul stamp means data written before they existed; the
      // file-level one is the only thing left to fall back on.
      stamps.push(entry.fetched_at ? new Date(entry.fetched_at) : file);
    }
  }
  const known = stamps.filter(Boolean);
  if (!known.length) return file;
  return new Date(Math.min(...known.map((t) => t.getTime())));
}

function renderFreshness(now = new Date(), days = [now]) {
  const stamp = shownStamp(now, days);
  if (!stamp) { $('freshness').textContent = 'No minyan data yet'; return; }
  const hours = (Date.now() - stamp) / 3.6e6;
  // Credit where the times on screen actually came from: a shul that publishes
  // its own schedule is read from its own site, not from the aggregator.
  const own = shownShuls().filter((s) => minyanim.days?.[isoOf(new Date())]?.[s.slug]?.source === 'shul');
  const source = own.length === 0 ? 'teaneckminyanim.com'
    : own.length === shownShuls().length ? 'each shul’s own website'
      : 'the shuls’ websites and teaneckminyanim.com';
  const times = hours > STALE_HOURS
    ? `Times last confirmed ${stamp.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
    : `Times from ${source}`;
  // Open-Meteo is free to use under CC-BY, which asks for exactly this line.
  if (!settings.showWeather || !weather) { $('freshness').textContent = times; return; }
  const age = weatherAge();
  // Same standard the minyan times are held to on the line beside it: say when
  // it was last confirmed rather than letting age pass for currency.
  const stale = age === null || age > WEATHER_STALE_MS
    ? ` (${age === null ? 'age unknown' : `${Math.floor(age / 3.6e6)}h old`})` : '';
  $('freshness').textContent = `${times} · weather from open-meteo.com${stale}`;
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

  refreshWeather();

  setInterval(render, 30000);
  setInterval(refreshMinyanim, 1800000);
  setInterval(refreshWeather, WEATHER_REFRESH_MS);
  setInterval(() => { page += 1; render(); }, ROTATE_MS);
  scheduleOvernightReload();

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  watchWake();
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

// The lock is released whenever the document stops being visible, so it has to
// be taken again on the way back. This used to register the listener with
// { once: true } from inside keepAwake: the first visibilitychange after a
// successful request is the visible -> hidden edge, where the handler does
// nothing — and { once: true } removed it anyway. The return to visible then
// had nothing listening, and the screen was free to sleep for good.
//
// Registered once, at start, and never removed. Re-requesting while the lock is
// already held is harmless.
async function keepAwake() {
  try {
    await navigator.wakeLock.request('screen');
  } catch { /* iPad also needs Settings > Display > Auto-Lock set to Never */ }
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
