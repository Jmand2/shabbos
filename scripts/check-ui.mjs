// The behaviour check.mjs cannot see. check.mjs renders one frozen moment and
// reads the text; this drives a clock that advances, so it can catch the things
// that only go wrong over time or across a setting change: the board repainting
// twice a minute, the empty-state cache sticking, the horizon not rolling over
// at nightfall, and a blanked label.
//
//   npm i --no-save jsdom
//   TZ=America/New_York node scripts/check-ui.mjs
//
// Minyan times come from scripts/fixtures/minyanim.json, a frozen copy, so the
// dates below are stable and mean the same thing every run. They used to read
// data/minyanim.json, which the scraper rewrites three times a day and trims to
// a few days either side of today — so these tests rotted on their own, and the
// advice here used to be "shift them by whole weeks when they go red". A test
// that has to be rewritten on a schedule is not testing anything.
//
// To refresh the fixture deliberately (a new shul, a changed offset):
//   cp data/minyanim.json scripts/fixtures/minyanim.json
// and then re-check every asserted time, because that is the moment they can
// legitimately change. shuls.json is NOT frozen — it is configuration, and a
// change to it should be caught here rather than hidden.
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url);
const file = (name) => readFileSync(new URL(name, ROOT), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, msg, extra = '') => {
  if (cond) { pass += 1; console.log('  PASS', msg); }
  else { fail += 1; console.log('  FAIL', msg, extra); }
};

// A clock that advances: each `new Date()` returns base + however far we've stepped.
async function boot(startIso, { settings = null, killMatchMedia = false, forecast = null, minyanim = null } = {}) {
  const dom = new JSDOM(file('index.html'),
    { runScripts: 'outside-only', url: 'https://x.test/', pretendToBeVisual: true });
  const w = dom.window;
  const Real = w.Date;
  const base = new Real(startIso).getTime();
  const state = { offset: 0 };
  class Clock extends Real {
    constructor(...a) { super(...(a.length ? a : [base + state.offset])); }
    static now() { return base + state.offset; }
  }
  w.Date = Clock;
  if (killMatchMedia) delete w.matchMedia;
  if (settings) w.localStorage.setItem('shabbos-clock-settings', JSON.stringify(settings));
  // The live forecast is a cross-origin call the stub below cannot answer, and
  // app.js swallows that by design. Seeding the cache is how the strip gets
  // data here — and it is also the real offline path, so it is worth testing.
  if (forecast) w.localStorage.setItem('shabbos-clock-weather', JSON.stringify(forecast));
  w.fetch = async (u) => {
    if (String(u).includes('open-meteo')) throw new Error('offline');
    let path = String(u).replace(/^.*?(data\/[^?]+).*$/, '$1');
    // Minyan times come from the frozen fixture, never from data/minyanim.json.
    // That file is rewritten three times a day by the scraper and keeps only a
    // few days either side of today, so assertions against it rot on their own:
    // the dates stay in range and the TIMES UNDER THEM change, which is how four
    // of these went red without a line of app code moving.
    if (path.includes('minyanim.json')) {
      if (minyanim) return { ok: true, json: async () => minyanim };
      path = 'scripts/fixtures/minyanim.json';
    }
    return { ok: true, json: async () => JSON.parse(file(path)) };
  };
  const wake = { grants: 0 };
  w.navigator.wakeLock = { request: async () => { wake.grants += 1; return {}; } };
  let vis = 'visible';
  Object.defineProperty(w.document, 'visibilityState', { get: () => vis, configurable: true });
  const setVisible = (v) => {
    vis = v;
    w.document.dispatchEvent(new w.Event('visibilitychange'));
  };
  const errors = [];
  w.addEventListener('error', (e) => errors.push(e.message));
  w.eval(file('vendor/kosher-zmanim.min.js'));
  w.eval(file('app.js'));
  await new Promise((r) => setTimeout(r, 150));
  return { w, state, errors, wake, setVisible, advance: (ms) => { state.offset += ms; } };
}

const $ = (w, id) => w.document.getElementById(id);

/* E1 — the board must not be rebuilt on every render -------------------- */
console.log('\n=== E1: board is not rebuilt when nothing changed ===');
{
  const { w, advance } = await boot('2026-09-22T14:05:00-04:00');
  const firstCard = w.document.querySelector('.card');
  ok(!!firstCard, 'a card rendered at all');
  let replaced = 0;
  for (let i = 0; i < 20; i += 1) {
    advance(30000);            // 10 minutes of renders, 30s apart
    w.eval('render()');
    if (w.document.querySelector('.card') !== firstCard) { replaced += 1; break; }
  }
  ok(replaced === 0, '20 renders across 10 minutes replace zero card nodes',
    `(replaced after ${replaced})`);
}

/* E1b — but a genuine change DOES repaint -------------------------------- */
console.log('\n=== E1b: a real content change still repaints ===');
{
  const { w, advance } = await boot('2026-09-22T14:05:00-04:00');
  const firstCard = w.document.querySelector('.card');
  advance(6 * 3600 * 1000);    // six hours later: different minyanim are ahead
  w.eval('render()');
  ok(w.document.querySelector('.card') !== firstCard,
    'the board is rebuilt once the times genuinely change');
}

