// The checks jsdom cannot make.
//
// check.mjs and check-ui.mjs both run the app in jsdom, which computes no
// geometry at all — fitBoard detects that (every card reports clientHeight 0)
// and returns without fitting anything. So the most carefully tuned behaviour
// in this app, the one thing that decides whether the wall is readable, was the
// one thing never tested.
//
// This drives real WebKit, which is what the iPad runs, at the sizes the iPad
// runs at, and asserts two things per view:
//
//   1. Nothing overflows. Not scrollWidth/scrollHeight, which lie about
//      alignment overflow — the real rectangles of every time, label and day
//      heading against the body they are supposed to sit in.
//   2. The numerals are large enough to read across a room. A board that fits
//      because the fit loop drove the type to 10px is not a board that works,
//      and until this existed that failure looked identical to success.
//
//   npm i --no-save playwright && npx playwright install webkit
//   node scripts/check-layout.mjs [--update-screenshots]

import { webkit } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SHOTS = join(ROOT, 'screenshots');
const keepShots = process.argv.includes('--update-screenshots');

// Below this the numerals stop carrying across a room. It is the whole point of
// the display, so it is an assertion and not a preference.
const MIN_TIME_PX = 20;
// The clock is the one thing that must always be readable from anywhere.
const MIN_CLOCK_PX = 80;

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json',
};

// The page under test, with the clock frozen and settings injected before
// app.js runs. Nothing else about index.html is changed.
async function pageHtml(at, settings, scores) {
  const src = await readFile(join(ROOT, 'index.html'), 'utf8');
  const boot = `<script>
    (() => {
      const Real = Date; const fixed = new Real(${JSON.stringify(at)}).getTime();
      let skew = 0;
      // Nudgeable, so a test can reach a timed event — the scores band appears
      // on an interval — without waiting it out in real seconds.
      window.__advance = (ms) => { skew += ms; };
      window.Date = class extends Real {
        constructor(...a) { super(...(a.length ? a : [fixed + skew])); }
        static now() { return fixed + skew; }
      };
      localStorage.setItem('shabbos-clock-settings', ${JSON.stringify(JSON.stringify(settings))});
      ${scores ? `localStorage.setItem('shabbos-clock-sports', ${JSON.stringify(JSON.stringify(scores))});` : ''}
    })();
  </script>`;
  return src.replace('<script src="vendor/kosher-zmanim.min.js"></script>',
    `${boot}<script src="vendor/kosher-zmanim.min.js"></script>`);
}

let current = { at: null, settings: {} };

const server = createServer(async (req, res) => {
  const path = decodeURIComponent(req.url.split('?')[0]);
  try {
    if (path === '/' || path === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(await pageHtml(current.at, current.settings, current.scores));
      return;
    }
    // The forecast never leaves this process: a layout test must not depend on
    // the weather over Teaneck when it runs.
    if (path === '/forecast') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(forecast(current.at)));
      return;
    }
    const body = await readFile(join(ROOT, path.slice(1)));
    res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('no');
  }
});

