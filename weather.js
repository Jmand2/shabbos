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
  + '&hourly=temperature_2m,apparent_temperature,precipitation_probability,precipitation,'
  + 'weather_code,is_day,wind_speed_10m,wind_gusts_10m'
  + '&current=temperature_2m,apparent_temperature,weather_code,is_day,wind_speed_10m'
  + '&daily=temperature_2m_max,temperature_2m_min'
  + '&wind_speed_unit=mph'
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

// Always fetched in Fahrenheit and converted here, so the toggle costs no
// refetch and goes on working with no network at all.
const degrees = (f) => {
  if (f == null || Number.isNaN(f)) return null;
  const c = (f - 32) * (5 / 9);
  if (settings.units === 'C') return Math.round(c);
  if (settings.units === 'K') return Math.round(c + 273.15);
  return Math.round(f);
};

// Kelvin is not a degree — it is written 291 K, with a space and no ring.
const degreeMark = () => (settings.units === 'K' ? '\u202fK' : '\u00b0');

// THE ONE PLACE A TEMPERATURE BECOMES TEXT.
//
// degreeMark() existed but the note built its own strings with a hard-coded
// ring, so "Warming to 291°" went on the wall in Kelvin. Anything that prints a
// temperature goes through here.
const formatTemp = (f) => {
  const v = degrees(f);
  return v == null ? '' : `${v}${degreeMark()}`;
};

