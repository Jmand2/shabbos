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

const APP_FILES = [
  'util.js', 'calendar.js', 'settings.js', 'minyanim.js', 'weather.js', 'sports.js', 'display.js', 'app.js',
];
import { readFileSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url);
const file = (name) => readFileSync(new URL(name, ROOT), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, msg, extra = '') => {
  if (cond) { pass += 1; console.log('  PASS', msg); }
  else { fail += 1; console.log('  FAIL', msg, extra); }
};

// READING APP STATE FROM A TEST.
//
// Only function declarations escape the eval that loaded the app. `let` and
// `const` at the top level of an eval are scoped to it, so `w.eval('sports')`
// or `w.eval('sportsAt = ...')` does not touch the module's own binding — it
// throws, or silently creates a NEW global and leaves the real one alone. That
// has caught three tests here already, one of which passed for reasons
// unconnected to the app. Drive behaviour through a declared function
// (render, tick, sportsGames, sportsAges) rather than reaching for a variable.

// A clock that advances: each `new Date()` returns base + however far we've stepped.
async function boot(startIso, { settings = null, killMatchMedia = false, forecast = null, minyanim = null, scores = null } = {}) {
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
    if (String(u).includes('espn.com')) {
      // Recorded so a test can assert WHICH days are asked for. The band's whole
      // job is last night's result, and the app was only ever requesting today.
      w.__espn = w.__espn ?? [];
      w.__espn.push(String(u));
      const league = /sports\/([a-z]+\/[a-z]+)\//.exec(String(u))?.[1];
      if (!scores || !scores[league]) return { ok: true, json: async () => ({ events: [] }) };
      return { ok: true, json: async () => scores[league] };
    }
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
  // Evaluated as ONE program, which is what the browser effectively does.
  // Separate <script> tags share the global lexical scope, so a const in
  // calendar.js is visible to weather.js; separate eval() calls do not — each
  // gets its own scope and the second file cannot see the first's constants.
  // Concatenating is the faithful thing here, not seven evals.
  w.eval(APP_FILES.map(file).join('\n'));
  await new Promise((r) => setTimeout(r, 150));
  return { w, state, errors, wake, setVisible, advance: (ms) => { state.offset += ms; } };
}

const $ = (w, id) => w.document.getElementById(id);