function forecast(at, soaking = false) {
  const base = new Date(at);
  base.setMinutes(0, 0, 0);
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + `T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const hourly = {
    time: [], temperature_2m: [], precipitation_probability: [], precipitation: [],
    weather_code: [], is_day: [],
  };
  const daily = { time: [], temperature_2m_max: [], temperature_2m_min: [] };
  for (let i = 0; i < 96; i += 1) {
    const d = new Date(base.getTime() + i * 3600000);
    hourly.time.push(stamp(d));
    hourly.temperature_2m.push(60 + (i % 12));
    hourly.precipitation_probability.push(soaking ? 90 : [0, 40, 5, 10, 60, 8][i % 6]);
    // Two of the six hours carry a measurable amount, so the strip is rendered
    // with both kinds of cell side by side — which is how it looks in life.
    hourly.precipitation.push(soaking ? 12.7 : [0, 0, 0, 0, 1.4, 0][i % 6]);
    hourly.weather_code.push([0, 2, 3, 61, 71, 95][i % 6]);
    hourly.is_day.push(d.getHours() >= 7 && d.getHours() < 19 ? 1 : 0);
    const day = stamp(d).slice(0, 10);
    if (!daily.time.includes(day)) {
      daily.time.push(day);
      daily.temperature_2m_max.push(72);
      daily.temperature_2m_min.push(48);
    }
  }
  return {
    hourly, daily,
    current: { time: stamp(base), temperature_2m: 61, apparent_temperature: 55, weather_code: 3, is_day: 1 },
  };
}

const route_ok = (r, body) =>
  r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

let pass = 0;
let fail = 0;
const ok = (cond, msg, extra = '') => {
  if (cond) { pass += 1; console.log('    PASS', msg); }
  else { fail += 1; console.log('    FAIL', msg, extra); }
};

// Every check runs in the page, against real rectangles.
const MEASURE = () => {
  const out = { overflow: [], timePx: null, clockPx: null, scale: null, cards: 0 };
  const px = (el) => (el ? parseFloat(getComputedStyle(el).fontSize) : null);
  out.scale = getComputedStyle(document.documentElement).getPropertyValue('--minyan-scale').trim();
  // Which face actually resolved. These assertions are in real pixels, so a
  // substituted font changes the answer — and that is exactly what makes a
  // Linux runner disagree with an iPad about whether a board is readable.
  out.face = getComputedStyle(document.querySelector('.clock')).fontFamily.split(',')[0];
  out.clockPx = px(document.querySelector('.clock'));
  // The smallest on the board, not the first card's. Cards carry their own
  // scale, so the first is often the one that grew — asserting on it would pass
  // while the card beside it sat under the readable floor.
  const times = [...document.querySelectorAll('.card .body .time')]
    .map((el) => parseFloat(getComputedStyle(el).fontSize)).filter((n) => n > 0);
  out.timePx = times.length ? Math.min(...times) : null;
  out.timePxMax = times.length ? Math.max(...times) : null;
  out.cards = document.querySelectorAll('.card').length;

  const note = (what, el, box) => {
    const r = el.getBoundingClientRect();
    const why = [];
    if (r.right > box.right + 1) why.push('right');
    if (r.left < box.left - 1) why.push('left');
    if (r.bottom > box.bottom + 1) why.push('bottom');
    if (why.length) {
      out.overflow.push(`${what} "${el.textContent.trim().slice(0, 20)}" past ${why.join('+')}`);
    }
  };

  // Every child of every hour tile, against ITS OWN tile. The band-level check
  // cannot see a reading printing over the hour beside it.
  out.cells = [];
  for (const col of document.querySelectorAll('.wcol')) {
    const cb = col.getBoundingClientRect();
    for (const n of col.querySelectorAll('.whour, .wicon, .wtemp, .wpop')) {
      const r = n.getBoundingClientRect();
      if (r.right > cb.right + 1 || r.left < cb.left - 1) {
        out.cells.push(`${n.className.split(' ')[0]} "${n.textContent.trim().slice(0, 8)}" `
          + 'out of its hour');
      }
    }
  }

  // The weather strip's fit: how much of the band it is spending, and whether
  // what it drew still sits inside it.
  const wx = document.getElementById('weather');
  if (wx && !wx.hidden && !wx.classList.contains('sports') && wx.clientHeight) {
    const parts = [...wx.querySelectorAll('.wnow, .whours')].map((n) => n.getBoundingClientRect());
    out.wx = parts.length ? {
      scale: Math.round(parseFloat(getComputedStyle(wx).getPropertyValue('--wx-scale')) * 100) / 100,
      content: Math.round(Math.max(...parts.map((r) => r.bottom))
        - Math.min(...parts.map((r) => r.top))),
      room: Math.round(wx.clientHeight - (parseFloat(getComputedStyle(wx).paddingTop) * 2)),
    } : null;
  }

  // [9] What the shul's NAME costs. It is a heading on a card, not a masthead:
  // every pixel it takes is a pixel the schedule does not get, and on a short
  // card it was taking a fifth of the box.
  // [11] And what the NEXT row costs. It shares a grid row with its times, so a
  // flag that grows drags the whole column down — the one row anybody is
  // looking for is the one row that must not move the others.
  out.titles = [];
  out.nextRows = [];
  for (const card of document.querySelectorAll('.card')) {
    const h2 = card.querySelector('h2');
    const box = card.getBoundingClientRect();
    if (h2 && box.height) {
      const cs = getComputedStyle(h2);
      const used = h2.getBoundingClientRect().height
        + parseFloat(cs.marginBottom || 0);
      out.titles.push(Math.round((used / box.height) * 100));
    }
    // What the FLAG costs, not what the label costs. "Mincha / Kabbalas
    // Shabbos" wraps to three lines and is tall whether or not it is next —
    // comparing the whole row to a one-word neighbour measures the wording, so
    // this measures the thing actually under test.
    const flag = card.querySelector('.nextflag');
    if (flag) {
      const label = flag.closest('.label');
      const line = parseFloat(getComputedStyle(label).fontSize) || 1;
      out.nextRows.push({
        flag: Math.round(flag.getBoundingClientRect().height),
        line: Math.round(line),
      });
    }
  }

  /* [24] TRUNCATION. Several things here are allowed to ellipsize and a few are
     not, and nothing told them apart. A shul's name, a weather note, a day
     heading or a score's state is the glanceable content — if it is cut off,
     the board is not saying what it was built to say. The scores' own status
     detail ("3rd 04:12") IS allowed to clip: it is the least important string
     in the densest row and shortening it is a deliberate choice, so it is
     listed as one rather than silently passing. */
  out.cut = [];
  for (const [sel, why] of [['.card h2', 'shul name'], ['.wnote', 'weather note'],
    ['.card .body .group', 'day heading'], ['.spill', 'score state'],
    ['.slabel', 'scores label'], ['.wfeels', 'feels line']]) {
    for (const n of document.querySelectorAll(sel)) {
      if (n.scrollWidth > n.clientWidth + 1) {
        out.cut.push(`${why}: "${n.textContent.trim().slice(0, 22)}"`);
      }
    }
  }

  /* [25] CONTRAST. The display is read from across a room, and "it fits" is not
     the same as "it can be read" — muted grey on a dark panel passes every
     overflow check ever written. WCAG relative luminance, against the nearest
     painted background. */
  const lum = (c) => {
    const m = c.match(/[\d.]+/g);
    if (!m || m.length < 3) return null;
    const [r, g, b] = m.slice(0, 3).map((v) => {
      const x = Number(v) / 255;
      return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    });
    return (0.2126 * r) + (0.7152 * g) + (0.0722 * b);
  };
  const behind = (el) => {
    for (let n = el; n; n = n.parentElement) {
      const bg = getComputedStyle(n).backgroundColor;
      const m = bg.match(/[\d.]+/g);
      if (m && (m.length < 4 || Number(m[3]) > 0.5)) return bg;
    }
    return getComputedStyle(document.body).backgroundColor;
  };
  out.contrast = [];
  for (const [sel, why, want] of [
    ['#clockTime', 'the clock', 7], ['.card .time', 'minyan times', 4.5],
    ['.card .label', 'minyan labels', 3], ['.nextflag', 'the NEXT flag', 3],
    ['.wbig', 'the current temperature', 4.5], ['.wtemp', 'forecast temperatures', 3.5],
    ['.whour', 'forecast hours', 2.6], ['.sscore', 'scores', 4],
    ['.spill', 'score state', 2.6], ['#freshness', 'the footer', 2.4],
  ]) {
    const n = document.querySelector(sel);
    if (!n || !n.getClientRects().length) continue;
    const a = lum(getComputedStyle(n).color);
    const b = lum(behind(n));
    if (a === null || b === null) continue;
    const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    if (ratio < want) out.contrast.push(`${why} ${ratio.toFixed(1)}:1 (want ${want})`);
  }

  out.orphans = [];
  out.columns = [];
  out.widthUsed = [];
  for (const card of document.querySelectorAll('.card')) {
    const body = card.querySelector('.body');
    if (!body) continue;
    const box = body.getBoundingClientRect();
    const rows = [...card.querySelectorAll('.time, .label, .group')];
    for (const el of rows) note('card row', el, box);
    if (body.scrollHeight > body.clientHeight + 1) out.overflow.push('card body scrolls vertically');
    if (body.scrollWidth > body.clientWidth + 1) out.overflow.push('card body scrolls horizontally');

    // A column must lead with its own day heading. Split by line count alone,
    // a column once began with times whose "Tomorrow · Succos I" had been left
    // behind at the foot of the column before it — a time on the wall under no
    // day at all, which is worse than the empty space columns were for.
    const cols = [...body.querySelectorAll('.col')];
    out.columns.push(cols.length);
    for (const col of cols) {
      if (!col.firstElementChild?.classList.contains('group')) {
        out.orphans.push(`${card.querySelector('h2')?.textContent ?? '?'}: a column opens on `
          + `"${col.firstElementChild?.textContent.trim().slice(0, 18) ?? 'nothing'}", not a day`);
      }
    }

    // How far across its own card the content actually reaches. Height is the
    // scarce dimension; width going unused is the waste columns exist to take.
    const right = Math.max(box.left, ...rows.map((el) => el.getBoundingClientRect().right));
    out.widthUsed.push(box.width ? Math.round(((right - box.left) / box.width) * 100) : 0);
  }

  // The strip and the tile have to stay inside the screen too.
  const screen = document.getElementById('screen').getBoundingClientRect();
  for (const el of document.querySelectorAll('.wcol, .datebox, .weather, .clock')) {
    if (el.offsetParent === null && el.tagName !== 'DIV') continue;
    note(el.className.split(' ')[0], el, screen);
  }

  // Panels must not clip their own contents. The cards are allowed to (they
  // overflow: hidden by design and the fit loop keeps them honest), but a strip
  // that quietly cuts off its own temperatures looks like a working strip.
  for (const sel of ['.weather', '.datebox']) {
    const el = document.querySelector(sel);
    if (!el || el.offsetParent === null) continue;
    if (el.scrollHeight > el.clientHeight + 1) out.overflow.push(`${sel} clips its contents`);
  }

  // Bands must not land on top of each other. A flex column with min-height: 0
  // will happily shrink an item below its content and let it paint over the
  // next one, which is what portrait was doing.
  // .horizon included. It was left out, so the one band that sits between the
  // tile and the weather was the one band nothing checked — and a tall zmanim
  // list painted the tile straight through it.
  const bands = [...document.querySelectorAll('.topline, .horizon, .weather, .shuls')]
    .filter((el) => el.offsetParent !== null)
    .map((el) => [el.className.split(' ')[0], el.getBoundingClientRect()]);
  for (let i = 1; i < bands.length; i += 1) {
    if (bands[i][1].top < bands[i - 1][1].bottom - 1) {
      out.overflow.push(`${bands[i][0]} overlaps ${bands[i - 1][0]}`);
    }
  }
  // The tile against the strip below it, specifically. The band check above
  // compares BANDS, and the tile overflowing its own band is exactly the case
  // that slips past that.
  const tile = document.querySelector('.datebox');
  const strip = document.querySelector('.horizon');
  if (tile && strip && strip.offsetParent !== null) {
    const a = tile.getBoundingClientRect();
    const b2 = strip.getBoundingClientRect();
    if (a.right > b2.left + 1 && b2.right > a.left + 1
      && a.bottom > b2.top + 1 && b2.bottom > a.top + 1) {
      out.overflow.push('the date tile overlaps the horizon');
    }
  }

  if (document.documentElement.scrollWidth > window.innerWidth + 1) {
    out.overflow.push('the page itself scrolls sideways');
  }
  return out;
};

// Waits for the board to stop moving, rather than for a number of milliseconds.
//
// This suite asserts real pixels, and it measured after a flat 1500ms. The fit
// loop runs after first paint, the forecast lands a tick later and takes a band
// off the cards, which refits them, and each card then stretches into its own
// spare room. On a laptop that is all done well inside the wait; on a contended
// shared runner it sometimes was not, and the suite measured a board mid-fit
// and went red on a margin of a fraction of a point. Twice in a row, then green
// on a commit that touched only the workflow.
//
// So: poll the thing being asserted on — the card scales and the numeral sizes
// — and go when they have held still. Falls through after `limit` so a board
// that genuinely never settles still gets measured and fails loudly.
const settle = async (page, limit = 8000) => {
  // The clock is in here too: the clock-only view has no cards at all, and
  // watching an empty list would call that board settled the moment it loaded.
  const shape = () => page.evaluate(() => [
    getComputedStyle(document.getElementById('clockTime') ?? document.body).fontSize,
    ...[...document.querySelectorAll('.card')].map((c) =>
      `${getComputedStyle(c).getPropertyValue('--minyan-scale')}/`
      + `${[...c.querySelectorAll('.time')].map((t) => getComputedStyle(t).fontSize).join(',')}`),
  ].join('|'));
  const started = Date.now();
  let last = await shape();
  let stable = 0;
  while (Date.now() - started < limit) {
    await page.waitForTimeout(150);
    const now = await shape();
    stable = now === last ? stable + 1 : 0;
    last = now;
    // Three matching reads, so one slow frame in the middle of the fit loop
    // cannot pass for a settled board.
    if (stable >= 3) return;
  }
};

const VIEWS = [
  // iPad landscape, the way it is actually mounted.
  { name: 'friday-afternoon', at: '2026-09-25T14:00:00-04:00', size: [1180, 820] },
  { name: 'friday-night', at: '2026-09-25T19:30:00-04:00', size: [1180, 820] },
  { name: 'ordinary-weekday', at: '2026-09-23T10:00:00-04:00', size: [1180, 820] },
  { name: 'shabbos-morning', at: '2026-09-26T09:00:00-04:00', size: [1180, 820] },
  // Erev Succos: the board reaches Today, Tomorrow and Sunday at once, which is
  // the densest arrangement real data currently produces.
  { name: 'multi-day-board', at: '2026-09-25T20:00:00-04:00', size: [1180, 820] },
  { name: 'portrait', at: '2026-09-25T14:00:00-04:00', size: [768, 1024] },
  { name: 'three-shuls', at: '2026-09-25T14:00:00-04:00', size: [1180, 820],
    settings: { shuls: ['beth-aaron', 'ohr-saadya', 'rinat'] } },
  { name: 'zmanim-and-horizon', at: '2026-09-25T14:00:00-04:00', size: [1180, 820],
    settings: { showZmanim: true, showHorizon: true } },
  { name: 'weather-off', at: '2026-09-25T14:00:00-04:00', size: [1180, 820],
    settings: { showWeather: false } },
  { name: 'clock-only', at: '2026-09-25T17:00:00-04:00', size: [1180, 820],
    settings: { layout: 'clock', seconds: true } },
  { name: 'twelve-per-shul', at: '2026-09-25T14:00:00-04:00', size: [1180, 820],
    settings: { perShul: '12' } },
  { name: 'small-window', at: '2026-09-25T14:00:00-04:00', size: [900, 620] },
  // A desktop browser, which is where the waste showed: cards 660px wide with
  // the times using a third of that, because height was rationing the rows.
  { name: 'wide-desktop', at: '2026-09-25T20:00:00-04:00', size: [1470, 870], wide: true },
  // THE WORST THE WEATHER STRIP CAN BE ASKED TO DO.
  //
  // Kelvin is the widest reading (three digits and a unit where Fahrenheit has
  // two and a ring), every hour is wet so every tile carries a second line, and
  // the narrowest supported iPad gives twelve of them the least room there is.
  // If a cell's children are ever going to print over the hour beside them, it
  // is here.
  { name: 'kelvin-wet-portrait', at: '2026-09-25T14:00:00-04:00', size: [768, 1024],
    settings: { units: 'K' }, soaking: true },
  { name: 'kelvin-wet-landscape', at: '2026-09-25T14:00:00-04:00', size: [1180, 820],
    settings: { units: 'K' }, soaking: true },
];

await new Promise((r) => server.listen(0, r));
const port = server.address().port;
if (keepShots && !existsSync(SHOTS)) mkdirSync(SHOTS, { recursive: true });

const browser = await webkit.launch();
console.log(`WebKit ${browser.version()} — ${VIEWS.length} views\n`);

for (const view of VIEWS) {
  current = {
    at: view.at,
    settings: { shuls: ['beth-aaron', 'ohr-saadya'], theme: 'night', ...(view.settings ?? {}) },
  };
  const page = await browser.newPage({ viewport: { width: view.size[0], height: view.size[1] } });
  // Keep the forecast local and deterministic, and the scoreboard out entirely.
  await page.route('**/api.open-meteo.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify(forecast(view.at, view.soaking)) }));
  await page.route('**site.api.espn.com**', (route) => route.abort());

  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'load' });
  await settle(page);

  const m = await page.evaluate(MEASURE);
  console.log(`  ${view.name}  (${view.size.join('x')})  scale ${m.scale}`
    + ` · time ${m.timePx}\u2013${m.timePxMax}px · clock ${m.clockPx}px · face ${m.face}`
    + ` · cols ${m.columns.join('/')} · width ${m.widthUsed.join('/')}%`);
  ok(errors.length === 0, 'no page errors', errors.join('; '));
  ok(m.overflow.length === 0, 'nothing overflows its box', m.overflow.slice(0, 4).join(' | '));
  ok(m.clockPx >= MIN_CLOCK_PX, `the clock is at least ${MIN_CLOCK_PX}px (${m.clockPx})`);
  if (view.settings?.layout !== 'clock') {
    ok(m.cards > 0, 'the board rendered cards');
    ok(m.orphans.length === 0, 'every column opens on a day, none left behind',
      m.orphans.join(' | '));
    ok((m.cut ?? []).length === 0,
      'nothing glanceable is cut off', (m.cut ?? []).slice(0, 3).join(' | '));
    ok((m.contrast ?? []).length === 0,
      'everything important is readable across a room',
      (m.contrast ?? []).join(' | '));
    // A heading, not a masthead.
    ok((m.titles ?? []).every((p2) => p2 <= 26),
      `the shul name leaves the schedule its room (${(m.titles ?? []).join('%, ')}%)`);
    // The NEXT row may be taller — it carries a second line — but not so much
    // taller that it shifts the rows beside it into a different rhythm.
    for (const r of m.nextRows ?? []) {
      ok(r.flag <= r.line * 1.9,
        `the NEXT flag costs a line, not a row (${r.flag}px on ${r.line}px type)`);
    }
    // The strip fills its band rather than leaving a precipitation row's worth
    // of height empty on a dry day — but it may never GROW the band, because
    // the scores borrow it and every card below would move.
    ok((m.cells ?? []).length === 0,
      'every reading stays inside its own hour', (m.cells ?? []).slice(0, 3).join(' | '));
    if (m.wx) {
      // How much of the band it SPENDS, not what scale it happened to land on.
      // A scale of exactly 1 is not the goal and never was: content that
      // slightly overruns the floor settles at 0.99 and fills the band
      // perfectly well, which the first version of this assertion called a
      // failure.
      // 85%, not 100%. On a narrow screen the strip runs out of WIDTH across
      // twelve columns before it runs out of height, and the last few pixels
      // of the band are unreachable at any size — lowering the floor to chase
      // them just shrinks the content by the same proportion. What this is
      // guarding against is the hole that was there before any of this: 95
      // pixels of strip in a 150 pixel band.
      ok(m.wx.content >= m.wx.room * 0.85,
        `the weather fills its band (${m.wx.content} of ${m.wx.room})`);
      ok(m.wx.content <= m.wx.room,
        `and does not outgrow it (${m.wx.content} in ${m.wx.room})`);
    }
    if (view.wide) {
      ok(m.columns.every((n) => n >= 2),
        `a wide board splits its cards into columns (${m.columns.join(', ')})`);
      ok(Math.min(...m.widthUsed) >= 70,
        `and the cards use their width (${m.widthUsed.join('%, ')}%)`);
    }
    // Legibility is a promise Auto makes. Choosing 12 explicitly is the person
    // overriding that promise, and they are allowed to — but nothing is ever
    // allowed to overflow, which is asserted for every view above.
    if (!view.settings?.perShul) {
      ok(m.timePx === null || m.timePx >= MIN_TIME_PX,
        `every card's times are at least ${MIN_TIME_PX}px (smallest ${m.timePx})`);
      // A card may grow into its own spare room, but not so far that the board
      // stops looking like one board.
      ok(m.timePxMax === null || m.timePxMax <= m.timePx * 1.5,
        `and no card outgrows another by more than half (${m.timePx}\u2013${m.timePxMax})`);
    }
  }

  if (keepShots) {
    await page.screenshot({ path: join(SHOTS, `${view.name}.png`) });
    /* [26] AND THE SAME THING FROM THE DOORWAY.
       Every screenshot here gets looked at on a laptop, a foot away, at full
       size — which is the one distance this display is never read from. At 28%
       the type that is merely small becomes type that is not there, and "is
       the next minyan obvious" answers itself.

       The SAME viewport at a smaller device scale, not a smaller viewport: the
       first version of this shrank the window and zoomed the body, so the app
       re-fitted itself for a 330px screen and dropped half the schedule. That
       measured what the board does on a phone, which is not the question. This
       renders the wall exactly as it is and then photographs it from further
       away.

       Artifacts for looking at, not pixel diffs — the failure they catch is a
       judgement, and a judgement is not a thing to assert. */
    const far = await browser.newPage({
      viewport: { width: view.size[0], height: view.size[1] },
      deviceScaleFactor: 0.28,
    });
    await far.route('**/api.open-meteo.com/**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify(forecast(view.at, view.soaking)) }));
    await far.route('**site.api.espn.com**', (route) => route.abort());
    await far.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'load' });
    await settle(far);
    await far.screenshot({ path: join(SHOTS, `far-${view.name}.png`) });
    await far.close();
  }
  await page.close();
}