// How far apart "feels like" has to be before it is worth a line.
//
// Measured on the RAW Fahrenheit, never on the converted number. Comparing
// after conversion meant the rule was three degrees F on one setting and three
// degrees C — nearly six F — on another, so the same weather earned the line or
// did not depending on a display preference.
const FEELS_GAP_F = 3;

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
  // One extra: the current hour is kept so the "now" block can fall back to it
  // when the observation is stale, and then dropped from the strip.
  for (let i = 0; i < h.time.length && rows.length < WEATHER_HOURS + 1; i += 1) {
    const at = localHour(h.time[i]);
    if (!at || at < from) continue;
    if (span.until && at > span.until) break;
    rows.push({
      at,
      temp: h.temperature_2m?.[i],
      feels: h.apparent_temperature?.[i],
      pop: h.precipitation_probability?.[i],
      // The raw code as well as the rendered sky. skyOf() throws away the
      // number, and the number is the only thing that says how HARD it is
      // going to rain — the probability says how likely, which is a different
      // question the note used to answer as though it were the same one.
      code: h.weather_code?.[i],
      // How MUCH, in millimetres. The probability says how likely it is to rain
      // at all and says nothing about whether to bother with a coat.
      mm: h.precipitation?.[i],
      wind: h.wind_speed_10m?.[i],
      gust: h.wind_gusts_10m?.[i],
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
// Date.now() looked right and was not: a cached response is res.ok like any
// other, so every replay of an hours-old forecast was stamped as freshly
// fetched — defeating exactly the staleness this was added to expose.
//
// The service worker was the culprit then and bypasses open-meteo entirely now,
// so do not read this and conclude the guard is obsolete: the browser's own
// HTTP cache is still there, and an age that travels inside the payload cannot
// be wrong about itself whoever handed it over.
//
// null when there is no observation to measure from, which is treated as
// unknown rather than fresh.
const weatherAge = () => (weather?.observed_at ? Date.now() - weather.observed_at : null);

/* The one useful sentence ------------------------------------------------
   Data is what the strip already shows. This is the reading of it, and it earns
   its place only by being absent nearly always — a line that appears every day
   is furniture, and furniture is not read.

   So: nothing at all unless something would change what you put on or when you
   leave. Ranked, and only the first one shown, because two notes is a forecast
   and the strip is already that. */

// Rain worth planning around, not worth mentioning.
const NOTE_WET = 50;
const NOTE_VERY_WET = 80;
// WMO codes that actually mean heavy: 65 heavy rain, 67 heavy freezing rain,
// 82 violent showers. Not a probability — "Heavy rain" used to mean an 80%
// chance, so a near-certain drizzle was announced as a downpour and a merely
// likely cloudburst was not.
const NOTE_HEAVY_CODES = [65, 67, 82];
// Wind worth a word. Below this it is a breeze and nobody changes what they
// wear for it; gusts are judged separately because a calm average with hard
// gusts is exactly the walk that surprises you.
const NOTE_WIND_MPH = 18;
const NOTE_GUST_MPH = 28;
// Fahrenheit throughout — the thresholds are facts about weather, not about the
// unit the person happens to be reading it in.
const NOTE_FREEZING = 32;
const NOTE_SWING = 15;

const noteHour = (d) => `${d.getHours() % 12 || 12}${d.getHours() < 12 ? 'am' : 'pm'}`;

// The longest unbroken stretch matching a test, so "rain 5-7pm" describes one
// spell rather than the outer bounds of two.
function longestRun(rows, test) {
  let best = [];
  let run = [];
  for (const r of rows) {
    if (test(r)) { run.push(r); if (run.length > best.length) best = run; }
    else run = [];
  }
  return best;
}

function spanLabel(run) {
  const from = noteHour(run[0].at);
  // The hour a spell ENDS is the hour after its last wet reading.
  const to = noteHour(new Date(run.at(-1).at.getTime() + 3600000));
  return run.length === 1 ? `around ${from}` : `${from}\u2013${to}`;
}

// Below this there is nothing worth printing: it rounds to nothing in either
// unit and is mostly the model's own noise.
const WEATHER_MM_FLOOR = 0.2;

// Millimetres in, the reader's own unit out — converted on screen like the
// temperatures, so the units toggle still costs no refetch and still works
// with no network at all.
function amountOf(mm) {
  const v = Number(mm);
  if (!Number.isFinite(v) || v < WEATHER_MM_FLOOR) return null;
  if (settings.units !== 'F') {
    return `<span class="wpop wamt">${v < 10 ? v.toFixed(1) : Math.round(v)}mm</span>`;
  }
  const inches = v / 25.4;
  // Two decimals below a tenth, one above: 0.04" and 0.3" rather than 0.04"
  // and 0.30", which reads as more precision than a forecast has.
  const shown = inches < 0.1 ? inches.toFixed(2) : inches.toFixed(1);
  return `<span class="wpop wamt">${shown}\u2033</span>`;
}

// Above this a stated amount is a forecast rather than a hypothetical.
const WEATHER_AMOUNT_POP = 55;

function wetCell(r) {
  const pop = Number(r.pop);
  if (!Number.isFinite(pop) || pop < WEATHER_POP_FLOOR) return '';
  const amount = pop >= WEATHER_AMOUNT_POP ? amountOf(r.mm) : null;
  return amount ?? `<span class="wpop">${Math.round(pop)}%</span>`;
}

function weatherNote(rows) {
  if (rows.length < 2) return '';

  const gust = Math.max(0, ...rows.map((r) => Number(r.gust) || 0));
  const windy = gust >= NOTE_GUST_MPH;

  // Rain first. It is the one that changes whether you carry something.
  const wet = longestRun(rows, (r) => Number(r.pop) >= NOTE_WET);
  if (wet.length) {
    // "Heavy" comes from the CODE — 65, 67, 82 — never from the probability,
    // which measures likelihood and says nothing about intensity. Where the
    // code does not claim heavy, the wording stays plain rather than dressing a
    // high chance up as a downpour.
    const heavy = wet.some((r) => NOTE_HEAVY_CODES.includes(Number(r.code)));
    const sure = wet.every((r) => Number(r.pop) >= NOTE_VERY_WET);
    const what = heavy ? 'Heavy rain' : 'Rain';
    const how = heavy ? 'likely' : (sure ? 'very likely' : 'likely');
    return windy
      ? `${what} ${how} ${spanLabel(wet)} \u00b7 gusts ${Math.round(gust)} mph`
      : `${what} ${how} ${spanLabel(wet)}`;
  }

  // Wind on its own, when there is no rain to lead with.
  if (windy) {
    const run = longestRun(rows, (r) => Number(r.gust) >= NOTE_GUST_MPH);
    return run.length && run[0] !== rows[0]
      ? `Windy from ${noteHour(run[0].at)} \u00b7 gusts ${Math.round(gust)} mph`
      : `Windy \u00b7 gusts ${Math.round(gust)} mph`;
  }

  // Then cold, which is the other thing you dress for. Measured on the
  // apparent temperature, because that is the one you feel on the walk.
  const cold = rows.find((r) => r.feels != null && Number(r.feels) <= NOTE_FREEZING);
  if (cold && cold !== rows[0]) return `Feels below freezing from ${noteHour(cold.at)}`;

  // Then a swing large enough that the hour you leave matters.
  const temps = rows.map((r) => Number(r.temp)).filter((t) => !Number.isNaN(t));
  if (temps.length > 2) {
    const hi = Math.max(...temps);
    const lo = Math.min(...temps);
    if (hi - lo >= NOTE_SWING) {
      const peak = rows.find((r) => Number(r.temp) === hi);
      const trough = rows.find((r) => Number(r.temp) === lo);
      // Whichever comes later is the one worth naming: it is the change still
      // ahead of you rather than the one you already felt.
      return peak.at > trough.at
        ? `Warming to ${formatTemp(hi)} by ${noteHour(peak.at)}`
        : `Dropping to ${formatTemp(lo)} by ${noteHour(trough.at)}`;
    }
  }

  // Most days, nothing. That is the point.
  return '';
}

let lastWeather = '';

function renderWeather(now, info, withWet = true) {
  const el = $('weather');
  const { span, rows: all } = weatherWindow(now, info);
  // THE CURRENT HOUR IS NOT PART OF THE FORECAST.
  //
  // The strip opened with a column labelled "Now" sitting beside a block that
  // already said exactly the same thing — the same icon, the same temperature,
  // twice, a centimetre apart. The block owns the present; the strip starts at
  // the next hour and is entirely about what is still to come.
  const currentRow = all[0] ?? null;
  const rows = all.slice(1);
  el.hidden = !settings.showWeather || !rows.length;
  // Emptied, not just hidden. The scores borrow this element, so a hidden band
  // that still holds the last scoreboard is a stale one waiting to be shown
  // again by anything that unhides it.
  if (el.hidden) { lastWeather = ''; el.innerHTML = ''; return; }

  const age = weatherAge();
  // An observation has a moment attached to it and goes wrong as that moment
  // recedes; the hourly series does not, because every row already names its
  // own hour. So when the fetch is old the "now" block is read off the current
  // hour's row instead of off a stale observation.
  const dead = age === null || age > WEATHER_DEAD_MS;
  const cur = dead ? {} : (weather?.current ?? {});
  const sky = dead ? (currentRow?.sky ?? rows[0].sky)
    : skyOf(cur.weather_code, cur.is_day !== 0);
  const rawTemp = dead ? currentRow?.temp : cur.temperature_2m;
  const temp = degrees(rawTemp) ?? degrees(currentRow?.temp);
  const range = todayRange(now);
  // Only worth the line when it disagrees with the thermometer by enough to
  // change what you put on. Otherwise it is noise beside the real number.
  const rawFeels = dead ? currentRow?.feels : cur.apparent_temperature;
  // Compared RAW, printed converted — see FEELS_GAP_F.
  const feelsWorth = rawFeels != null && rawTemp != null
    && Math.abs(Number(rawFeels) - Number(rawTemp)) >= FEELS_GAP_F;
  // Wind joins that line only when it is the thing you would notice on the
  // walk. An ordinary breeze is not information.
  const curWind = Number(dead ? currentRow?.wind : cur.wind_speed_10m);
  const windWorth = Number.isFinite(curWind) && curWind >= NOTE_WIND_MPH;
  const feelsBits = [
    feelsWorth ? `Feels ${formatTemp(rawFeels)}` : '',
    windWorth ? `Wind ${Math.round(curWind)} mph` : '',
  ].filter(Boolean);
  const feelsLine = feelsBits.length
    ? `<span class="wfeels">${esc(feelsBits.join(' \u00b7 '))}</span>` : '';

  // The separator is a character, not a margin. Letter-spaced small caps swallow
  // a 0.7em gap between two inline spans and the heading read as SUCCOSTHROUGH.
  const heading = span.name && span.until
    ? `${esc(span.name)}<span class="wuntil"> &middot; through ${clockTime(span.until)}</span>`
    : `<span class="wuntil">Next ${rows.length} hours</span>`;
  const note = weatherNote(rows);
  const noted = note ? `<span class="wnote">${esc(note)}</span>` : '';

  // The hour, not the whole time: twelve columns of "2:00 PM" is a wall of
  // punctuation, and every column is on the hour by construction.
  const hourOf = (d) => `${d.getHours() % 12 || 12}${d.getHours() < 12 ? 'am' : 'pm'}`;

  const cols = rows.map((r, i) => {
    const t = degrees(r.temp);
    // Any real chance, printed on the hour it belongs to. This used to start at
    // 25%, which hid exactly the reading someone wants before a walk to shul —
    // a 10% on one hour is worth knowing. The floor is there only to keep the
    // model's 0-5% noise off twelve tiles at once.
    // ONE FACT PER HOUR, whichever is the useful one.
    //
    // An amount is what you want when it is going to rain; a chance is what you
    // want when it might. Printing an amount against a low chance states a
    // quantity for something that will probably not happen at all — 0.2" over a
    // 30% hour reads as a promise. So the amount is only shown when the chance
    // is high enough to mean it, and below the probability floor neither is
    // shown, because 5% is the model's noise and not a forecast.
    const wet = !withWet ? '' : wetCell(r);
    return '<div class="wcol">'
      + `<span class="whour">${esc(hourOf(r.at))}</span>`
      + skyGlyph(r.sky.kind)
      + `<span class="wtemp">${t == null ? '' : `${t}${degreeMark()}`}</span>`
      + `${wet}</div>`;
  }).join('');

  const html = `<div class="wnow">${skyGlyph(sky.kind)}`
    + `<div class="wnow-read"><span class="wbig">${temp == null ? '--' : `${temp}${degreeMark()}`}</span>`
    + `<span class="wlabel">${esc(sky.label)}</span>`
    + (range ? `<span class="wrange">${range.hi}${degreeMark()} / ${range.lo}${degreeMark()}</span>` : '')
    + `${feelsLine}</div></div>`
    + `<div class="whours"><p class="whead">${heading}${noted}</p>`
    + `<div class="wcols">${cols}</div></div>`;

  if (html !== lastWeather) {
    lastWeather = html;
    el.innerHTML = html;
  }
  fitWeather(el, () => renderWeather(now, info, false));
}

/* Filling the band ---------------------------------------------------------

   The band's height is fixed on purpose: the scores borrow it, and a band that
   changed size would move every card below it twice an hour. But the CONTENT
   was fixed too — every size a clamp against the viewport — so how full the
   band looked depended on what the weather happened to be doing. A dry night
   has no precipitation row at all, and simply left that row's worth of height
   empty rather than giving it to the temperatures.

   So the strip is fitted to its band the way the cards are fitted to theirs:
   grow until it would no longer fit, then stop. And if it cannot be read even
   at the smallest size — twelve columns on a narrow iPad, every one of them
   carrying an amount — the wet row is what goes, because a temperature nobody
   can read is worth less than knowing it might rain. */
const WX_MIN = 0.8;
const WX_MAX = 1.9;

function fitWeather(el, withoutWet) {
  const hours = el.querySelector('.whours');
  if (!hours || el.hidden || !el.clientHeight) return;

  // MEASURED, NOT ASKED.
  //
  // The first version of this pinned the band's height and then trusted
  // scrollHeight to report the overflow. It does not: for a grid with
  // overflow: visible the browser reports scrollHeight === clientHeight to the
  // pixel while the content spills out of both ends, which is the same
  // blindness fitBoard() carries a paragraph about. The strip inflated to 1.32
  // and pushed the band from its 143px floor to 155px, moving every card below
  // it — which is the one thing this band's floor exists to prevent, since the
  // scores borrow the same space.
  //
  // So the content is measured directly, against the height the band is
  // entitled to: its floor, or its natural height at rest where that is taller.
  el.style.setProperty('--wx-scale', 1);
  const pad = parseFloat(getComputedStyle(el).paddingTop) * 2;
  const target = el.clientHeight - pad;
  if (!(target > 0)) return;

  const parts = () => [...el.querySelectorAll('.wnow, .whours')];
  const contentHeight = () => {
    const boxes = parts().map((n) => n.getBoundingClientRect());
    if (!boxes.length) return 0;
    return Math.max(...boxes.map((r) => r.bottom)) - Math.min(...boxes.map((r) => r.top));
  };

  const fits = (v) => {
    el.style.setProperty('--wx-scale', v);
    // No tolerance. A pixel of slack here is a pixel of extra band, and the
    // band's whole job is to be the same height whether it is showing weather
    // or scores — the cards below move for one pixel as readily as for ten.
    if (contentHeight() > target) return false;
    // Width still matters: twelve columns run off the side long before they run
    // out of height. Checked at BOTH levels, because a column staying inside
    // the strip says nothing about what is inside the column — an hour label, a
    // Kelvin reading or a precipitation amount can be wider than its own tile
    // and print over the hour beside it while .wcol itself never moves. That is
    // the mistake the shul cards made with their columns, one box further in.
    const box = el.getBoundingClientRect();
    const top = [...el.querySelectorAll('.wcol, .wnow-read, .whead')];
    if (!top.every((n) => {
      const r = n.getBoundingClientRect();
      return r.right <= box.right + 1 && r.left >= box.left - 1;
    })) return false;

    return [...el.querySelectorAll('.wcol')].every((col) => {
      const cb = col.getBoundingClientRect();
      return [...col.querySelectorAll('.whour, .wicon, .wtemp, .wpop')].every((n) => {
        const r = n.getBoundingClientRect();
        return r.right <= cb.right + 1 && r.left >= cb.left - 1;
      });
    });
  };

  if (!fits(WX_MIN)) {
    // Nothing left to shrink. Drop the wet row and fit what remains.
    if (withoutWet && el.querySelector('.wpop')) { withoutWet(); return; }
    el.style.setProperty('--wx-scale', WX_MIN);
    return;
  }
  if (fits(WX_MAX)) return;

  let lo = WX_MIN;
  let hi = WX_MAX;
  for (let i = 0; i < 8; i += 1) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid; else hi = mid;
  }
  fits(lo);
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