/* F1 — unchecking the last shul then re-checking it must recover --------- */
console.log('\n=== F1: last-shul uncheck/recheck recovers (driven through the DOM) ===');
{
  const { w } = await boot('2026-09-22T14:05:00-04:00', { settings: { shuls: ['beth-aaron'] } });
  const box = w.document.querySelector('#shulPicker input[value="beth-aaron"]');
  ok(!!box, 'found the beth-aaron checkbox');
  const before = $(w, 'shuls').innerHTML;
  ok(before.includes('card'), 'board starts with a card');

  box.checked = false;
  box.dispatchEvent(new w.Event('change', { bubbles: true }));
  ok($(w, 'shuls').textContent.includes('No shuls chosen'), 'unchecking shows the empty state');

  box.checked = true;
  box.dispatchEvent(new w.Event('change', { bubbles: true }));
  const after = $(w, 'shuls').innerHTML;
  ok(after.includes('card') && !after.includes('No shuls chosen'),
    're-checking the same shul brings the board back',
    `(got: ${$(w, 'shuls').textContent.slice(0, 40)})`);
}

/* F2 — the sun is repositioned in place, not recreated ------------------- */
console.log('\n=== F2: the sun is one node that moves ===');
{
  const { w, advance } = await boot('2026-09-22T14:05:00-04:00',
    { settings: { showHorizon: true } });
  const sun = $(w, 'sun');
  const positions = new Set();
  let same = true;
  for (let i = 0; i < 10; i += 1) {
    advance(5 * 60000);
    w.eval('render()');
    if ($(w, 'sun') !== sun) same = false;
    positions.add(sun.style.left);
  }
  ok(same, 'the sun is the same node across ten renders');
  ok(positions.size === 10, 'the sun moved on every one of the ten renders',
    `(${positions.size} distinct positions)`);
}

/* C — the horizon is the solar day, marked and collision-free ------------ */
console.log('\n=== C: the horizon ===');
const zmOf = (w) => [...w.document.querySelectorAll('#horizonMarks .zman')]
  .map((n) => ({
    name: n.querySelector('b').textContent.trim(),
    time: n.querySelector('s').textContent.trim(),
    left: parseFloat(n.style.left),
    cls: n.className.trim(),
  }));
{
  const { w } = await boot('2026-09-23T14:00:00-04:00', { settings: { showHorizon: true } });
  const z = zmOf(w);
  ok(z.length === 5, `five zmanim are marked (${z.length})`, JSON.stringify(z.map((m) => m.name)));
  ok(z.map((m) => m.name).join(',') === 'Alos,Netz,Chatzos,Shkiya,Tzeis',
    'they are alos, netz, chatzos, shkiya, tzeis', JSON.stringify(z.map((m) => m.name)));
  ok(z.every((m) => /^\d{1,2}:\d{2}(am|pm)$/.test(m.time)),
    'every mark carries a real time', JSON.stringify(z.map((m) => m.time)));
  // The old strip could put two marks on the same pixel. A fixed set in
  // ascending order cannot.
  const lefts = z.map((m) => m.left);
  ok(lefts.every((v, i) => i === 0 || v > lefts[i - 1]),
    'marks are strictly ascending across the bar', JSON.stringify(lefts));
  ok(lefts[0] === 0 && lefts[4] === 100, 'alos anchors 0% and tzeis 100%',
    `${lefts[0]} / ${lefts[4]}`);
  // Netz hugs alos and shkiya hugs tzeis, which is why the sun's own two
  // moments are set above the line and the boundaries below it. On one row the
  // labels overlapped — "Tomorrow · Alos" ran into Netz.
  ok(lefts[1] - lefts[0] < 14, `netz is within 14% of alos (${(lefts[1] - lefts[0]).toFixed(1)}%)`);
  ok(lefts[4] - lefts[3] < 10, `shkiya is within 10% of tzeis (${(lefts[4] - lefts[3]).toFixed(1)}%)`);
  ok(z[1].cls.includes('up') && z[3].cls.includes('up'),
    'so netz and shkiya are set above the line');
  ok(!z[0].cls.includes('up') && !z[2].cls.includes('up') && !z[4].cls.includes('up'),
    'and alos, chatzos and tzeis stay below it');
  // Each row must be widely spread, which is what makes a collision impossible.
  const above = z.filter((m) => m.cls.includes('up')).map((m) => m.left);
  const below = z.filter((m) => !m.cls.includes('up')).map((m) => m.left);
  ok(Math.min(...above.slice(1).map((v, i) => v - above[i])) > 40,
    `marks above the line are far apart (${above.map((v) => v.toFixed(0)).join(', ')}%)`);
  ok(Math.min(...below.slice(1).map((v, i) => v - below[i])) > 40,
    `marks below the line are far apart (${below.map((v) => v.toFixed(0)).join(', ')}%)`);
  // Edge labels must anchor, not centre, or half of them hangs off the screen.
  ok(z[0].cls.includes('first') && z[4].cls.includes('last'),
    'the two ends are edge-anchored rather than centred');
  ok(!$(w, 'sun').hidden, 'midday shows the sun');
  const fill = parseFloat($(w, 'horizonElapsed').style.width);
  ok(fill > 0 && fill < 100, `the elapsed bar is partway across (${fill.toFixed(1)}%)`);
}
{
  const { w } = await boot('2026-09-23T21:00:00-04:00', { settings: { showHorizon: true } });
  const z = zmOf(w);
  ok(z[0].name.startsWith('Tomorrow'), 'past nightfall the strip moves to tomorrow',
    JSON.stringify(z[0].name));
  ok($(w, 'sun').hidden, 'and drops the sun, since that day has not started');
  ok($(w, 'horizonElapsed').style.width === '0%', 'and empties the bar');
}
{
  // The strip must no longer carry minyan times at all: that is what collided,
  // clipped, and disagreed with the cards.
  const { w } = await boot('2026-09-23T14:00:00-04:00',
    { settings: { shuls: ['beth-aaron', 'ohr-saadya'], showHorizon: true } });
  ok(w.document.querySelectorAll('#horizonMarks .tick').length === 0,
    'no minyan ticks remain on the horizon');
  const names = zmOf(w).map((m) => m.name);
  ok(names.every((n) => /Alos|Netz|Chatzos|Shkiya|Tzeis/.test(n)),
    'every mark is a zman', JSON.stringify(names));
}
{
  // Turning it off and on again must not leave a stale strip behind.
  const { w } = await boot('2026-09-23T14:00:00-04:00', { settings: { showHorizon: false } });
  ok(w.document.querySelector('.horizon').hidden, 'hidden when the setting is off');
  const box = $(w, 'showHorizon');          // through the real control, not internals
  box.checked = true;
  box.dispatchEvent(new w.Event('change', { bubbles: true }));
  ok(!w.document.querySelector('.horizon').hidden, 'and comes back when switched on');
  ok(zmOf(w).length === 5, 'with its marks intact', String(zmOf(w).length));
}

