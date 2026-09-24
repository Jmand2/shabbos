/* Shabbos Clock — the forecast, and how old it is.

   Loaded as ordinary scripts, in the order index.html lists them, sharing one
   script scope. Not ES modules: jsdom cannot load <script type="module"> at
   all, and both behavioural suites work by loading the real index.html and
   running the real app inside it. Splitting the file was worth doing; giving up
   that harness to get import statements was not. */

const WEATHER_CACHE = 'shabbos-clock-weather';
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
// Below this the model is reporting noise rather than a chance of rain.
const WEATHER_POP_FLOOR = 10;
// The last forecast we were handed. Read before the first fetch returns, so a
// display that wakes up with no network still shows a sky rather than nothing.
let weather = readJSON(WEATHER_CACHE);

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

  // The separator is a character, not a margin. Letter-spaced small caps swallow
  // a 0.7em gap between two inline spans and the heading read as SUCCOSTHROUGH.
  const heading = span.name && span.until
    ? `${esc(span.name)}<span class="wuntil"> &middot; through ${clockTime(span.until)}</span>`
    : `<span class="wuntil">Next ${rows.length} hours</span>`;

  // The hour, not the whole time: twelve columns of "2:00 PM" is a wall of
  // punctuation, and every column is on the hour by construction.
  const hourOf = (d) => `${d.getHours() % 12 || 12}${d.getHours() < 12 ? 'a' : 'p'}`;

  const cols = rows.map((r, i) => {
    const t = degrees(r.temp);
    // Any real chance, printed on the hour it belongs to. This used to start at
    // 25%, which hid exactly the reading someone wants before a walk to shul —
    // a 10% on one hour is worth knowing. The floor is there only to keep the
    // model's 0-5% noise off twelve tiles at once.
    const wet = r.pop >= WEATHER_POP_FLOOR
      ? `<span class="wpop">${Math.round(r.pop)}%</span>` : '';
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