/* [27] TRANSITIONS -----------------------------------------------------------

   Everything else here photographs one moment. These are the moments the board
   moves THROUGH, and the failures live in the difference between two frames
   rather than in either one: a band that changes height as a day rolls over
   moves every card under it, and on a display nobody is touching, movement is
   the thing that gets noticed.

   A minute either side, so the pair differs by exactly the transition and by
   nothing else. */
{
  console.log('  transitions');
  const pairs = [
    ['the hour rolling over', '2026-09-25T13:59:00-04:00', '2026-09-25T14:01:00-04:00'],
    ['candle lighting', '2026-09-25T18:29:00-04:00', '2026-09-25T18:31:00-04:00'],
    ['nightfall into Succos II', '2026-09-26T19:25:00-04:00', '2026-09-26T19:29:00-04:00'],
    ['havdalah', '2026-09-27T19:24:00-04:00', '2026-09-27T19:28:00-04:00'],
    ['Yom Tov into Shabbos', '2027-04-23T18:00:00-04:00', '2027-04-23T20:00:00-04:00'],
  ];

  const frame = async (at) => {
    current = { at, settings: { theme: 'night', shuls: ['beth-aaron', 'ohr-saadya'] } };
    const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });
    await page.route('**/api.open-meteo.com/**', (r) =>
      route_ok(r, forecast(at)));
    await page.route('**site.api.espn.com**', (r) => r.abort());
    await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'load' });
    await settle(page);
    const m = await page.evaluate(MEASURE);
    const geo = await page.evaluate(() => ({
      cardTop: Math.round(document.querySelector('.card')?.getBoundingClientRect().top ?? 0),
      band: Math.round(document.getElementById('weather')?.getBoundingClientRect().height ?? 0),
      clock: Math.round(document.getElementById('clockTime')?.getBoundingClientRect().height ?? 0),
    }));
    await page.close();
    return { m, geo };
  };

  for (const [what, before, after] of pairs) {
    const a = await frame(before);
    const b = await frame(after);
    console.log(`    ${what}: card ${a.geo.cardTop} -> ${b.geo.cardTop},`
      + ` band ${a.geo.band} -> ${b.geo.band}`);
    ok(a.m.overflow.length === 0 && b.m.overflow.length === 0,
      `${what}: nothing overflows on either side`,
      [...a.m.overflow, ...b.m.overflow].slice(0, 2).join(' | '));
    // The weather band is the one the scores borrow, so its height is the thing
    // that must not move. The cards below may legitimately re-fit as the
    // schedule changes — that is the board doing its job — but the band above
    // them has no reason to.
    ok(Math.abs(a.geo.band - b.geo.band) <= 1,
      `${what}: the weather band holds its height (${a.geo.band} -> ${b.geo.band})`);
    ok(a.geo.clock === b.geo.clock,
      `${what}: and the clock does not resize (${a.geo.clock} -> ${b.geo.clock})`);
    ok((a.m.cut ?? []).length === 0 && (b.m.cut ?? []).length === 0,
      `${what}: nothing glanceable is cut off across it`,
      [...(a.m.cut ?? []), ...(b.m.cut ?? [])].slice(0, 2).join(' | '));
  }
}