{
  // Out of the box the strip is off: the board is the clock and the cards.
  const { w } = await boot('2026-09-23T14:00:00-04:00', { settings: { shuls: ['beth-aaron'] } });
  ok(w.document.querySelector('.horizon').hidden, 'the horizon is off by default');
  ok(zmOf(w).length === 0, 'and draws nothing', String(zmOf(w).length));
}

/* G1 — Mincha and Maariv must not collapse into one unlabelled row ------- */
console.log('\n=== G1: every time row carries a label ===');
{
  const { w } = await boot('2026-09-22T14:05:00-04:00');
  const labels = [...w.document.querySelectorAll('.card .label')].map((n) => n.textContent.trim());
  ok(labels.length > 0, `labels present (${labels.length})`);
  ok(labels.every((l) => l.length > 0), 'no label is blank', JSON.stringify(labels));
  // Structure: label and times must be siblings inside .body, not nested in .minyan-row
  ok(w.document.querySelectorAll('.minyan-row').length === 0, '.minyan-row is gone');
  ok(w.document.querySelectorAll('.card .body').length > 0, '.card .body grid wrapper exists');
  const orphan = [...w.document.querySelectorAll('.card .label')]
    .filter((n) => !n.parentElement.classList.contains('body'));
  ok(orphan.length === 0, 'every .label is a direct child of .body (so the grid applies)');
}

/* G1b — a card must read in the order things actually happen ------------ */
console.log('\n=== G1b: the board stays chronological across repeated labels ===');
{
  // Beth Aaron lists "Night Selichos" at both 5:00 AM and 9:45 PM on 2026-09-17.
  // This one is pinned to that date because it needs that exact shape, so it
  // cannot be shifted by a week with the rest when the data window rolls.
  // Grouping every row that shares a label merged them and placed the row by the
  // earlier one, printing the last minyan of the day above times sixteen hours
  // earlier. Runs of consecutive times keep the card in real order.
  // Booted the evening BEFORE, so the whole of 2026-09-17 is still ahead; this
  // date needs no data of its own, only 09-17 does.
  const { w } = await boot('2026-09-16T21:46:00-04:00', { settings: { shuls: ['beth-aaron'] } });
  const mins = [...w.document.querySelectorAll('.card .time')].map((n) => {
    const m = /^(\d{1,2}):(\d{2})(am|pm)$/.exec(n.textContent.trim());
    let h = Number(m[1]) % 12;
    if (m[3] === 'pm') h += 12;
    return h * 60 + Number(m[2]);
  });
  ok(mins.length > 4, `card has times to order (${mins.length})`);
  const ascending = mins.every((v, i) => i === 0 || v > mins[i - 1]);
  ok(ascending, 'every time on the card is later than the one above it',
    JSON.stringify(mins));

  // The repeated label must appear twice, once at each end of the day, rather
  // than being folded into a single row spanning both.
  const labels = [...w.document.querySelectorAll('.card .label')].map((n) => n.textContent.trim());
  ok(labels.filter((l) => l === 'Night Selichos').length === 2,
    'a label used twice in a day gets a row at each end', JSON.stringify(labels));
  const wide = [...w.document.querySelectorAll('.card .times')]
    .map((n) => [...n.querySelectorAll('.time')].length);
  ok(wide.every((n) => n <= 4), 'no run is unreasonably long', JSON.stringify(wide));
}