// A label's own text, not its cell's. The next-minyan marker is a child of the
// label — it sits under the service name so that row's time still lines up with
// the column — so textContent reads "Night SelichosNext".
const labelText = (n) => [...n.childNodes]
  .filter((c) => c.nodeType === 3)
  .map((c) => c.textContent)
  .join('')
  .trim();

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
  // Re-queried each time, deliberately. The picker is rebuilt on every change
  // because ticking a shul moves it between "On the board" and "Not shown", so
  // the node just clicked is replaced — holding a reference across a change is
  // testing a detached element, not the app.
  const box = () => w.document.querySelector('#shulPicker input[value="beth-aaron"]');
  ok(!!box(), 'found the beth-aaron checkbox');
  ok($(w, 'shuls').innerHTML.includes('card'), 'board starts with a card');

  const toggle = (on) => {
    const el = box();
    el.checked = on;
    el.dispatchEvent(new w.Event('change', { bubbles: true }));
  };

  toggle(false);
  ok($(w, 'shuls').textContent.includes('No shuls chosen'), 'unchecking shows the empty state');
  ok(box()?.checked === false, 'and the rebuilt picker shows it unticked');

  toggle(true);
  const after = $(w, 'shuls').innerHTML;
  ok(after.includes('card') && !after.includes('No shuls chosen'),
    're-checking the same shul brings the board back',
    `(got: ${$(w, 'shuls').textContent.slice(0, 40)})`);
  ok(box()?.checked === true, 'and it is ticked again');
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
  const labels = [...w.document.querySelectorAll('.card .label')].map(labelText);
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
  const mins = [...w.document.querySelectorAll('.card .time:not(.edgetime)')].map((n) => {
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
  const labels = [...w.document.querySelectorAll('.card .label')].map(labelText);
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
    // :not(.edgetime) — the cap is a cap on MINYANIM. Candle lighting and
    // havdalah are rows in the same card but they are not something you daven,
    // and counting them would mean choosing "4 times" and getting three.
    const times = w.document.querySelectorAll('.card .time:not(.edgetime)').length;
    ok(times > 0 && times <= Number(cap),
      `perShul=${cap} yields ${times} minyan times (<= ${cap})`);
  }
  // A stored value from the old option set must fall back, not blank the card.
  // The default is Auto now, and Auto with no geometry to measure — which is
  // every run in jsdom — takes its own ceiling rather than guessing.
  const { w } = await boot('2026-09-22T05:00:00-04:00',
    { settings: { shuls: ['bnai-yeshurun'], perShul: '3' } });
  const times = w.document.querySelectorAll('.card .time:not(.edgetime)').length;
  // Auto's ceiling follows how many DAYS the board reaches — eight a day — so
  // this bound is no longer a single number. The assertion is that a stale
  // value falls back to a working Auto rather than to NaN or nothing.
  ok(times > 0 && times <= 8 * 4,
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
// Each shul's own card, by name. The point of moving these out of the tile is
// that the box says whose they are, so that is what the tests read.
const cardOf = (w, name) => [...w.document.querySelectorAll('.card')]
  .find((c) => c.querySelector('h2')?.textContent === name)?.textContent ?? '';

{
  const { w } = await boot('2026-09-18T14:05:00-04:00');   // a Friday
  // Both ends. When Shabbos comes in is half the question; when it goes out is
  // the other half, and the wall is the only place either gets read.
  const ba = cardOf(w, 'Beth Aaron');
  ok(/Candles/.test(ba) && /Havdalah/.test(ba),
    "erev Shabbos announces both ends in the shul's own card", `("${ba.slice(-90)}")`);
  ok($(w, 'edge').hidden,
    'and the tile beside the clock no longer carries them');
  // Beth Aaron makes havdalah 9 minutes after its 7:42 maariv, Ohr Saadya 8
  // after its 7:40. Both are minutes later than the computed tzeis of 7:38 and
  // they differ from each other — which is the whole reason these belong in
  // the boxes: no name has to be printed to say which is which.
  ok(/7:51p/.test(ba), "Beth Aaron's own havdalah, off its own maariv", `("${ba.slice(-60)}")`);
  const os = cardOf(w, 'Ohr Saadya');
  ok(/7:48p/.test(os) && !/7:51p/.test(os),
    "and Ohr Saadya's own, in its own box", `("${os.slice(-60)}")`);
}
{
  // Ohr Saadya publishes "Fast Ends 7:45pm" on its own site for Yom Kippur.
  // The maariv+8 arithmetic cannot reach that — and worse, Neila sits in the
  // evening bucket, so measuring off it produced 6:43p, an hour early.
  const { w } = await boot('2026-09-20T15:30:00-04:00',
    { settings: { shuls: ['ohr-saadya'] } });
  const os = cardOf(w, 'Ohr Saadya');
  ok(/7:45p/.test(os) && !/6:43p/.test(os),
    "a shul's own published fast-end time beats the maariv arithmetic",
    `("${os.slice(-70)}")`);
}
{
  // A shul with no published practice must not be handed one. Its own box
  // falls back to nightfall, NAMED as nightfall — the town-wide fact, not a
  // havdalah it never claimed.
  const { w } = await boot('2026-09-18T14:05:00-04:00',
    { settings: { shuls: ['bnai-yeshurun'] } });
  const by = cardOf(w, 'Bnai Yeshurun');
  ok(/Nightfall/.test(by) && /7:38p/.test(by) && !/Havdalah/.test(by),
    'a shul with no practice of its own shows nightfall, not a borrowed havdalah',
    `("${by.slice(-70)}")`);
}
{
  // Mixed: no shul is handed another's practice, which was the exact failure
  // an unlabelled time in the shared tile could produce.
  const { w } = await boot('2026-09-18T14:05:00-04:00',
    { settings: { shuls: ['beth-aaron', 'ohr-saadya', 'bnai-yeshurun'] } });
  ok(/7:51p/.test(cardOf(w, 'Beth Aaron')), 'Beth Aaron keeps its own');
  const by = cardOf(w, 'Bnai Yeshurun');
  ok(!/7:51p/.test(by) && !/7:48p/.test(by),
    "and the shul without one is not given the others'", `("${by.slice(-70)}")`);
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
  // The present belongs to the block on the left, once. The strip is entirely
  // about hours still to come.
  ok(!el.querySelector('.wcol.now'),
    'no column claims to be the present');
  ok(/^\d{1,2}(am|pm)$/.test(el.querySelector('.wcol .whour')?.textContent ?? ''),
    `the strip opens on a clock hour (${el.querySelector('.wcol .whour')?.textContent})`);
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
  // The current hour is no longer a COLUMN — the block owns the present and the
  // strip starts at the next hour — so this reads the forecast series directly
  // rather than a tile that used to duplicate it.
  const firstCol = dead.w.document.querySelector('.wcol .wtemp').textContent;
  ok(shown !== firstCol,
    `and the block is not simply the first forecast column (${shown} vs ${firstCol})`);
  ok(/^\d+°$/.test(shown), `it is read off the current hour instead (${shown})`);
}

console.log('\n=== R3b: the current hour is shown once, not twice ===');
{
  // The strip used to open with a column labelled "Now" beside a block saying
  // exactly the same thing: same icon, same temperature, a centimetre apart.
  const when = '2026-09-22T14:05:00-04:00';
  const { w } = await boot(when, { forecast: forecastFrom(when) });
  const hours = [...w.document.querySelectorAll('.whour')].map((n) => n.textContent);
  ok(!hours.includes('Now'), `no column claims the present (${hours.slice(0, 3).join(' ')})`);
  ok(w.document.querySelectorAll('.wbig').length === 1,
    'exactly one current-condition reading on the strip');
  // 2:05pm, so the forecast opens at 3pm.
  ok(hours[0] === '3pm', `the forecast opens at the next hour (${hours[0]})`);
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
  ok(groups[0] === 'Today' && groups[1].startsWith('Tomorrow'),
    `the first two are still Today and Tomorrow (${groups[0]} / ${groups[1]})`);
  ok(/Friday/.test(groups[2]),
    `the rest are named by weekday, not "in two days" (${groups[2]})`);
  // Saturday is Shabbos, because that is what it is called by everyone who will
  // read this.
  ok(/Shabbos/.test(groups[3]) && !/Saturday/.test(groups[3]),
    `and Saturday is Shabbos (${groups[3]})`);
  // The point of reaching three days is lost if all three say only "Pesach".
  ok(/Pesach I\b/.test(groups[1]) && /Pesach II\b/.test(groups[2]),
    `consecutive Yom Tov days are numbered (${groups[1]} / ${groups[2]})`);
  ok(!/·/.test(groups[0]),
    `an ordinary day carries no festival qualifier (${groups[0]})`);
}

console.log('\n=== Y1b: a second night, candles are never calculated ===');
{
  // 2027-04-22 is Pesach I running into Pesach II, so nothing is lit until the
  // first day is out. WHICH nightfall a shul holds by for that is its own
  // practice, and there is no standard to fall back on the way there is for
  // erev Shabbos, where eighteen minutes before sunset is what everybody
  // prints.
  //
  // The board used to fall back to computed tzeis and label it "Candles after".
  // On the real wall that read "Candles after 7:26pm" for Beth Aaron on Succos
  // while their own calendar says 7:39pm — thirteen minutes INTO Yom Tov. An
  // invented time is worse than a blank one everywhere, and here it is worse
  // than most.
  const { w } = await boot('2027-04-21T15:00:00-04:00',
    { minyanim: schedule(PESACH), settings: { shuls: ['beth-aaron'] } });
  const labels = [...w.document.querySelectorAll('.card .label.edgerow')]
    .map((n) => n.textContent);
  ok(labels.includes('Candles'),
    `erev Yom Tov still calculates, because that one is standard (${labels.join(', ')})`);
  ok(!labels.includes('Candles after'),
    `but a second night with nothing published shows nothing (${labels.join(', ') || 'none'})`);
}
{
  // And when the shul DOES publish one, it is shown, to the minute they said.
  const fixture = schedule(PESACH);
  fixture.days['2027-04-22']['beth-aaron'].edge = { candles: '8:41 PM' };
  const { w } = await boot('2027-04-21T15:00:00-04:00',
    { minyanim: fixture, settings: { shuls: ['beth-aaron'] } });
  const row = [...w.document.querySelectorAll('.card .label.edgerow')]
    .find((n) => n.textContent === 'Candles after');
  ok(!!row, 'a published second-night time is shown');
  const times = [...w.document.querySelectorAll('.card .time.edgetime')]
    .map((n) => n.textContent.trim());
  ok(times.includes('8:41pm'),
    `and it is the shul's own minute, not a computed one (${times.join(' ')})`);
}

console.log('\n=== Y1c: a long chag keeps every day complete ===');
{
  // THE BUG THIS EXISTS FOR. The Auto ceiling was a flat 14 times per card, on
  // the reasoning that past a dozen nobody is reading a wall. That is true of
  // ONE day. On erev Succos the board shows three, each with a full seven
  // services — nineteen went in and fourteen came out, and what fell off the
  // end was the LAST time on the LAST day. Beth Aaron's card said Succos II had
  // a Mincha at 6:25 and then nothing, with its 7:30 Maariv cut and a third of
  // the card empty underneath it.
  //
  // Dropping times is supposed to be a legibility decision; the px floor and
  // the fit loop make that decision honestly. A fixed count sitting above them
  // was making it for a different reason and getting it wrong.
  const { w } = await boot('2027-04-21T15:00:00-04:00',
    { minyanim: schedule(PESACH), settings: { shuls: ['beth-aaron'] } });
  const groups = groupsOn(w);
  const times = [...w.document.querySelectorAll('.card .time:not(.edgetime)')]
    .map((n) => n.textContent.trim());
  ok(groups.length >= 3, `the board spans the chag (${groups.length} days)`);
  // The fixture gives every day 8:45am, 1:30pm, 7:00pm and 8:45pm. The last of
  // those is the one that used to fall off.
  const late = times.filter((t) => t === '8:45pm').length;
  ok(late >= groups.length - 1,
    `each day keeps its last minyan (${late} evening times over ${groups.length} days: ${times.join(' ')})`);
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
    const times = w.document.querySelectorAll('.card .body .time:not(.edgetime)').length;
    const groups = groupsOn(w).length;
    ok(times <= Number(cap), `perShul=${cap} yields ${times} minyan times (<= ${cap})`);
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
      // The worker answers for its own origin and nothing else, so it needs to
      // know what that is.
      location: { origin: 'https://x.test' },
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

  /* Cross-origin is not this worker's business ---------------------------

     THE CASE THIS EXISTS FOR. sports.js stamps every answer `at: Date.now()`
     and decides from that stamp what a game may still claim — a live score is
     shown for fifteen minutes after the snapshot it came from. A worker replay
     of a cached scoreboard is a 200 like any other, so a stale board arrived
     looking newly fetched and bought a licence it had not earned. The forecast
     has the same shape of problem.

     "Not answering" is the whole assertion: respondWith must never be called,
     which leaves the request to the browser and the freshness to the app,
     which is the only layer that understands what any of it means. */
  const before = entries.size;
  scope.fetch = async () => ({ ok: true, body: 'SCORES', clone: () => ({ ok: true, body: 'SCORES' }) });
  const espn = 'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=20260924';
  const meteo = 'https://api.open-meteo.com/v1/forecast?latitude=40.9';
  ok(await run(espn) === undefined, 'the worker does not answer for the scoreboard');
  ok(await run(meteo) === undefined, 'nor for the forecast');
  await new Promise((r) => setTimeout(r, 10));
  ok(entries.size === before,
    `and neither one is put in a cache (${entries.size - before} added)`);

  // Two days are two requests. cacheKey() strips the query for app URLs, and
  // collapsing ?dates=20260924 into ?dates=20260925 would hand yesterday's
  // board back for today — the exact bug the dates parameter was added to fix.
  const day2 = espn.replace('20260924', '20260925');
  ok(await run(day2) === undefined, 'a second day is left alone too');
  const stored = [...entries.keys()].filter((k) => k.includes('espn.com'));
  ok(stored.length === 0, `and no scoreboard key exists to collapse (${stored.length})`);
}

console.log('\n=== E0: an empty parse is not a confirmed schedule ===');
{
  // The aggregator serves "there are no Mincha minyanim scheduled" as an
  // ordinary 200, and the scraper writes an entry for it because the page did
  // render the right date. That is not a schedule; it is a page with nothing on
  // it, and the board used to announce it as "Done for today. Tomorrow's times
  // not confirmed yet" — about a shul whose times it had never obtained.
  const empty = { generated_at: new Date().toISOString(), days: {
    '2026-09-22': { 'beth-aaron': { shacharis: [], mincha: [], maariv: [], fetched_at: '2026-09-22T06:00:00Z' } },
    '2026-09-23': { 'beth-aaron': { shacharis: [], mincha: [], maariv: [], fetched_at: '2026-09-22T06:00:00Z' } },
  } };
  const { w } = await boot('2026-09-22T05:00:00-04:00',
    { minyanim: empty, settings: { shuls: ['beth-aaron'] } });
  const card = w.document.querySelector('.card').textContent;
  ok(/unavailable/i.test(card), `it says the times are unavailable (${card.slice(0, 60)})`);
  ok(!/Done for today/i.test(card), 'and not that the shul is done for today');
}

console.log('\n=== E0b: a real schedule that has been and gone still says so ===');
{
  // The other side of it: services ARE on file, and today's have all passed.
  // That is a genuine "done for today" and must not be flattened into
  // "unavailable" by the fix above.
  const past = { generated_at: new Date().toISOString(), days: {
    '2026-09-22': { 'beth-aaron': {
      shacharis: [{ label: 'Shacharis', time: '6:30 AM' }],
      mincha: [], maariv: [], fetched_at: '2026-09-22T06:00:00Z' } },
  } };
  const { w } = await boot('2026-09-22T23:30:00-04:00',
    { minyanim: past, settings: { shuls: ['beth-aaron'] } });
  const card = w.document.querySelector('.card').textContent;
  ok(/Done for today/i.test(card), `a real schedule that has passed says so (${card.slice(0, 60)})`);
}

console.log('\n=== O: the board follows the order the person chose ===');
{
  const four = ['ohr-saadya', 'beth-aaron', 'rinat', 'bnai-yeshurun'];
  const { w } = await boot('2026-09-22T14:05:00-04:00', { settings: { shuls: four } });
  const names = () => [...w.document.querySelectorAll('.card h2')].map((h) => h.textContent);

  // Three at a time, and the first three are the first three chosen — not the
  // first three alphabetically, which is what filtering the master list gave.
  ok(names().length === 3, `three cards on the first page (${names().length})`);
  ok(names()[0].includes('Ohr Saadya'),
    `the first chosen shul leads (${names().join(' / ')})`);
  ok(!names()[0].includes('Beth Aaron'),
    'and it is not simply alphabetical');

  // Two dots, the first one lit.
  const pager = $(w, 'pager');
  ok(!pager.hidden && pager.querySelectorAll('i').length === 2,
    `four shuls over three slots shows two dots (${pager.querySelectorAll('i').length})`);
  ok(pager.querySelectorAll('i')[0].className === 'on', 'the first is the one lit');

  // Walking a shul up changes the board, and returns to the first page.
  const up = w.document.querySelector('.move[data-slug="bnai-yeshurun"][data-dir="-1"]');
  ok(!!up, 'the fourth shul has a move-up control');
  up.dispatchEvent(new w.Event('click', { bubbles: true }));
  const moved = JSON.parse(w.localStorage.getItem('shabbos-clock-settings')).shuls;
  ok(moved.indexOf('bnai-yeshurun') === 2,
    `it moved up one place (${moved.join(', ')})`);
  ok(names().includes('Bnai Yeshurun') || names().length === 3,
    'and the board repainted');
}

console.log('\n=== O2: three or fewer needs no pager and no arrows past the ends ===');
{
  const { w } = await boot('2026-09-22T14:05:00-04:00',
    { settings: { shuls: ['beth-aaron', 'ohr-saadya'] } });
  ok($(w, 'pager').hidden, 'two shuls: no page indicator');
  const first = w.document.querySelector('.move[data-slug="beth-aaron"][data-dir="-1"]');
  const last = w.document.querySelector('.move[data-slug="ohr-saadya"][data-dir="1"]');
  ok(first?.disabled === true, 'the top shul cannot move up');
  ok(last?.disabled === true, 'the bottom shul cannot move down');
  // And pressing a disabled one changes nothing.
  first.dispatchEvent(new w.Event('click', { bubbles: true }));
  const after = JSON.parse(w.localStorage.getItem('shabbos-clock-settings')).shuls;
  ok(after.join() === 'beth-aaron,ohr-saadya', `order unchanged (${after.join(', ')})`);
}

console.log('\n=== Y4: two festivals back to back are named, not numbered ===');
{
  // Shemini Atzeres and Simchas Torah are consecutive Yom Tov days with
  // DIFFERENT names. Numbering them would say less than naming them does.
  const days = ['2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05'];
  const { w } = await boot('2026-10-02T15:00:00-04:00',
    { minyanim: schedule(days), settings: { shuls: ['beth-aaron'] } });
  const groups = groupsOn(w);
  ok(groups.some((g) => /Shemini Atzeres/.test(g)), `Shemini Atzeres is named (${groups.join(' / ')})`);
  ok(groups.some((g) => /Simchas Torah/.test(g)), 'and so is Simchas Torah');
  ok(!groups.some((g) => /\bI{1,3}\b/.test(g)), 'neither is given a numeral');
}

console.log('\n=== N: the NEXT countdown is written in place, not rendered in ===');
{
  const when = '2026-09-22T14:05:00-04:00';
  const { w, advance } = await boot(when);
  const flag = () => w.document.querySelector('.nextflag');
  ok(!!flag(), 'the next minyan carries a flag');
  ok(flag().dataset.at, 'the flag carries the moment, not the countdown');

  // The page's clock, not this process's — the window is frozen to `when`, and
  // an offset from the real now would be two days out.
  const inside = (ms) => { flag().dataset.at = String(w.Date.now() + ms); };

  // Far out: a countdown would be arithmetic rather than information.
  inside(6 * 3600 * 1000);
  w.eval('paintCountdowns(new Date())');
  ok(flag().textContent === 'Next',
    `six hours out it stays a plain marker (${flag().textContent})`);

  // Inside the window it counts, and the BOARD is not rebuilt to do it.
  const card = w.document.querySelector('.card');
  inside(42 * 60000);
  w.eval('paintCountdowns(new Date())');
  ok(/^Next · 4[12]m$/.test(flag().textContent),
    `forty-two minutes out it says so (${flag().textContent})`);
  ok(w.document.querySelector('.card') === card,
    'and the card node was not replaced to do it');

  inside(30000);
  w.eval('paintCountdowns(new Date())');
  ok(flag().textContent === 'Next · soon', `under a minute it says soon (${flag().textContent})`);

  // The generated markup never varies, which is what keeps the memoisation
  // honest across a run of renders.
  for (let i = 0; i < 6; i += 1) { advance(30000); w.eval('render()'); }
  ok(w.document.querySelector('.card') === card,
    'six renders across three minutes replace no card node');
}

console.log('\n=== WN: the weather says something only when there is something ===');
{
  const when = '2026-09-22T14:05:00-04:00';
  const base = () => {
    const f = forecastFrom(when);
    // A flat, dry, mild window: nothing to say about it.
    f.hourly.precipitation_probability = f.hourly.precipitation_probability.map(() => 5);
    f.hourly.temperature_2m = f.hourly.temperature_2m.map(() => 60);
    f.hourly.apparent_temperature = f.hourly.apparent_temperature.map(() => 60);
    return f;
  };
  const noteOn = async (edit) => {
    const f = base();
    edit(f);
    const { w } = await boot(when, { forecast: f });
    return $(w, 'weather').querySelector('.wnote')?.textContent ?? '';
  };

  ok(await noteOn(() => {}) === '', 'an unremarkable afternoon says nothing at all');

  // Hours 2, 3 and 4 of the window are wet: 4pm, 5pm, 6pm, ending at 7pm.
  const rain = await noteOn((f) => {
    for (const i of [2, 3, 4]) f.hourly.precipitation_probability[i] = 65;
  });
  ok(/^Rain likely 4pm\u20137pm$/.test(rain), `one spell, named by its span (${rain})`);

  // AN AMOUNT WHERE THERE IS ONE, A CHANCE WHERE THERE IS NOT.
  //
  // The strip only ever printed a percentage, so a near-certain drizzle and a
  // cloudburst read identically at 90% against 90%, and the icon did not
  // separate them either — 61, 63 and 65 are light, moderate and heavy rain
  // and all three draw the same raindrop. How much is the question somebody is
  // actually asking at the tile.
  {
    const f = base();
    f.hourly.precipitation = f.hourly.precipitation_probability.map(() => 0);
    f.hourly.precipitation_probability[3] = 70;   // likely, but nothing to measure
    f.hourly.precipitation_probability[4] = 70;
    f.hourly.precipitation[4] = 5.1;              // a fifth of an inch
    const { w } = await boot(when, { forecast: f });
    const cells = [...w.document.querySelectorAll('.wcol')]
      .map((c) => c.querySelector('.wpop')?.textContent ?? '');
    ok(cells.some((t) => /^0\.2\u2033$/.test(t)),
      `a measurable hour shows how much (${cells.filter(Boolean).join(' ')})`);
    ok(cells.some((t) => /^70%$/.test(t)),
      'and an hour with nothing to measure still shows the chance');
  }

  // HEAVY IS AN INTENSITY, NOT A CERTAINTY.
  //
  // This used to raise the probability to 90 and expect "Heavy rain", because
  // that is what the code did: it took the highest chance of ANY rain and
  // called 80% a soaking. So a near-certain drizzle was announced as a downpour
  // and a merely likely cloudburst was not. The forecast says which it is —
  // WMO 61/63/65 are light, moderate, heavy — and that is what is read now.
  const certain = await noteOn((f) => {
    for (const i of [2, 3]) {
      f.hourly.precipitation_probability[i] = 95;
      f.hourly.weather_code[i] = 61;                 // light rain, near certain
    }
  });
  // Not "Heavy" — that word is reserved for the codes that mean it. A near
  // certainty earns "very likely", which is a statement about the odds and
  // makes no claim at all about how hard it will come down.
  ok(/^Rain very likely/.test(certain) && !/Heavy/.test(certain),
    `a near-certain drizzle is very likely, not heavy (${certain})`);

  const heavy = await noteOn((f) => {
    for (const i of [2, 3]) {
      f.hourly.precipitation_probability[i] = 65;
      f.hourly.weather_code[i] = 65;                 // heavy rain, merely likely
    }
  });
  ok(/^Heavy rain likely/.test(heavy),
    `and heavy rain is called heavy on the code, not the odds (${heavy})`);

  const single = await noteOn((f) => { f.hourly.precipitation_probability[3] = 70; });
  ok(/around 5pm$/.test(single), `a single wet hour is "around", not a range (${single})`);

  const freeze = await noteOn((f) => {
    for (let i = 6; i < 12; i += 1) f.hourly.apparent_temperature[i] = 28;
  });
  ok(/^Feels below freezing from 8pm$/.test(freeze), `the cold is named by when (${freeze})`);

  // Rain outranks cold: it is the one that changes what you carry.
  const both = await noteOn((f) => {
    for (const i of [2, 3]) f.hourly.precipitation_probability[i] = 65;
    for (let i = 6; i < 12; i += 1) f.hourly.apparent_temperature[i] = 28;
  });
  ok(/^Rain/.test(both), `rain is ranked above cold (${both})`);

  const warming = await noteOn((f) => {
    f.hourly.temperature_2m = f.hourly.temperature_2m.map((_, i) => 55 + i * 2);
  });
  ok(/^Warming to \d+\u00b0 by /.test(warming), `a big climb is worth a line (${warming})`);

  const dropping = await noteOn((f) => {
    f.hourly.temperature_2m = f.hourly.temperature_2m.map((_, i) => 75 - i * 2);
  });
  ok(/^Dropping to \d+\u00b0 by /.test(dropping), `and so is a big fall (${dropping})`);
}

console.log('\n=== K: Kelvin ===');
{
  const when = '2026-09-25T14:05:00-04:00';
  const read = async (units) => {
    const { w } = await boot(when, { forecast: forecastFrom(when), settings: { units } });
    return $(w, 'weather').querySelector('.wbig')?.textContent ?? '';
  };
  const f = await read('F');
  const c = await read('C');
  const k = await read('K');
  ok(/^\d+\u00b0$/.test(f), `Fahrenheit is a degree (${f})`);
  ok(/^\d+\u00b0$/.test(c), `so is Celsius (${c})`);
  // 273 K, not 273°. Kelvin is not a degree and is not written as one.
  ok(/^\d+\u202fK$/.test(k), `Kelvin is not (${k})`);
  const n = (t) => Number(String(t).replace(/[^\d-]/g, ''));
  ok(n(k) - n(c) === 273, `and it is Celsius plus 273 (${n(c)} -> ${n(k)})`);
}

console.log('\n=== WC: a span that covers two things says both ===');
{
  // The caption named the day the rest period STARTED on, and a rest period can
  // run three days across two different occasions. "Succos · through 7:25pm"
  // over a strip whose last hours are Shabbos is incomplete on the side that
  // matters — the end is what somebody is reading it for.
  const cap = async (iso) => {
    const { w } = await boot(iso, { forecast: forecastFrom(iso) });
    return $(w, 'weather').querySelector('.whead')?.textContent ?? '';
  };
  const atzeres = await cap('2026-10-02T14:00:00-04:00');
  ok(/Shemini Atzeres \u2192 Simchas Torah/.test(atzeres),
    `two occasions in one span name both (${atzeres.slice(0, 44)})`);
  const pesach = await cap('2027-04-23T14:00:00-04:00');
  ok(/Pesach \u2192 Shabbos/.test(pesach),
    `and a Shabbos inside Chol HaMoed is called Shabbos (${pesach.slice(0, 44)})`);
  const plain = await cap('2026-09-18T14:00:00-04:00');
  ok(/^Shabbos/.test(plain) && !/\u2192/.test(plain),
    `an ordinary Friday still says one word (${plain.slice(0, 30)})`);
}

console.log('\n=== AP: meridiems are am and pm, not a and p ===');
{
  const when = '2026-09-25T14:05:00-04:00';
  const { w } = await boot(when, { forecast: forecastFrom(when) });
  const hours = [...w.document.querySelectorAll('.whour')].map((n) => n.textContent);
  ok(hours.every((h) => h === 'Now' || /^\d{1,2}(am|pm)$/.test(h)),
    `weather hours read 3pm, not 3p (${hours.slice(0, 4).join(' ')})`);
}
{
  // Read off the CARDS, on a Friday the fixture actually covers. This used to
  // read the tile beside the clock, and once the candle and havdalah times
  // moved into the shuls' own boxes that string was always empty — the
  // assertion went on passing while testing nothing at all.
  const { w } = await boot('2026-09-18T14:05:00-04:00');
  const edges = [...w.document.querySelectorAll('.time.edgetime')].map((n) => n.textContent);
  ok(edges.length > 0, `erev Shabbos has candle and havdalah rows (${edges.length})`);
  ok(edges.every((t) => /^\d{1,2}:\d{2}(am|pm)$/.test(t.trim())),
    `and they read 6:41pm, not 6:41p (${edges.join(' ') || 'none'})`);
}

/* SP — scores ------------------------------------------------------------ */
// An ESPN-shaped event, reduced to the fields this actually reads.
function game(away, aScore, home, hScore, { state = 'post', detail = 'Final', post = false,
  at = '2026-09-22T23:00Z' } = {}) {
  return {
    date: at,
    season: { type: post ? 3 : 2 },
    status: { type: { state, shortDetail: detail } },
    competitions: [{ competitors: [
      { homeAway: 'away', score: String(aScore), team: { abbreviation: away } },
      { homeAway: 'home', score: String(hScore), team: { abbreviation: home } },
    ] }],
  };
}
const feed = (map) => Object.fromEntries(
  Object.entries(map).map(([k, v]) => [k, { events: v }]));

async function withScores(when, map, extra = {}) {
  const boots = await boot(when, { scores: feed(map), ...extra });
  // Four passes, because the feed is fetched one league at a time in rotation.
  await boots.w.eval('(async () => { for (let i = 0; i < 4; i += 1) await refreshSports(); })()');
  await new Promise((r) => setTimeout(r, 60));
  return boots;
}

// The band is driven through the real scheduler, never by poking state.
// `let` bindings do not escape the eval that declared them, so assigning
// sportsAt from a later eval creates a NEW global and leaves the module's own
// unchanged — the assertion then passes or fails for reasons unconnected to the
// app. tick() is a function declaration, which does leak, so this is the path
// the clock itself uses.
function runSportsClock({ w, advance }, minutes = 21) {
  w.eval('tick()');                 // arms the interval
  advance(minutes * 60000);
  w.eval('tick()');                 // due now
}

console.log('\n=== SP1: abbreviations are scoped per league ===');
{
  // The trap this is built around. "Rangers" is NYR in hockey and TEX in
  // baseball; "Giants" is NYG in football and SF in baseball; "Jets" is NYJ and
  // WPG. A flat list of names would follow three wrong teams.
  const when = '2026-09-22T20:00:00-04:00';
  const { w } = await withScores(when, {
    'baseball/mlb': [game('TEX', 3, 'SEA', 1), game('SF', 2, 'LAD', 4), game('NYY', 5, 'BOS', 2)],
    'hockey/nhl': [game('WPG', 1, 'CGY', 2)],
  });
  const kept = await w.eval('sportsGames().map((g) => `${g.a}@${g.h}`)');
  ok(kept.length === 1 && kept[0] === 'NYY@BOS',
    `only the real local game is kept (${kept.join(', ') || 'none'})`);
}

console.log('\n=== SP2: playoffs anywhere, regular season only at home ===');
{
  const when = '2026-09-22T20:00:00-04:00';
  const { w } = await withScores(when, {
    'baseball/mlb': [
      game('HOU', 2, 'CLE', 3, { post: true }),     // no local team, but postseason
      game('MIA', 1, 'PIT', 0),                     // neither, regular season
      game('NYM', 4, 'ATL', 3),                     // local
    ],
  });
  const kept = await w.eval('sportsGames().map((g) => `${g.a}@${g.h}`)');
  ok(kept.includes('NYM@ATL'), 'the local game is in');
  ok(kept.includes('HOU@CLE'), 'so is a playoff game between two others');
  ok(!kept.includes('MIA@PIT'), `and an unrelated regular-season game is not (${kept.join(', ')})`);
}

console.log('\n=== SP3: last night\'s result leads, because that is the job ===');
{
  // Eight in the morning, on the way out. What is wanted is the result of the
  // game that finished last night — not something in progress, which at this
  // hour barely happens and would mean standing and watching anyway.
  const when = '2026-09-23T08:00:00-04:00';
  const { w } = await withScores(when, {
    'baseball/mlb': [
      game('NYY', 0, 'TB', 0, { state: 'pre', detail: '7:05 PM', at: '2026-09-23T23:05Z' }),
      game('NYM', 4, 'ATL', 3, { state: 'post', detail: 'Final', at: '2026-09-22T23:10Z' }),
    ],
    'hockey/nhl': [game('NJ', 2, 'NYR', 1, { state: 'in', detail: '2nd 8:24', at: '2026-09-23T11:00Z' })],
  });
  const order = await w.eval('sportsGames().map((g) => g.state)');
  ok(order[0] === 'post', `the finished game leads (${order.join(' ')})`);
  ok(order[order.length - 1] === 'pre', 'and tonight\'s game is last');

  // The label describes what is LEADING, not whatever is on somewhere: there is
  // a live game in this fixture and the band should still say Last night,
  // because that is what the first column is.
  w.eval('renderSports()');
  ok(/Last night/.test($(w, 'weather').textContent),
    `the band says what it is showing (${$(w, 'weather').textContent.slice(0, 34)})`);
}

console.log('\n=== SP3b: two results, the later one first ===');
{
  const when = '2026-09-23T08:00:00-04:00';
  const { w } = await withScores(when, {
    'baseball/mlb': [
      game('NYY', 5, 'BOS', 2, { state: 'post', detail: 'Final', at: '2026-09-22T22:00Z' }),
      game('NYM', 4, 'ATL', 3, { state: 'post', detail: 'Final', at: '2026-09-23T02:30Z' }),
    ],
  });
  const order = await w.eval('sportsGames().map((g) => g.a)');
  ok(order[0] === 'NYM', `the latest result is the one not yet seen (${order.join(' ')})`);
}

console.log('\n=== SP3c: the label tells the truth about which it is ===');
{
  const morning = '2026-09-23T08:00:00-04:00';
  const nightBefore = await withScores(morning,
    { 'baseball/mlb': [game('NYM', 4, 'ATL', 3, { state: 'post', at: '2026-09-22T23:10Z' })] });
  nightBefore.w.eval('renderSports()');
  ok(/Last night/.test($(nightBefore.w, 'weather').textContent), 'yesterday evening reads Last night');

  const earlierToday = await withScores('2026-09-23T20:00:00-04:00',
    { 'baseball/mlb': [game('NYM', 4, 'ATL', 3, { state: 'post', at: '2026-09-23T17:10Z' })] });
  earlierToday.w.eval('renderSports()');
  const text = $(earlierToday.w, 'weather').textContent;
  ok(/Final/.test(text) && !/Last night/.test(text),
    `an afternoon result today is not "last night" (${text.slice(0, 30)})`);
}

console.log('\n=== SP4: the band is borrowed, then given back ===');
{
  const when = '2026-09-22T20:00:00-04:00';
  // A final, deliberately: the clock is advanced twenty-one minutes below to
  // reach the interval, and a LIVE fixture would — correctly — stop being
  // trustworthy on the way. A result does not go stale, which is the point.
  const boots = await withScores(when,
    { 'hockey/nhl': [game('NJ', 2, 'NYR', 1, { state: 'post', detail: 'Final' })] });
  const { w, advance } = boots;
  const band = $(w, 'weather');
  ok(band.querySelector('.sgame') === null, 'the band starts as the weather');

  runSportsClock(boots);
  ok(band.querySelector('.sgame') !== null, 'the scores take it when the interval comes round');
  ok(/NYR/.test(band.textContent), `and they are the right ones (${band.textContent.trim().slice(0, 40)})`);

  // Past the half minute it is given back, without waiting out a real timeout.
  advance(31000);
  w.eval('render()');
  ok(band.querySelector('.sgame') === null,
    'and it goes back to the weather rather than sticking');
}

console.log('\n=== SP5: nothing to say, nothing said ===');
{
  const when = '2026-09-22T20:00:00-04:00';
  const empty = await withScores(when, { 'baseball/mlb': [game('MIA', 1, 'PIT', 0)] });
  ok(await empty.w.eval('sportsGames().length') === 0, 'no relevant games');
  runSportsClock(empty);
  ok($(empty.w, 'weather').querySelector('.sgame') === null,
    'the band is not taken over for an empty strip');

  const off = await withScores(when,
    { 'hockey/nhl': [game('NJ', 2, 'NYR', 1, { state: 'in' })] },
    { settings: { sports: 'off' } });
  // Off does not merely hide the band: it never asks ESPN for anything, which
  // is why there is nothing cached to show either.
  ok(await off.w.eval('sportsGames().length') === 0,
    'Off does not even fetch, so nothing is cached');
  runSportsClock(off);
  ok($(off.w, 'weather').querySelector('.sgame') === null, 'and Off means off');
}

console.log('\n=== SP5b: a cached state may only claim what it can still prove ===');
{
  // One league is refreshed about every forty minutes. That is right for a
  // result and useless for anything in motion.
  const when = '2026-09-23T20:00:00-04:00';

  const fresh = await withScores(when, {
    'hockey/nhl': [game('NJ', 2, 'NYR', 1, { state: 'in', detail: '2nd 8:24', at: '2026-09-23T23:00Z' })],
  });
  ok(await fresh.w.eval('sportsGames().length') === 1, 'a live score just fetched is shown');
  // Twenty minutes later the same snapshot is no longer evidence of anything.
  fresh.advance(20 * 60000);
  ok(await fresh.w.eval('sportsGames().length') === 0,
    'and is dropped once the snapshot it came from is old');

  // A result from the same snapshot survives, because a result does not change.
  const done = await withScores(when, {
    'hockey/nhl': [game('NJ', 2, 'NYR', 1, { state: 'post', detail: 'Final', at: '2026-09-23T23:00Z' })],
  });
  done.advance(6 * 3600 * 1000);
  ok(await done.w.eval('sportsGames().length') === 1,
    'a final is still true six hours after it was fetched');

  // And a game cached as "not started" must not go on saying so through the
  // game itself. Eligibility used to be decided from the scheduled time, so it
  // advertised a 7:05 start all evening.
  const stale = await withScores('2026-09-23T18:00:00-04:00', {
    'baseball/mlb': [game('TB', 0, 'NYY', 0, { state: 'pre', detail: '7:05 PM', at: '2026-09-23T23:05Z' })],
  });
  ok(await stale.w.eval('sportsGames().length') === 1, 'before the start it is shown');
  stale.advance(3 * 3600 * 1000);          // an hour into the game
  ok(await stale.w.eval('sportsGames().length') === 0,
    'and not once its own start time has been and gone');
}

console.log('\n=== SP6: the fetch is a plain rotation ===');
{
  // An earlier version chased whichever league had a game in progress and
  // tightened to two minutes to keep up. That was solving for standing at the
  // screen following a game, which is the opposite of what this is for — and
  // last night's result does not change, so there is nothing to keep up with.
  const when = '2026-09-23T08:00:00-04:00';
  const { w } = await withScores(when, {
    'hockey/nhl': [game('NJ', 2, 'NYR', 1, { state: 'in', detail: '2nd' })],
    'baseball/mlb': [game('NYY', 5, 'BOS', 2, { state: 'post' })],
  });
  const picks = await w.eval(
    '(() => { const out = []; for (let i = 0; i < 8; i += 1) out.push(sportsNextLeague().tag); return out; })()');
  ok(new Set(picks).size === 4, `every league gets its turn (${picks.join(' ')})`);
  ok(picks.slice(0, 4).join() === picks.slice(4).join(),
    'in a steady rotation, whatever is being played');
}

console.log('\n=== SP7: everything is fetched once, then rotated ===');
{
  const when = '2026-09-23T08:00:00-04:00';
  const { w } = await boot(when, { scores: feed({
    'baseball/mlb': [game('NYM', 4, 'ATL', 3, { state: 'post' })],
    'football/nfl': [game('NYG', 20, 'DAL', 17, { state: 'post' })],
    'hockey/nhl': [game('NJ', 2, 'NYR', 1, { state: 'post' })],
    'basketball/nba': [game('BKN', 101, 'NY', 98, { state: 'post' })],
  }) });
  // start() warms all four; without that the picture is a quarter complete for
  // ten minutes and three quarters complete for thirty.
  await new Promise((r) => setTimeout(r, 120));
  const ages = await w.eval('sportsAges()');
  ok(['MLB', 'NFL', 'NHL', 'NBA'].every((t) => ages.includes(t)),
    `every league is loaded at startup (${ages})`);
}

console.log('\n=== SP7b: switching Scores on starts loading at once ===');
{
  const when = '2026-09-23T08:00:00-04:00';
  const { w } = await boot(when, {
    settings: { sports: 'off' },
    scores: feed({ 'baseball/mlb': [game('NYM', 4, 'ATL', 3, { state: 'post' })] }),
  });
  ok(await w.eval('sportsAges()') === 'none fetched yet', 'Off fetched nothing');
  const sel = w.document.getElementById('sports');
  sel.value = '20';
  sel.dispatchEvent(new w.Event('change'));
  await new Promise((r) => setTimeout(r, 120));
  ok((await w.eval('sportsAges()')).includes('MLB'),
    'turning it on warms the cache rather than waiting for the rotation');
}

console.log('\n=== SP8: every interval offered is one the app accepts ===');
{
  const { w } = await boot('2026-09-22T14:05:00-04:00');
  const offered = [...w.document.querySelectorAll('#sports option')].map((o) => o.value);
  ok(offered.join(',') === 'off,2,5,10,20,30', `the menu reads ${offered.join(', ')}`);
  for (const value of offered) {
    const { w: v } = await boot('2026-09-22T14:05:00-04:00', { settings: { sports: value } });
    const kept = JSON.parse(v.localStorage.getItem('shabbos-clock-settings')).sports;
    ok(kept === value || value === 'off',
      `${value} survives sanitise (kept ${kept})`);
    ok(v.document.getElementById('sports').value === value,
      `and the select shows ${value} rather than blanking`);
  }
}

console.log('\n=== SP9: a stored "false" is not true ===');
{
  const { w } = await boot('2026-09-22T14:05:00-04:00',
    { settings: { showWeather: 'false', seconds: 'false' } });
  // Read from the sheet, not from localStorage: the app only writes there on a
  // change, so reading it back here would just be reading this test's own seed.
  // buildSettings ticks each box from the sanitised value, so the box IS the
  // observable.
  const seconds = w.document.getElementById('seconds').checked;
  const weather = w.document.getElementById('showWeather').checked;
  // Not "becomes false" — each falls back to its OWN default, true for the
  // weather and false for the dial. The bug being fixed is that Boolean("false")
  // is true, so the dial would have switched itself on.
  ok(seconds === false, `the string "false" does not turn the dial on (${seconds})`);
  ok(weather === true,
    `and a non-boolean falls back to the default rather than being coerced (${weather})`);
}

console.log('\n=== SP10: the band lands on the clock, not on uptime ===');
{
  // Started at an awkward moment on purpose. "Every five minutes" has to mean
  // :00, :05, :10 — so somebody can look at the numerals and know the scores
  // are ninety seconds off — not "five minutes after whenever this booted".
  const when = '2026-09-23T08:03:17-04:00';
  const { w } = await withScores(when,
    { 'baseball/mlb': [game('NYM', 4, 'ATL', 3, { state: 'post', at: '2026-09-22T23:10Z' })] },
    { settings: { sports: '5' } });

  const minuteOf = (t) => new Date(t).getMinutes();

  // The boundary itself, which is a pure function and can simply be asked.
  const next = await w.eval('sportsBoundary(5, Date.now())');
  ok(minuteOf(next) === 5, `from 08:03:17 the next showing is :05 (got :${minuteOf(next)})`);
  const after = await w.eval(`sportsBoundary(5, ${next + 1})`);
  ok(minuteOf(after) === 10, `then :10, not five minutes from whenever it fired (:${minuteOf(after)})`);
  for (const mins of [2, 10, 20, 30]) {
    const b = await w.eval(`sportsBoundary(${mins}, Date.now())`);
    ok(minuteOf(b) % mins === 0,
      `every ${mins} min lands on a multiple of ${mins} (:${String(minuteOf(b)).padStart(2, '0')})`);
  }
}

console.log('\n=== SP10b: and it really waits for the boundary ===');
{
  // Driven through the scheduler rather than by reading sportsNext, which is a
  // `let` and therefore invisible from here — see the note at the top.
  const when = '2026-09-23T08:03:17-04:00';
  const boots = await withScores(when,
    { 'baseball/mlb': [game('NYM', 4, 'ATL', 3, { state: 'post', at: '2026-09-22T23:10Z' })] },
    { settings: { sports: '5' } });
  const { w, advance } = boots;
  const band = $(w, 'weather');

  w.eval('tick()');                     // arms it: next boundary is 08:05:00
  ok(band.querySelector('.sgame') === null, 'nothing yet at 08:03:17');

  advance(100 * 1000);                  // 08:04:57, still short of it
  w.eval('tick()');
  ok(band.querySelector('.sgame') === null, 'still nothing at 08:04:57');

  advance(5 * 1000);                    // 08:05:02
  w.eval('tick()');
  ok(band.querySelector('.sgame') !== null, 'and it appears once the clock reaches :05');
}

console.log('\n=== SP12: a delayed game is not a standing licence ===');
{
  // A real delay confirmed after the scheduled start is worth showing. The same
  // snapshot still insisting at midnight that the game has not begun is the feed
  // having gone away, not a delay.
  const start = '2026-09-23T23:05Z';
  const justConfirmed = await withScores('2026-09-23T19:20:00-04:00', {
    'baseball/mlb': [game('TB', 0, 'NYY', 0, { state: 'pre', detail: '7:05 PM', at: start })],
  });
  ok(await justConfirmed.w.eval('sportsGames().length') === 1,
    'a delay confirmed after the start time is shown');

  justConfirmed.advance(20 * 60000);
  ok(await justConfirmed.w.eval('sportsGames().length') === 0,
    'and stops being shown once that snapshot is old');
}

console.log('\n=== SP13: changing the interval takes effect at once ===');
{
  const when = '2026-09-23T08:03:17-04:00';
  const boots = await withScores(when,
    { 'baseball/mlb': [game('NYM', 4, 'ATL', 3, { state: 'post', at: '2026-09-22T23:10Z' })] },
    { settings: { sports: '20' } });
  const { w, advance } = boots;
  const band = $(w, 'weather');

  w.eval('tick()');                        // armed for the :20 boundary
  const sel = w.document.getElementById('sports');
  sel.value = '2';
  sel.dispatchEvent(new w.Event('change'));

  // The change clears the schedule; the clock re-arms on its next tick, which
  // in the app is a second later. Then the next TWO-minute boundary is 08:04 —
  // not 08:20, which is what waiting out the old cadence would have meant.
  w.eval('tick()');
  advance(43 * 1000);                      // 08:04:00
  w.eval('tick()');
  ok(band.querySelector('.sgame') !== null,
    'the new cadence starts from its own next boundary, not the old one');

  // And it really is the new one: at the old setting nothing would show until
  // :20, seventeen minutes later.
  // The PAGE's clock. Date in this file is Node's and is two days and some
  // hours away from the frozen one the app is running on.
  const minute = await w.eval('new Date().getMinutes()');
  ok(minute === 4, `at :04, not waiting for :20 (:${minute})`);
}

console.log('\n=== SP15: yesterday is asked for, because that is the whole job ===');
{
  // The bug this exists for. The plain scoreboard endpoint answers for TODAY,
  // so at eight in the morning the band held four fixtures that had not been
  // played yet and last night's result — the only thing anybody wants from it
  // — was never in the payload at all. SPORTS_BACK_MS says a finished game
  // stays interesting for twenty hours and it had nothing to keep, because the
  // data was gone before the filter ever saw it.
  //
  // Nothing in any suite could see this: every fixture here is handed straight
  // to the parser, so the tests were answering a question the app was not
  // asking.
  const when = '2026-09-25T08:03:00-04:00';
  const { w } = await withScores(when, {
    'baseball/mlb': [game('TB', 4, 'NYY', 6, { at: '2026-09-24T23:05Z' })],
  });

  const asked = await w.eval('(window.__espn || []).join(" ")');
  ok(asked.includes('dates=20260924'),
    'yesterday is requested by name (dates=20260924)');
  ok(/scoreboard(\?|$| )/.test(asked.replace(/dates=\d+/g, '')),
    'and today is still requested too, which is what NFL answers with its week');

  const kept = await w.eval('sportsGames().map((g) => `${g.a} ${g.as}@${g.h} ${g.hs}`)');
  ok(kept.length === 1 && kept[0] === 'TB 4@NYY 6',
    `last night's final survives into the morning (${kept.join(', ') || 'none'})`);
  const label = await w.eval('sportsLabel(sportsGames(), new Date())');
  ok(label === 'Last night', `and the band says so (${label})`);
}

console.log('\n=== SP14: switching Off takes the band back at once ===');
{
  const when = '2026-09-23T08:03:17-04:00';
  const boots = await withScores(when,
    { 'baseball/mlb': [game('NYM', 4, 'ATL', 3, { state: 'post', at: '2026-09-22T23:10Z' })] },
    { settings: { sports: '5' } });
  const { w, advance } = boots;
  const band = $(w, 'weather');

  w.eval('tick()');
  advance(120 * 1000);
  w.eval('tick()');
  ok(band.querySelector('.sgame') !== null, 'the scores are up');

  const sel = w.document.getElementById('sports');
  sel.value = 'off';
  sel.dispatchEvent(new w.Event('change'));
  ok(band.querySelector('.sgame') === null,
    'and Off takes the band back there and then, not on the next tick');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
