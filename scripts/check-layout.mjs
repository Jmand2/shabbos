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

function forecast(at) {
  const base = new Date(at);
  base.setMinutes(0, 0, 0);
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + `T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const hourly = {
    time: [], temperature_2m: [], precipitation_probability: [], weather_code: [], is_day: [],
  };
  const daily = { time: [], temperature_2m_max: [], temperature_2m_min: [] };
  for (let i = 0; i < 96; i += 1) {
    const d = new Date(base.getTime() + i * 3600000);
    hourly.time.push(stamp(d));
    hourly.temperature_2m.push(60 + (i % 12));
    hourly.precipitation_probability.push([0, 40, 5, 10, 60, 8][i % 6]);
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

  for (const card of document.querySelectorAll('.card')) {
    const body = card.querySelector('.body');
    if (!body) continue;
    const box = body.getBoundingClientRect();
    for (const el of card.querySelectorAll('.time, .label, .group')) note('card row', el, box);
    if (body.scrollHeight > body.clientHeight + 1) out.overflow.push('card body scrolls vertically');
    if (body.scrollWidth > body.clientWidth + 1) out.overflow.push('card body scrolls horizontally');
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
  const bands = [...document.querySelectorAll('.topline, .weather, .shuls')]
    .filter((el) => el.offsetParent !== null)
    .map((el) => [el.className.split(' ')[0], el.getBoundingClientRect()]);
  for (let i = 1; i < bands.length; i += 1) {
    if (bands[i][1].top < bands[i - 1][1].bottom - 1) {
      out.overflow.push(`${bands[i][0]} overlaps ${bands[i - 1][0]}`);
    }
  }
  if (document.documentElement.scrollWidth > window.innerWidth + 1) {
    out.overflow.push('the page itself scrolls sideways');
  }
  return out;
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
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(forecast(view.at)) }));
  await page.route('**site.api.espn.com**', (route) => route.abort());

  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'load' });
  // Let the board settle: the fit loop runs after the first paint, and the
  // weather arrives a tick later and takes a band off the cards.
  // Generous: the fit loop runs after first paint and the forecast lands a tick
  // later, and a shared CI runner is a great deal slower than a laptop.
  await page.waitForTimeout(1500);

  const m = await page.evaluate(MEASURE);
  console.log(`  ${view.name}  (${view.size.join('x')})  scale ${m.scale}`
    + ` · time ${m.timePx}\u2013${m.timePxMax}px · clock ${m.clockPx}px · face ${m.face}`);
  ok(errors.length === 0, 'no page errors', errors.join('; '));
  ok(m.overflow.length === 0, 'nothing overflows its box', m.overflow.slice(0, 4).join(' | '));
  ok(m.clockPx >= MIN_CLOCK_PX, `the clock is at least ${MIN_CLOCK_PX}px (${m.clockPx})`);
  if (view.settings?.layout !== 'clock') {
    ok(m.cards > 0, 'the board rendered cards');
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

  if (keepShots) await page.screenshot({ path: join(SHOTS, `${view.name}.png`) });
  await page.close();
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
  current = {
    at,
    settings: { theme: 'night', sports: '2' },
    scores: { leagues: {
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
    } },
  };

  for (const size of [[1180, 820], [768, 1024]]) {
    const page = await browser.newPage({ viewport: { width: size[0], height: size[1] } });
    await page.route('**/api.open-meteo.com/**', (r) => route_ok(r, forecast(at)));
    // Sealed off from the real scoreboard. Without this the startup warm-up
    // fetches ESPN for real and replaces the fixture with whatever is on
    // tonight — the test then measures a board nobody chose.
    await page.route('**site.api.espn.com**', (r) => r.abort());
    await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'load' });
    await page.waitForTimeout(1200);

    const before = await page.evaluate(() =>
      Math.round(document.querySelector('.card').getBoundingClientRect().top));

    // Reach the interval through the real scheduler.
    await page.evaluate(() => { tick(); window.__advance(3 * 60000); tick(); });
    await page.waitForTimeout(300);

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

    console.log(`    ${size.join('x')}  ${band.games} games · "${band.label}"`
      + ` · name-to-score ${Math.round(pairing.gap)}px`);
    ok(band.games === 5, `all five are shown (${band.games})`);
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
  await page.waitForTimeout(1200);

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
  if (car) {
    ok(car.worst >= 0.95,
      `the car stays on screen along its lap (worst ${Math.round(car.worst * 100)}%)`);
  }
  await page.close();
}

await browser.close();
server.close();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