/* The scores band ---------------------------------------------------------
   The densest thing on the display and the newest: five games, three-digit
   basketball scores, a playoff label, a long status, and the narrowest iPad.
   It borrows the weather band, so it also must not resize it — everything
   below would jump twice an hour. */
{
  console.log('  scores band');
  const at = '2026-09-24T08:00:00-04:00';
  const y = '2026-09-23';
  const g = (league, a, as, h, hs, extra = {}) => ({
    league, post: false, local: true, a, as: String(as), h, hs: String(hs),
    state: 'post', detail: 'Final', at: `${y}T23:30Z`, ...extra,
  });
  const BUSY = {
    NBA: { at: Date.parse(at), games: [
      g('NBA', 'BKN', 128, 'NY', 131, { detail: 'Final/OT' }),
      g('NBA', 'BOS', 109, 'PHI', 104),
    ] },
    MLB: { at: Date.parse(at), games: [
      g('MLB', 'LAD', 3, 'SD', 2, { post: true, local: false, detail: 'Final/10' }),
      g('MLB', 'TB', 4, 'NYY', 7),
    ] },
    NHL: { at: Date.parse(at), games: [
      g('NHL', 'NJ', 2, 'NYR', 1, { state: 'in', detail: '3rd 04:12', at: `2026-09-24T11:30Z` }),
    ] },
  };
  // A quiet night, which is most of them. Five games is the crush the band has
  // to survive; two is what is actually on the wall on a Tuesday in February,
  // and it is the case where each game gets a wide column and the sport marks
  // have room to be worth looking at.
  const QUIET = {
    MLB: { at: Date.parse(at), games: [
      g('MLB', 'LAD', 3, 'SD', 2, { post: true, local: false, detail: 'Final/10' }),
    ] },
    NHL: { at: Date.parse(at), games: [
      g('NHL', 'NJ', 2, 'NYR', 1, { detail: 'Final' }),
    ] },
  };

  for (const [size, leagues, want, tag] of [
    [[1180, 820], BUSY, 5, 'busy'],
    [[768, 1024], BUSY, 5, 'busy'],
    [[1180, 820], QUIET, 2, 'quiet'],
  ]) {
    current = { at, settings: { theme: 'night', sports: '2' }, scores: { leagues } };
    const page = await browser.newPage({ viewport: { width: size[0], height: size[1] } });
    await page.route('**/api.open-meteo.com/**', (r) => route_ok(r, forecast(at)));
    // Sealed off from the real scoreboard. Without this the startup warm-up
    // fetches ESPN for real and replaces the fixture with whatever is on
    // tonight — the test then measures a board nobody chose.
    await page.route('**site.api.espn.com**', (r) => r.abort());
    await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'load' });
    await settle(page);

    const before = await page.evaluate(() =>
      Math.round(document.querySelector('.card').getBoundingClientRect().top));

    // Reach the interval through the real scheduler.
    await page.evaluate(() => { tick(); window.__advance(3 * 60000); tick(); });
    await page.waitForTimeout(300);

    // The band is its own picture. It is the densest thing on the display and
    // the sport marks live only here, so a full-screen shot of the board shows
    // none of it.
    if (keepShots) {
      await page.locator('.weather.sports').screenshot({
        path: join(SHOTS, `scores-${tag}-${size[0]}x${size[1]}.png`) });
    }

    const m = await page.evaluate(MEASURE);
    const band = await page.evaluate(() => ({
      games: document.querySelectorAll('.sgame').length,
      top: Math.round(document.querySelector('.card').getBoundingClientRect().top),
      label: document.querySelector('.ssub')?.textContent ?? '',
      clipped: [...document.querySelectorAll('.sgame')].some((el) => {
        const box = el.closest('.weather').getBoundingClientRect();
        const r = el.getBoundingClientRect();
        return r.right > box.right + 1 || r.bottom > box.bottom + 1;
      }),
    }));

    // A team and its score have to read as one thing. They used to be
    // space-between across the whole column — "NYM · · · · · · 4" — so the eye
    // had to travel to pair them, which is the only thing this strip is for.
    // Geometry, because display: contents changes layout and not the DOM, so
    // this cannot be seen from jsdom at all.
    const pairing = await page.evaluate(() => {
      const out = { gap: 0, misaligned: 0 };
      for (const g of document.querySelectorAll('.sgame')) {
        const abbrs = [...g.querySelectorAll('.sabbr')];
        const scores = [...g.querySelectorAll('.sscore')];
        abbrs.forEach((a, i) => {
          const s2 = scores[i];
          if (!s2) return;
          out.gap = Math.max(out.gap, s2.getBoundingClientRect().left
            - a.getBoundingClientRect().right);
        });
        // The two scores of one game should sit under each other.
        if (scores.length === 2) {
          const d = Math.abs(scores[0].getBoundingClientRect().right
            - scores[1].getBoundingClientRect().right);
          if (d > 1) out.misaligned += 1;
        }
      }
      return out;
    });

    console.log(`    ${size.join('x')} ${tag}  ${band.games} games · "${band.label}"`
      + ` · name-to-score ${Math.round(pairing.gap)}px`);
    ok(band.games === want, `all ${want} are shown (${band.games})`);
    ok(!band.clipped, 'none of them overflows the band');
    ok(m.overflow.length === 0, 'and nothing else on the screen does either',
      m.overflow.slice(0, 3).join(' | '));
    ok(band.top === before, `the band does not resize when it swaps (${before} -> ${band.top})`);
    ok(pairing.gap <= 24,
      `a score sits beside its team, not across the column (${Math.round(pairing.gap)}px)`);
    ok(pairing.misaligned === 0,
      `and the two scores of a game line up under each other (${pairing.misaligned} do not)`);
    await page.close();
  }
}