/* B2 — the seconds dial ------------------------------------------------- */
console.log('\n=== B2: the seconds dial ===');
{
  const { w, advance } = await boot('2026-09-22T14:05:00-04:00', { settings: { seconds: true } });
  const hand = $(w, 'dialHand');
  // The attribute, not the property: hidden is HTMLElement-only and the dial is
  // an <svg>, so .hidden silently does nothing in a browser while jsdom happily
  // reports it back. Only hasAttribute tells the truth here.
  ok(!$(w, 'dial').hasAttribute('hidden'), 'dial is shown when "Show seconds" is on');
  const a = hand.style.transform;
  advance(1000); w.eval('tick()');
  const b = hand.style.transform;
  ok(a !== b, `the hand steps once a second (${a} -> ${b})`);
  ok(/rotate\(\d+deg\)/.test(b), 'the hand uses a rotate transform');
  // The clock element must keep its numerals in a stable node (no innerHTML churn)
  const timeNode = $(w, 'clockTime');
  advance(1000); w.eval('tick()');
  ok($(w, 'clockTime') === timeNode, 'the numerals node is updated in place, not recreated');
}
{
  const { w } = await boot('2026-09-22T14:05:00-04:00', { settings: { seconds: false } });
  ok($(w, 'dial').hasAttribute('hidden'), 'dial is hidden when "Show seconds" is off');
}
{
  // The hand must pivot on the dial centre, not on itself. Under fill-box the
  // bounding box of a vertical line is a zero-width sliver and 50% 50% lands on
  // the middle of the hand — which is what made 0s look identical to 30s.
  // jsdom implements neither property in getComputedStyle, so assert on the
  // rule itself; the visual check was done in a real browser.
  // Comments stripped first: the rule's own comment explains the fill-box bug
  // by name, which would otherwise trip the assertion below.
  const sheet = file('styles.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = /\.dial-hand\s*\{[^}]*\}/.exec(sheet)[0];
  ok(/transform-box:\s*view-box/.test(rule), 'hand uses transform-box: view-box');
  ok(!/fill-box/.test(rule), 'hand does NOT use fill-box (the off-centre pivot bug)');
  ok(/transform-origin:\s*50px\s+50px/.test(rule), 'hand pivots on 50px 50px, the dial centre');
  ok(/transition:\s*transform/.test(rule), 'hand has a detent transition');
}
{
  // 59s -> 0s must step forward by 6deg, not unwind 354deg backwards, or the
  // detent transition animates a full reverse revolution once a minute.
  const { w, advance } = await boot('2026-09-22T14:05:57-04:00', { settings: { seconds: true } });
  const deg = () => Number(/rotate\(([-\d.]+)deg\)/.exec($(w, 'dialHand').style.transform)[1]);
  const seen = [deg()];
  for (let i = 0; i < 6; i += 1) { advance(1000); w.eval('tick()'); seen.push(deg()); }
  const steps = seen.slice(1).map((v, i) => v - seen[i]);
  ok(steps.every((d) => d === 6), `every step is +6deg across the 59->0 wrap (${steps.join(',')})`);
  ok(seen.every((v, i) => i === 0 || v > seen[i - 1]), 'the angle never decreases');
}
{
  // The dial must not sweep on first paint, but must animate from then on.
  const { w, advance } = await boot('2026-09-22T14:05:40-04:00', { settings: { seconds: true } });
  ok($(w, 'dialHand').style.transition === 'none', 'first paint places the hand without a sweep');
  advance(1000); w.eval('tick()');
  ok($(w, 'dialHand').style.transition === '', 'subsequent steps use the CSS detent');
}

/* G4 — perShul is a real cap -------------------------------------------- */
console.log('\n=== G4: "Times shown per shul" actually caps ===');
{
  for (const cap of ['4', '8', '12']) {
    const { w } = await boot('2026-09-22T05:00:00-04:00',
      { settings: { shuls: ['bnai-yeshurun'], perShul: cap } });
    const times = w.document.querySelectorAll('.card .time').length;
    ok(times > 0 && times <= Number(cap),
      `perShul=${cap} yields ${times} times (<= ${cap})`);
  }
  // A stored value from the old option set must fall back, not blank the card.
  // The default is Auto now, and Auto with no geometry to measure — which is
  // every run in jsdom — takes its own ceiling rather than guessing.
  const { w } = await boot('2026-09-22T05:00:00-04:00',
    { settings: { shuls: ['bnai-yeshurun'], perShul: '3' } });
  const times = w.document.querySelectorAll('.card .time').length;
  ok(times > 0 && times <= 14,
    `a stale perShul="3" falls back to Auto, not NaN (${times} times)`);
  ok(w.document.getElementById('perShul').value === 'auto',
    'and the settings sheet shows Auto rather than a blank select');
}

/* G6 / E5 — the edge element and the line count -------------------------- */
console.log('\n=== G6/E5: empty edge is hidden; every card counts lines ===');
{
  const { w } = await boot('2026-09-01T17:00:00-04:00');   // ordinary Tuesday
  ok($(w, 'edge').hidden, 'edge is hidden on a day with no transition to announce');
}
{
  const { w } = await boot('2026-09-18T14:05:00-04:00');   // a Friday
  const edge = $(w, 'edge');
  // Both ends. When Shabbos comes in is half the question; when it goes out is
  // the other half, and the wall is the only place either gets read.
  ok(!edge.hidden && /Candles/.test(edge.textContent) && /Havdalah/.test(edge.textContent),
    'erev Shabbos announces both candles and havdalah',
    `(hidden=${edge.hidden} "${edge.textContent}")`);
  ok(edge.querySelectorAll('.line').length >= 2,
    'the ends are stacked, not joined by a separator that wraps');
  // Beth Aaron makes havdalah 9 minutes after its 7:42 maariv, Ohr Saadya 8
  // after its 7:40. Both are minutes later than the computed tzeis of 7:38, and
  // they differ from each other, so each has to be named.
  ok(/Beth Aaron 7:51p/.test(edge.textContent) && /Ohr Saadya 7:48p/.test(edge.textContent),
    'each shul gets its own havdalah, off its own maariv', `("${edge.textContent}")`);
}
{
  // Ohr Saadya publishes "Fast Ends 7:45pm" on its own site for Yom Kippur.
  // The maariv+8 arithmetic cannot reach that — and worse, Neila sits in the
  // evening bucket, so measuring off it produced 6:43p, an hour early.
  const { w } = await boot('2026-09-20T15:30:00-04:00',
    { settings: { shuls: ['ohr-saadya'] } });
  const edge = $(w, 'edge');
  ok(/7:45p/.test(edge.textContent) && !/6:43p/.test(edge.textContent),
    "a shul's own published fast-end time beats the maariv arithmetic",
    `("${edge.textContent}")`);
}
{
  // A shul with no published practice must not be handed one. On its own the
  // tile falls back to tzeis, unlabelled, because that is the town-wide answer.
  const { w } = await boot('2026-09-18T14:05:00-04:00',
    { settings: { shuls: ['bnai-yeshurun'] } });
  const edge = $(w, 'edge');
  ok(/Havdalah 7:38p/.test(edge.textContent) && !/Bnai/.test(edge.textContent),
    'a shul with no offset falls back to tzeis, unnamed', `("${edge.textContent}")`);
}
{
  // Mixed: naming only the shuls that have a practice, never inventing one for
  // the third. An unlabelled time here would read as speaking for all three.
  const { w } = await boot('2026-09-18T14:05:00-04:00',
    { settings: { shuls: ['beth-aaron', 'ohr-saadya', 'bnai-yeshurun'] } });
  const edge = $(w, 'edge');
  ok(/Beth Aaron 7:51p/.test(edge.textContent) && !/Bnai/.test(edge.textContent),
    'a shul without an offset is omitted, not given the others\' time',
    `("${edge.textContent}")`);
}
{
  // Every shul unavailable: the clock must not inflate to its sparse multiplier.
  const { w } = await boot('2030-01-01T14:00:00-05:00',
    { settings: { shuls: ['beth-aaron', 'ohr-saadya'] } });
  const unavailable = w.document.querySelectorAll('.unavailable').length;
  const fill = w.document.documentElement.style.getPropertyValue('--clock-fill');
  ok(unavailable === 2, 'both shuls report unavailable for a date with no data');
  ok(fill === '1.5', `one line per card still counts (--clock-fill ${fill})`);
}

/* W — the weather strip ---------------------------------------------------
   Built from a synthetic forecast so the assertions are about the window the
   code chooses, not about the sky over Teaneck on the day this is run. */
function forecastFrom(startIso, hours = 96) {
  const base = new Date(startIso);
  base.setMinutes(0, 0, 0);
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + `T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const hourly = {
    time: [], temperature_2m: [], apparent_temperature: [],
    precipitation_probability: [], weather_code: [], is_day: [],
  };
  const daily = { time: [], temperature_2m_max: [], temperature_2m_min: [] };
  for (let i = 0; i < hours; i += 1) {
    const at = new Date(base.getTime() + i * 3600000);
    hourly.time.push(stamp(at));
    hourly.temperature_2m.push(60 + (i % 12));
    hourly.apparent_temperature.push(58 + (i % 12));
    hourly.precipitation_probability.push([0, 40, 5, 10, 60, 8][i % 6]);
    hourly.weather_code.push([0, 2, 3, 61, 71, 95][i % 6]);
    hourly.is_day.push(at.getHours() >= 7 && at.getHours() < 19 ? 1 : 0);
    const day = stamp(at).slice(0, 10);
    if (!daily.time.includes(day)) {
      daily.time.push(day);
      daily.temperature_2m_max.push(72);
      daily.temperature_2m_min.push(48);
    }
  }
  return {
    hourly, daily,
    current: { temperature_2m: 61, apparent_temperature: 55, weather_code: 3, is_day: 1 },
    // Stamped fresh, because that is what almost every test here wants. The
    // ones about staleness override it, and one deletes it to stand in for a
    // cache written before the field existed.
    observed_at: base.getTime(),
  };
}

console.log('\n=== W1: the strip covers the rest period, and says which one ===');
{
  // Friday afternoon in November: Shabbos is not in yet, but it is what the
  // strip is for. A plain Shabbos deliberately — Succos weeks are W2's job.
  const when = '2026-11-06T14:05:00-05:00';
  const { w } = await boot(when, { forecast: forecastFrom(when) });
  const el = $(w, 'weather');
  ok(!el.hidden, 'the strip is shown');
  const cols = el.querySelectorAll('.wcol').length;
  ok(cols === 12, `twelve hourly columns (got ${cols})`);
  const head = el.querySelector('.whead')?.textContent ?? '';
  ok(/Shabbos/.test(head), `the heading names the rest period ("${head}")`);
  ok(/through \d/.test(head), 'the heading says when it ends');
  ok(el.querySelectorAll('.wicon').length === cols + 1,
    'one sky glyph per column, plus the one for now');
  ok(el.querySelector('.wcol.now .whour')?.textContent === 'Now',
    'the first column is labelled Now');
  // The pattern cycles 0, 40, 5, 10, 60, 8 — so half of twelve columns carry a
  // real chance and half are the model's noise.
  const pops = [...el.querySelectorAll('.wpop')].map((n) => n.textContent);
  ok(pops.length === 6, `six of twelve print a chance (${pops.join(' ')})`);
  ok(pops.includes('10%'), 'a 10% hour is shown, not swallowed by the threshold');
  ok(!pops.includes('8%') && !pops.includes('5%') && !pops.includes('0%'),
    'and single-figure noise is not');
}

console.log('\n=== W2: a three-day Yom Tov is no different from a Shabbos ===');
{
  // Thursday of Succos 2026: Yom Tov runs into Shabbos, so the period is long.
  const when = '2026-10-02T13:00:00-04:00';
  const { w } = await boot(when, { forecast: forecastFrom(when) });
  const el = $(w, 'weather');
  const head = el.querySelector('.whead')?.textContent ?? '';
  ok(!el.hidden && el.querySelectorAll('.wcol').length === 12,
    `still twelve rolling columns ("${head}")`);
  ok(!/Shabbos/.test(head) && head.length > 6,
    `named for the Yom Tov, not for Shabbos ("${head}")`);
}

console.log('\n=== W3: the window never runs past havdalah ===');
{
  // Shabbos morning in November: tzeis is about six hours off, so twelve
  // columns would spill into Sunday under a heading that promises Shabbos.
  const when = '2026-11-07T11:00:00-05:00';
  const { w } = await boot(when, { forecast: forecastFrom(when) });
  const el = $(w, 'weather');
  const cols = [...el.querySelectorAll('.whour')].map((n) => n.textContent);
  ok(cols.length > 0 && cols.length < 12,
    `clipped to what is left of Shabbos (${cols.length}: ${cols.join(' ')})`);
  ok(/Shabbos/.test(el.querySelector('.whead')?.textContent ?? ''), 'still captioned Shabbos');
}

console.log('\n=== W3b: but a period nearly over gets hours, not a stub ===');
{
  // An hour before tzeis. Clipping honestly would leave two columns under a
  // heading promising a Shabbos, which tells nobody anything.
  const when = '2026-11-07T16:20:00-05:00';
  const { w } = await boot(when, { forecast: forecastFrom(when) });
  const cols = $(w, 'weather').querySelectorAll('.wcol').length;
  const head = $(w, 'weather').querySelector('.whead')?.textContent ?? '';
  ok(cols === 12, `falls back to the full rolling window (${cols} columns)`);
  ok(/Next 12 hours/.test(head),
    `and drops the claim it can no longer support ("${head}")`);
}

console.log('\n=== W4: an ordinary weekday, no forecast, and the units toggle ===');
{
  const when = '2026-09-22T14:05:00-04:00';
  const { w } = await boot(when, { forecast: forecastFrom(when) });
  const el = $(w, 'weather');
  ok(/Next 12 hours/.test(el.querySelector('.whead')?.textContent ?? ''),
    'a Tuesday gets a plain heading, not an invented Shabbos');

  const f = el.querySelector('.wbig').textContent;
  const sel = $(w, 'units');
  sel.value = 'C';
  sel.dispatchEvent(new w.Event('change'));
  const c = $(w, 'weather').querySelector('.wbig').textContent;
  ok(f === '61°' && c === '16°', `61F redraws as 16C (${f} -> ${c})`);
}
{
  const when = '2026-09-25T14:05:00-04:00';
  const { w, errors } = await boot(when);            // no forecast seeded at all
  ok($(w, 'weather').hidden, 'no forecast hides the strip rather than showing an empty one');
  ok($(w, 'shuls').querySelector('.card') !== null, 'the board still renders without it');
  ok(errors.length === 0, `and throws nothing (${errors.join('; ')})`);
}

console.log('\n=== W5: the strip is off in clock-only, and off when switched off ===');
{
  const when = '2026-09-25T14:05:00-04:00';
  const { w } = await boot(when,
    { settings: { showWeather: false }, forecast: forecastFrom(when) });
  ok($(w, 'weather').hidden, 'the setting hides it');
  const box = $(w, 'showWeather');
  box.checked = true;
  box.dispatchEvent(new w.Event('change'));
  ok(!$(w, 'weather').hidden, 'and brings it back without a reload');
}

console.log('\n=== W6: both dates now live in one tile ===');
{
  const when = '2026-09-25T14:05:00-04:00';
  const { w } = await boot(when);
  const tiles = w.document.querySelectorAll('.topline .datebox');
  ok(tiles.length === 1, `one dated tile, not two (got ${tiles.length})`);
  const tile = tiles[0];
  for (const id of ['civilDate', 'hebrewDate', 'occasion', 'edge', 'zmanimList']) {
    ok(tile.contains($(w, id)), `${id} sits inside it`);
  }
  ok($(w, 'civilDate').textContent.length > 0 && $(w, 'hebrewDate').textContent.length > 0,
    'and both dates are actually filled in');
  ok(w.document.querySelector('.clockwrap')?.contains($(w, 'clock')) === true,
    'the clock sits in its own size container');
}

/* R — findings from review ------------------------------------------------ */

console.log('\n=== R1: the wake lock is taken again on the way back to visible ===');
{
  const { wake, setVisible } = await boot('2026-09-22T14:05:00-04:00');
  const first = wake.grants;
  ok(first >= 1, `the lock is taken at start (${first})`);
  // The real sequence. The visible -> hidden edge used to consume a
  // { once: true } listener that did nothing, so nothing was left to hear the
  // return and the screen was free to sleep for good.
  setVisible('hidden');
  await new Promise((r) => setTimeout(r, 20));
  ok(wake.grants === first, 'going hidden does not request a lock');
  setVisible('visible');
  await new Promise((r) => setTimeout(r, 20));
  ok(wake.grants > first, `coming back does (${first} -> ${wake.grants})`);
  // And again, because a wall display does this every day for months.
  setVisible('hidden'); setVisible('visible');
  await new Promise((r) => setTimeout(r, 20));
  ok(wake.grants > first + 1, `and again on the next cycle (${wake.grants})`);
}

console.log('\n=== R2: an old forecast says so instead of passing as current ===');
{
  const when = '2026-09-22T14:05:00-04:00';
  const fresh = forecastFrom(when);

  const now = await boot(when, { forecast: { ...fresh, observed_at: new Date(when).getTime() } });
  ok(!/old|age unknown/.test($(now.w, 'freshness').textContent),
    `a forecast just fetched is not labelled ("${$(now.w, 'freshness').textContent}")`);

  const old = await boot(when, {
    forecast: { ...fresh, observed_at: new Date(when).getTime() - 3 * 3600 * 1000 },
  });
  const line = $(old.w, 'freshness').textContent;
  ok(/3h old/.test(line), `three hours on shows its age ("${line}")`);

  // A cache written before the field existed. Unknown is not fresh.
  const unstamped = { ...fresh };
  delete unstamped.observed_at;
  const legacy = await boot(when, { forecast: unstamped });
  ok(/age unknown/.test($(legacy.w, 'freshness').textContent),
    `a cache with no stamp reads as unknown ("${$(legacy.w, 'freshness').textContent}")`);
}

console.log('\n=== R3: past six hours the "now" block stops being an observation ===');
{
  const when = '2026-09-22T14:05:00-04:00';
  const fresh = forecastFrom(when);
  // An observation that disagrees with the hourly row, so it is obvious which
  // one the block is reading.
  fresh.current = { temperature_2m: 99, apparent_temperature: 99, weather_code: 0, is_day: 1 };

  const live = await boot(when, { forecast: { ...fresh, observed_at: new Date(when).getTime() } });
  ok($(live.w, 'weather').querySelector('.wbig').textContent === '99°',
    'a fresh observation is used as-is');

  const dead = await boot(when, {
    forecast: { ...fresh, observed_at: new Date(when).getTime() - 8 * 3600 * 1000 },
  });
  const shown = $(dead.w, 'weather').querySelector('.wbig').textContent;
  ok(shown !== '99°', `an eight-hour-old observation is dropped (shows ${shown})`);
  ok(shown === `${dead.w.document.querySelector('.wcol.now .wtemp').textContent}`,
    'and the current hour of the forecast is read instead');
}

/* Y — multi-day Yom Tov ---------------------------------------------------
   Pesach 2027: Yom Tov Thursday 22nd and Friday 23rd, running into Shabbos on
   the 24th. The real three-day case, and the one the board used to truncate. */
function schedule(dates, slug = 'beth-aaron', stamp = '2027-04-21T06:00:00Z') {
  const days = {};
  for (const iso of dates) {
    days[iso] = { [slug]: {
      source: 'shul', fetched_at: stamp,
      shacharis: [{ label: 'Shacharis', time: '7:00 AM' }, { label: 'Shacharis', time: '8:30 AM' }],
      mincha: [{ label: 'Mincha', time: '1:30 PM' }, { label: 'Mincha', time: '7:00 PM' }],
      maariv: [{ label: 'Maariv', time: '8:45 PM' }],
    } };
  }
  return { generated_at: new Date().toISOString(), days };
}
const PESACH = ['2027-04-21', '2027-04-22', '2027-04-23', '2027-04-24', '2027-04-25'];
const groupsOn = (w) => [...w.document.querySelectorAll('.card .body .group')]
  .map((el) => el.textContent);

console.log('\n=== Y1: erev Yom Tov reaches every day of a three-day chag ===');
{
  const { w } = await boot('2027-04-21T15:00:00-04:00',
    { minyanim: schedule(PESACH), settings: { shuls: ['beth-aaron'] } });
  const groups = groupsOn(w);
  ok(groups.length === 4, `four day headings (${groups.join(' / ')})`);
  ok(groups[0] === 'Today' && groups[1] === 'Tomorrow',
    'the first two are Today and Tomorrow');
  ok(/Friday/.test(groups[2]) && /Saturday/.test(groups[3]),
    'and the rest are named by weekday, not "in two days"');
}

console.log('\n=== Y2: an ordinary week is unchanged ===');
{
  const { w } = await boot('2027-04-13T15:00:00-04:00',
    { minyanim: schedule(['2027-04-13', '2027-04-14', '2027-04-15', '2027-04-16']),
      settings: { shuls: ['beth-aaron'] } });
  const groups = groupsOn(w);
  ok(groups.length <= 2, `a Tuesday still stops at tomorrow (${groups.join(' / ')})`);
  ok(!groups.some((g) => /day$/.test(g) && g !== 'Today'),
    'no weekday headings appear when no rest period is near');
}

console.log('\n=== Y3: the cap still wins, and every day still gets a share ===');
{
  for (const cap of ['4', '8', '12']) {
    const { w } = await boot('2027-04-21T15:00:00-04:00',
      { minyanim: schedule(PESACH), settings: { shuls: ['beth-aaron'], perShul: cap } });
    const times = w.document.querySelectorAll('.card .body .time').length;
    const groups = groupsOn(w).length;
    ok(times <= Number(cap), `perShul=${cap} yields ${times} times (<= ${cap})`);
    ok(groups >= 2, `and still spans ${groups} days rather than spending it all on today`);
  }
}

console.log('\n=== F: freshness describes the oldest shul on screen ===');
{
  const old = '2027-04-20T06:00:00Z';     // a day and a half before "now"
  const data = schedule(PESACH);
  // A second shul whose entry was retained from a previous run, exactly the case
  // generated_at used to paper over.
  for (const iso of PESACH) {
    data.days[iso]['ohr-saadya'] = { ...data.days[iso]['beth-aaron'], fetched_at: old };
  }
  const both = await boot('2027-04-21T15:00:00-04:00',
    { minyanim: data, settings: { shuls: ['beth-aaron', 'ohr-saadya'] } });
  const line = $(both.w, 'freshness').textContent;
  ok(/last confirmed/.test(line), `a retained shul is reported, not hidden ("${line}")`);

  const fresh = await boot('2027-04-21T15:00:00-04:00',
    { minyanim: schedule(PESACH), settings: { shuls: ['beth-aaron'] } });
  ok(!/last confirmed/.test($(fresh.w, 'freshness').textContent),
    `and a board where everything is current says so ("${$(fresh.w, 'freshness').textContent}")`);
}

/* S — the second review round -------------------------------------------- */

console.log('\n=== S1: a replayed cached forecast cannot pass as freshly fetched ===');
{
  // The service worker hands back cached responses by design, and a cached
  // response is res.ok like any other. Stamping on arrival therefore re-dated
  // every replay as current — so the age has to come off the payload.
  const when = '2026-09-22T14:05:00-04:00';
  const stale = forecastFrom(when);
  delete stale.observed_at;
  // What the worker would replay: a body observed five hours ago, handed over
  // now, indistinguishable from a live fetch at the response level.
  stale.current = { ...stale.current, time: '2026-09-22T09:00' };

  const { w } = await boot(when, { forecast: null });
  w.eval(`(async () => {
    window.fetch = async (u) => String(u).includes('open-meteo')
      ? { ok: true, json: async () => (${JSON.stringify(stale)}) }
      : { ok: false };
    await refreshWeather();
  })()`);
  await new Promise((r) => setTimeout(r, 60));
  const line = $(w, 'freshness').textContent;
  ok(/5h old/.test(line), `the five-hour-old observation is reported ("${line}")`);
}

console.log('\n=== S2: the age is read from current.time, not the clock ===');
{
  const when = '2026-09-22T14:05:00-04:00';
  const live = forecastFrom(when);
  delete live.observed_at;
  live.current = { ...live.current, time: '2026-09-22T14:00' };
  const { w } = await boot(when, { forecast: null });
  w.eval(`(async () => {
    window.fetch = async (u) => String(u).includes('open-meteo')
      ? { ok: true, json: async () => (${JSON.stringify(live)}) }
      : { ok: false };
    await refreshWeather();
  })()`);
  await new Promise((r) => setTimeout(r, 60));
  ok(!/old|age unknown/.test($(w, 'freshness').textContent),
    `an observation from this hour is not labelled ("${$(w, 'freshness').textContent}")`);
}

console.log('\n=== S3: freshness covers every day on the board, not only today ===');
{
  // Today confirmed minutes ago; the last day of the chag retained from a run
  // a day and a half back. The footer has to describe the worst of them.
  const data = schedule(PESACH, 'beth-aaron', '2027-04-21T18:00:00Z');
  data.days['2027-04-24']['beth-aaron'].fetched_at = '2027-04-20T06:00:00Z';
  const { w } = await boot('2027-04-21T15:00:00-04:00',
    { minyanim: data, settings: { shuls: ['beth-aaron'] } });
  const groups = [...w.document.querySelectorAll('.card .body .group')].length;
  ok(groups === 4, `the board is showing all four days (${groups})`);
  ok(/last confirmed/.test($(w, 'freshness').textContent),
    `a stale Saturday two columns away is reported ("${$(w, 'freshness').textContent}")`);
}

console.log('\n=== S4: the worker keeps one entry per path, and it is the newest ===');
{
  // No jsdom here — sw.js runs in a worker scope, so it gets a fake one. The
  // point is the cache-busting query app.js appends: it used to mint a new key
  // on every fetch, so nothing was replaced and the ignoreSearch lookup
  // returned the FIRST match, which is the oldest copy ever stored.
  // Modelled on the real Cache API, because the bug lives in its exact
  // semantics: put() keys by the request's URL (query included), and match()
  // with ignoreSearch returns the FIRST entry in insertion order whose path
  // matches — the oldest, not the newest.
  const entries = new Map();
  const keyOf = (k) => (typeof k === 'string' ? k : k.url);
  const bareOf = (u) => u.split('?')[0];
  const find = (k, opts) => {
    const want = keyOf(k);
    if (!opts?.ignoreSearch) return entries.get(want);
    for (const [have, v] of entries) if (bareOf(have) === bareOf(want)) return v;
    return undefined;
  };
  const cacheApi = {
    open: async () => ({
      put: async (k, v) => { entries.set(keyOf(k), v); },
      match: async (k, o) => find(k, o),
    }),
    keys: async () => ['shabbos-clock-v9'],
    delete: async () => true,
    match: async (k, o) => find(k, o),
  };
  const handlers = {};
  const scope = {
    self: {
      addEventListener: (t, f) => { handlers[t] = f; },
      skipWaiting: async () => {}, clients: { claim: async () => {} },
    },
    caches: cacheApi,
    URL, Promise, setTimeout, console,
    Response: { error: () => ({ ok: false, body: 'ERR' }) },
  };
  let served = null;
  scope.fetch = async () => served;

  const src = readFileSync(new URL('sw.js', ROOT), 'utf8');
  // eslint-disable-next-line no-new-func
  new Function(...Object.keys(scope), src)(...Object.values(scope));
  ok(typeof handlers.fetch === 'function', 'the worker registered a fetch handler');

  const run = async (url) => {
    let out;
    const e = {
      request: { url, method: 'GET', mode: 'no-cors' },
      waitUntil: () => {},
      respondWith: (p) => { out = p; },
    };
    handlers.fetch(e);
    return out;
  };

  const base = 'https://x.test/shabbos/data/minyanim.json';
  served = { ok: true, body: 'OLD', clone: () => ({ ok: true, body: 'OLD' }) };
  await run(`${base}?t=1`);
  await new Promise((r) => setTimeout(r, 10));
  served = { ok: true, body: 'NEW', clone: () => ({ ok: true, body: 'NEW' }) };
  await run(`${base}?t=2`);
  await new Promise((r) => setTimeout(r, 10));

  ok(entries.size === 1, `two cache-busted fetches leave one entry, not two (${entries.size})`);
  ok([...entries.keys()][0] === base, `stored under the bare path ("${[...entries.keys()][0]}")`);
  ok(entries.get(base)?.body === 'NEW',
    `and it is the newest copy, not the first (${entries.get(base)?.body ?? 'nothing under that key'})`);

  // Offline, with a third cache-busting query it has never seen before.
  served = null;
  scope.fetch = async () => { throw new Error('offline'); };
  const res = await run(`${base}?t=3`);
  ok(res ? (await res)?.body === 'NEW' : false,
    'an unseen query still finds the cached copy when the network is gone');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