/* The flight layer -------------------------------------------------------
   The car laps the screen boundary, so unlike everything else that flies past
   it should be whole the entire time. Its margin was a constant written when
   the artwork was a third of its current size, and it spent its whole
   forty-eight-second lap clipped — never once fully visible — while every other
   vehicle reached 100%. Sampled along the bottom run, before the first corner,
   where there is no excuse for any of it to be off screen. */
{
  console.log('  family flights');
  current = { at: '2026-09-25T14:00:00-04:00', settings: { theme: 'night' } };
  const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });
  await page.route('**/api.open-meteo.com/**', (r) => r.abort());
  await page.route('**site.api.espn.com**', (r) => r.abort());
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'load' });
  await settle(page);

  const hook = await page.evaluate(() => typeof window.shabbosFlights?.send === 'function');
  ok(hook, 'the flight layer exposes a way to launch one deliberately');

  const car = await page.evaluate(async () => {
    window.shabbosFlights.send('car');
    await new Promise((r) => setTimeout(r, 80));
    const el = document.querySelector('.flight:last-child');
    if (!el) return null;
    const seen = [];
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 150));
      if (!el.isConnected) break;
      const b = el.getBoundingClientRect();
      if (!b.width) break;
      const vis = Math.max(0, Math.min(b.right, innerWidth) - Math.max(b.left, 0))
        * Math.max(0, Math.min(b.bottom, innerHeight) - Math.max(b.top, 0));
      seen.push(vis / (b.width * b.height || 1));
    }
    if (el.isConnected) el.remove();
    return seen.length ? { worst: Math.min(...seen), n: seen.length } : null;
  });

  ok(car !== null, 'a car can be launched and measured');

  // The corner is a TURN, not a snap. The lap used to be four straight edges
  // with the heading flipping 0 -> -90 -> 180 -> 90 in a single frame, right at
  // the moment the eye is following the car.
  //
  // Sampled through the path hook rather than off the rendered element: a lap
  // takes the better part of a minute, so watching the real thing sees only the
  // opening straight, where nothing turns and the test passes on 0.0 degrees
  // without having looked at a single corner.
  const turning = await page.evaluate(() => {
    const out = [];
    for (let i = 0; i <= 600; i += 1) {
      out.push(window.shabbosFlights.path('car', i / 600, 1180, 820).rot);
    }
    return out;
  });
  const steps = turning.slice(1).map((v, i) => Math.abs(v - turning[i]));
  const worst = Math.max(...steps);
  const swept = Math.abs(turning[turning.length - 1] - turning[0]);
  ok(worst < 20,
    `the car turns the corner rather than snapping round it (worst ${worst.toFixed(1)}° between samples)`);
  // All four corners actually happen, and in one direction: a heading that
  // wrapped through 180 would make CSS take the long way and spin the car.
  ok(swept > 300,
    `and it comes all the way round (${swept.toFixed(0)}° swept)`);
  ok(steps.every((d, i) => turning[i + 1] <= turning[i] + 0.001),
    'without the heading ever winding back on itself');
  if (car) {
    ok(car.worst >= 0.95,
      `the car stays on screen along its lap (worst ${Math.round(car.worst * 100)}%)`);
  }

  /* The top of the hour.
     Everything else about flights is deliberately unpredictable, so this is
     the one part that can be stated exactly: several at once, all different,
     all on screen. It also cannot be waited for — an hour is longer than any
     test — so it is driven through the hook. */
  const many = await page.evaluate(async () => {
    document.querySelectorAll('.flight').forEach((el) => el.remove());
    const n = window.shabbosFlights.parade();
    // Sampled rather than checked once at the end. The point of the parade is
    // that it is on screen TOGETHER, and the vehicles do not last equally long
    // — the rocket clears in under two seconds and the train takes twenty — so
    // a single count taken late measures the slow ones and nothing else.
    // Sampled across the WHOLE spread. A repeat waits eight seconds behind its
    // twin — small against a lap of twenty to fifty seconds, but far longer
    // than the ordinary stagger — so a sampling window of a few seconds counts
    // the head of the parade and calls the tail missing.
    let peak = 0;
    const seen = new Map();
    for (let i = 0; i < 80; i += 1) {
      await new Promise((r) => setTimeout(r, 150));
      const now2 = [...document.querySelectorAll('.flight')];
      peak = Math.max(peak, now2.length);
      for (const el of now2) {
        const b = el.getBoundingClientRect();
        const on = b.width > 0 && b.right > 0 && b.left < innerWidth;
        seen.set(el, (seen.get(el) ?? false) || on);
      }
    }
    const els = [...document.querySelectorAll('.flight')];
    const kinds = new Set(els.map((el) => el.className.replace('flight', '').trim()));
    // Counted over the WHOLE sampling window, not at one instant. Every vehicle
    // starts outside the frame and drives in — that is what a lane is — so a
    // single late reading catches whichever one launched most recently and
    // calls it lost. What matters is that each one arrives.
    const offscreen = [...seen.values()].filter((v2) => !v2).length;
    const kinds0 = window.shabbosFlights.names().length;
    const hourMs = window.shabbosFlights.untilTheHour();
    // Computed in here, against the PAGE's clock. This page is frozen at
    // 14:00:00, and comparing that to the runner's real wall clock measures
    // nothing but the gap between the two.
    const landsOn = (Date.now() + hourMs) % 3600000;
    els.forEach((el) => el.remove());
    return { n, peak, shown: els.length, kinds: kinds.size, kinds0, offscreen, hourMs, landsOn };
  });

  ok(many.n >= 7 && many.n <= 10, `the hour sends between seven and ten (${many.n})`);
  // Together, which is the whole point — not merely that each one happened at
  // some time or other. The rocket may already have cleared, so this asks for
  // a crowd rather than the exact count.
  ok(many.peak >= Math.min(many.n, 6),
    `and they are in the air together (${many.peak} at once, of ${many.n})`);
  // Repeats are allowed and expected. What matters is that the whole parade is
  // in the air TOGETHER — a lap takes most of a minute, so every one of them
  // launched inside the window is still crossing when the last goes.
  ok(many.kinds >= 2, `and it is not all one vehicle (${many.kinds} kinds)`);
  ok(many.offscreen === 0, `none of them starts off screen (${many.offscreen})`);
  // Lands on the clock on the wall, not on however long the tab has been open.
  ok(many.hourMs > 0 && many.hourMs <= 3600000,
    `the next one is within the hour (${Math.round(many.hourMs / 1000)}s)`);
  ok(many.landsOn === 0, `and it lands on the hour itself (+${many.landsOn}ms)`);
  // Standing exactly on the hour asks for the NEXT one, not this one again —
  // which is the case this page happens to be frozen in.
  ok(many.hourMs === 3600000,
    `on the hour exactly, it waits for the next (${many.hourMs}ms)`);

  /* THE TRAIN IS RIGGED, not animated ------------------------------------

     Two things separate a rigged vehicle from a picture on a timer, and both
     are invisible to every static gate:

     the wheels roll the distance actually travelled — they used to turn on a
     fixed CSS interval with no relation to the speed, which is why the car
     skidded its whole lap;

     and the smoke, once it leaves the funnel, belongs to the air. It used to be
     drawn inside the vehicle and travelled along with it, which is precisely
     why the train never looked like it was going anywhere. */
  const rigged = await page.evaluate(async () => {
    document.querySelectorAll('.flight').forEach((n) => n.remove());
    window.shabbosFlights.send('train');
    const el = document.querySelector('.flight.train');
    const wheel = el.querySelector('.engine .wheel');
    const readX = (n) => {
      const m = /translate\(([-\d.]+)px/.exec(getComputedStyle(n).transform === 'none'
        ? n.style.transform : n.style.transform);
      return m ? Number(m[1]) : NaN;
    };
    const readSpin = () => {
      const m = /rotate\(([-\d.]+)\)/.exec(wheel.getAttribute('transform') ?? '');
      return m ? Number(m[1]) : NaN;
    };
    // How far each puff has wandered from where it was released. Comparing the
    // MEAN x of all puffs was the wrong measure and passed for the wrong
    // reason: the set is not the same set a second later, so its average
    // tracked the funnel whether or not any individual puff had moved.
    const puffDrift = () => [...document.querySelectorAll('.flyway .puff')]
      .filter((n) => n.style.display !== 'none' && n.dataset.x0 !== undefined)
      .map((n) => Math.abs(Number(n.getAttribute('cx')) - Number(n.dataset.x0)));

    await new Promise((r) => setTimeout(r, 1400));
    const a = { x: readX(el), spin: readSpin(), puffs: puffDrift() };
    await new Promise((r) => setTimeout(r, 1400));
    const b = { x: readX(el), spin: readSpin(), puffs: puffDrift() };
    const { scale } = window.shabbosFlights.metrics('train', innerWidth);
    el.remove();
    return { a, b, scale };
  });

  {
    const moved = Math.abs(rigged.b.x - rigged.a.x);
    // Radius in screen pixels: 15 artwork units, the engine group's 1.3, and
    // whatever the vehicle is flying at.
    const r = 15 * 1.3 * rigged.scale;
    const wantDeg = ((moved / r) * 180) / Math.PI;
    // The wheel's rotate() wraps; compare the turn modulo a revolution.
    const gotDeg = ((rigged.b.spin - rigged.a.spin) % 360 + 360) % 360;
    const wantMod = (wantDeg % 360 + 360) % 360;
    const err = Math.abs(gotDeg - wantMod);
    const off = Math.min(err, 360 - err);
    // Enough travel that a wheel has turned several times; the train crosses at
    // about 60 px/s on screen and this samples 1.4 s of it.
    ok(moved > 50, `the train covers ground to measure (${moved.toFixed(0)} px)`);
    ok(off / 360 < 0.01,
      `its wheels roll the distance travelled, within 1% (${off.toFixed(1)}° out of 360)`);
  }
  {
    const movedTrain = Math.abs(rigged.b.x - rigged.a.x);
    const all = [...rigged.a.puffs, ...rigged.b.puffs];
    ok(rigged.a.puffs.length > 0, `the funnel is emitting (${rigged.a.puffs.length} puffs up)`);
    // Each puff against ITS OWN release point. They have a little sideways
    // velocity of their own and air to drift in, so this is not zero — but it
    // is nothing like the distance the train covers in the same time.
    const worst = all.length ? Math.max(...all) : 0;
    ok(worst < movedTrain * 0.2,
      `and each puff stays where it was released (worst ${worst.toFixed(0)} px `
      + `while the train went ${movedTrain.toFixed(0)})`);
  }

  /* PHASE 2: the car drives and the boat floats ---------------------------- */
  {
    // The lap is driven by a speed profile now, not by a sine that happened to
    // brake on the straights: it was slowest at 12, 37, 62 and 87% of the lap
    // while the corners are at 27, 47, 77 and 97, so it accelerated INTO every
    // bend. Sampled off the pure path, which is the thing the profile shapes.
    const lap = await page.evaluate(() => {
      const out = [];
      let prev = window.shabbosFlights.path('car', 0, innerWidth, innerHeight);
      for (let i = 1; i <= 600; i += 1) {
        const q = window.shabbosFlights.path('car', i / 600, innerWidth, innerHeight);
        out.push({ step: Math.hypot(q.x - prev.x, q.y - prev.y), rot: q.rot });
        prev = q;
      }
      return out;
    });
    const bend = (r) => Math.abs(r % 90) > 0.5;
    const slowest = [...lap].sort((a, b) => a.step - b.step).slice(0, 60);
    const inBend = slowest.filter((s2) => bend(s2.rot)).length;
    const range = Math.max(...lap.map((l) => l.step)) / Math.min(...lap.map((l) => l.step));
    ok(range > 1.6, `the car's speed actually varies round the lap (${range.toFixed(1)}:1)`);
    ok(inBend >= 57, `and its slowest points are in the corners (${inBend}/60)`);
  }

  {
    // THE RIDER STAYS UPRIGHT. At the top of the lap the car is upside down and
    // the person in it is not — counter-rotated through a spring, so the head
    // lags a beat rather than snapping level.
    // Driven through update() at attitudes the car really reaches, rather than
    // watched. A lap takes about forty seconds; watching ninety frames of one
    // sees a second and a half of the opening straight, where the car is level,
    // the head is level, and the test passes on 0.0° without having looked at a
    // single corner. That is the same way the first cornering test fooled me.
    const upright = await page.evaluate(async () => {
      const spec = window.shabbosFlights.spec('car');
      const made = new Map();
      const stub = () => ({
        style: {}, dataset: {},
        setAttribute() {}, getAttribute: () => '',
      });
      const rig = {
        mem: {}, q: (sel) => made.get(sel) ?? (made.set(sel, stub()), made.get(sel)),
        qa: () => [], seat: () => made.get('seat') ?? (made.set('seat', stub()), made.get('seat')),
        point: () => ({ x: 0, y: 0 }), smoke: { emit() {} }, spray: { emit() {} }, t: 0,
      };
      let worst = 0;
      // Upside down at the top of the lap, which is the case this exists for.
      for (const rot of [0, -90, -180, -270, -360]) {
        for (let i = 0; i < 90; i += 1) {
          spec.update(rig, { x: 500, y: 400, rot, speed: 120, accel: 0, dist: i * 2, p: 0.5, scale: 2 }, 1 / 60);
        }
        const head = Number(/rotate\(([-\d.]+)deg\)/.exec(rig.seat().style.transform ?? '')?.[1] ?? 0);
        worst = Math.max(worst, Math.abs(rot + head));
      }
      return worst;
    });
    ok(upright <= 15, `the rider stays within 15° of level (worst ${upright.toFixed(1)}°)`);
  }

  {
    // THE BOAT RIDES THE SEA, and a boat that rolls past about thirty degrees
    // has capsized. kinetics carries a note about the bug this guards: measured
    // stern to bow, a boat heading left came out 180° over and rendered upside
    // down.
    const tilt = await page.evaluate(async () => {
      document.querySelectorAll('.flight').forEach((n) => n.remove());
      window.shabbosFlights.send('boat');
      const el = document.querySelector('.flight.boat');
      let worst = 0;
      for (let i = 0; i < 150; i += 1) {
        await new Promise((r) => requestAnimationFrame(r));
        const rock = el.querySelector('.rock');
        const m = /rotate\(([-\d.]+)/.exec(rock?.getAttribute('transform') ?? '');
        if (m) worst = Math.max(worst, Math.abs(Number(m[1])));
      }
      el.remove();
      document.querySelectorAll('.flyway .sea').forEach((n) => n.remove());
      return worst;
    });
    ok(tilt > 0.2, `the boat is actually rocking (worst ${tilt.toFixed(1)}°)`);
    ok(tilt <= 30, `and never past 30° (worst ${tilt.toFixed(1)}°)`);
  }

  /* PHASE 4: rare moments -------------------------------------------------- */
  {
    // A rare flight is a DIFFERENT SHAPE of its own kind, and none of that may
    // reach the definition every other flight is built from. The longer train
    // is made by spreading a new shape over a copy; spread over the original it
    // would have put a fourth carriage on every train from then on.
    const leak = await page.evaluate(async () => {
      const before = window.shabbosFlights.spec('train');
      const was = { seats: before.seats, vb: [...before.vb], slots: before.slots.length };
      document.querySelectorAll('.flight').forEach((n) => n.remove());
      window.shabbosFlights.send('train', { rare: true });
      await new Promise((r) => setTimeout(r, 120));
      const long = document.querySelector('.flight.train svg')?.getAttribute('viewBox');
      document.querySelectorAll('.flight').forEach((n) => n.remove());
      window.shabbosFlights.send('train');
      await new Promise((r) => setTimeout(r, 120));
      const plain = document.querySelector('.flight.train svg')?.getAttribute('viewBox');
      const after = window.shabbosFlights.spec('train');
      document.querySelectorAll('.flight').forEach((n) => n.remove());
      return { was, long, plain, now: { seats: after.seats, vb: [...after.vb], slots: after.slots.length } };
    });
    ok(leak.long !== leak.plain && /^0 0 716/.test(leak.long ?? ''),
      `the rare train is a carriage longer (${leak.long} against ${leak.plain})`);
    ok(leak.was.seats === leak.now.seats && leak.was.vb[0] === leak.now.vb[0]
      && leak.was.slots === leak.now.slots,
      'and the shared definition is untouched by it');

    // THE WHISTLE ACTUALLY APPEARS. Its particles were in the DOM with the
    // right radius and the right colour and no box at all for a while, because
    // they were painted as `.steam` and styles.css gives a sports team row
    // `display: contents`. Measured, not asserted: what is on the screen.
    const whistle = await page.evaluate(async () => {
      document.querySelectorAll('.flyway .puffs > *').forEach((n) => n.remove());
      document.querySelectorAll('.flight').forEach((n) => n.remove());
      window.shabbosFlights.send('train', { rare: true });
      const el = document.querySelector('.flight.train');
      let marked = false;
      let boxed = 0;
      for (let i = 0; i < 900 && el.isConnected; i += 1) {
        await new Promise((r) => requestAnimationFrame(r));
        if (el.dataset.moment) marked = true;
        const jets = [...document.querySelectorAll('.flyway .jet')]
          .filter((n) => n.style.display !== 'none' && n.getBoundingClientRect().width > 0);
        boxed = Math.max(boxed, jets.length);
        if (marked && boxed) break;
      }
      el.remove();
      document.querySelectorAll('.flyway .puffs > *').forEach((n) => n.remove());
      return { marked, boxed };
    });
    ok(whistle.marked, 'the rare train raises its moment while it whistles');
    ok(whistle.boxed > 0, `and the steam is drawn, not merely in the DOM (${whistle.boxed} with a box)`);

    // AN ORDINARY FLIGHT HAS NO MOMENT. One in fifteen is the point; the seed
    // is drawn once per flight, so a plain one must never light up mid-crossing.
    const plainCar = await page.evaluate(async () => {
      document.querySelectorAll('.flight').forEach((n) => n.remove());
      window.shabbosFlights.send('car', { rare: false });
      const el = document.querySelector('.flight.car');
      let ever = false;
      for (let i = 0; i < 240 && el.isConnected; i += 1) {
        await new Promise((r) => requestAnimationFrame(r));
        if (el.dataset.moment) ever = true;
      }
      el.remove();
      return ever;
    });
    ok(!plainCar, 'and a flight that is not the rare one never has a moment');

    // WHAT IS DROPPED IS DROPPED. The stage goes into the world layer, so it
    // stays where it was let go while the rocket climbs away from it — the same
    // claim the exhaust makes, about something with a shape.
    const shed = await page.evaluate(async () => {
      document.querySelectorAll('.flight').forEach((n) => n.remove());
      window.shabbosFlights.send('rocket', { rare: true });
      const el = document.querySelector('.flight.rocket');
      let start = null;
      let gap = 0;
      for (let i = 0; i < 600 && el.isConnected; i += 1) {
        await new Promise((r) => requestAnimationFrame(r));
        const d = document.querySelector('.flyway .debris');
        if (!d) continue;
        const db = d.getBoundingClientRect();
        const rb = el.getBoundingClientRect();
        if (!start) start = { d: db.top, r: rb.top };
        gap = Math.max(gap, (db.top - start.d) - (rb.top - start.r));
      }
      if (el.isConnected) el.remove();
      document.querySelectorAll('.flyway .debris').forEach((n) => n.remove());
      return { seen: start !== null, gap };
    });
    ok(shed.seen, 'the rare rocket sheds a stage');
    ok(shed.gap > 60, `and the rocket climbs away from it (${shed.gap.toFixed(0)} px apart)`);
  }

  await page.close();
}

await browser.close();
server.close();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
