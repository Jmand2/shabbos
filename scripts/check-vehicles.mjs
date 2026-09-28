// Static gates on the vehicle artwork. jsdom only, no browser, runs in seconds.
//   node scripts/check-vehicles.mjs
//
// These exist because a redraw once dropped the class names that five
// animations targeted (rotor, tail rotor, flame, burner, train wheels) and every
// other suite stayed green: the CSS matched nothing, silently.
//
// Needs two things from flights.js: shabbosFlights.spec() (exists) and
// shabbosFlights.metrics(name, W) (see HANDOFF.md, phase 0).
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (f) => readFileSync(new URL(f, root), 'utf8');

const FACE_MIN_PX = 70;        // diameter at 1024 wide; below this a face is a blob across the room
const STROKE_MIN_PX = 2.5;     // thinner than this vanishes at viewing distance
const NODES_MAX = 150;         // per vehicle, before particles; a parade puts ten on an iPad
const W = 1024;

const dom = new JSDOM('<!doctype html><body><main id="screen"></main></body>', {
  runScripts: 'outside-only', url: 'https://x.test/',
});
const w = dom.window;
w.fetch = () => Promise.reject(new Error('no network in checks'));
for (const f of ['kinetics.js', 'vehicles.js', 'flights.js']) {
  try { w.eval(read(f)); } catch (e) { if (f === 'flights.js') throw e; }   // kinetics/vehicles arrive in phase 0
}
await new Promise((r) => setTimeout(r, 50));

const F = w.shabbosFlights;
const css = read('flights.css');
let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? '  ok  ' : '  FAIL'} ${msg}`); if (!cond) fails += 1; };

if (typeof F?.metrics !== 'function') {
  ok(false, 'shabbosFlights.metrics(name, W) exists (phase 0 adds it; the size gates need it)');
}

const names = F.names();
const classesIn = (art) => new Set([...art.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)));

// CSS rules, with comments stripped: [{ selectors: [...], body }]
const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}@]+)\{([^{}]*)\}/g)]
  .map((m) => ({ selectors: m[1].split(',').map((s) => s.trim()).filter(Boolean), body: m[2] }));

// Stroke widths the stylesheet gives each class, for the detail floor.
const cssWidth = {};
for (const r of rules) {
  const sw = r.body.match(/stroke-width:\s*([\d.]+)/);
  if (!sw) continue;
  for (const sel of r.selectors) {
    const cls = sel.match(/\.([\w-]+)\s*$/)?.[1];
    if (cls) cssWidth[cls] = Math.min(cssWidth[cls] ?? Infinity, Number(sw[1]));
  }
}
const baseWidth = Number(rules.find((r) => r.selectors.includes('.flight svg'))?.body.match(/stroke-width:\s*([\d.]+)/)?.[1] ?? 3);

for (const name of names) {
  const v = F.spec(name);
  const art = v.art;
  const has = classesIn(art);
  console.log(`\n${name}`);

  // 1. Every rule scoped to this vehicle must hit something in its artwork.
  const dead = [];
  for (const r of rules) {
    for (const sel of r.selectors) {
      const m = sel.match(new RegExp(`^\\.${name}\\s+(.+)$`));
      if (!m) continue;
      const wanted = [...m[1].matchAll(/\.([\w-]+)/g)].map((x) => x[1]);
      const missing = wanted.filter((c) => !has.has(c));
      if (missing.length) dead.push(`${sel} (no .${missing.join(', .')})`);
    }
  }
  ok(!dead.length, dead.length ? `CSS targets parts this vehicle does not have: ${dead.join('; ')}` : 'every rule scoped to it matches its artwork');

  // 2. No ids in artwork. Two of the same vehicle in a parade would duplicate
  // them, and when the first is removed the second loses its gradient.
  ok(!/\sid="/.test(art), 'no id attributes in artwork (shared <defs> live once, in the flyway layer)');

  // 3. Node budget.
  const nodes = (art.match(/<(?!\/)[a-z]/gi) ?? []).length + v.seats;
  ok(nodes <= NODES_MAX, `${nodes} drawn nodes (max ${NODES_MAX})`);

  if (typeof F.metrics !== 'function') continue;
  const { scale, faces } = F.metrics(name, W);

  // 4. Faces keep their size.
  const smallest = Math.min(...faces.map((r) => r * 2));
  ok(smallest >= FACE_MIN_PX, `smallest face ${smallest.toFixed(0)} px across at ${W} wide (min ${FACE_MIN_PX})`);

  // 5. Detail floor: nothing thinner than survives the room.
  const widths = [...art.matchAll(/stroke-width="([\d.]+)"/g)].map((m) => Number(m[1]));
  for (const c of has) if (cssWidth[c] !== undefined) widths.push(cssWidth[c]);
  if (!widths.length) widths.push(baseWidth);
  const thinnest = Math.min(...widths) * scale;
  ok(thinnest >= STROKE_MIN_PX, `thinnest stroke ${thinnest.toFixed(1)} px on screen (min ${STROKE_MIN_PX})`);
}

// 6. Generic rules (.flight .x) must match at least one vehicle.
const all = new Set(names.flatMap((n) => [...classesIn(F.spec(n).art)]));
const orphans = [];
for (const r of rules) for (const sel of r.selectors) {
  const m = sel.match(/^\.flight\s+\.([\w-]+)/);
  if (m && m[1] !== 'seat' && !all.has(m[1])) orphans.push(sel);
}
console.log('');
ok(!orphans.length, orphans.length ? `generic rules matching no vehicle: ${orphans.join('; ')}` : 'every generic .flight rule matches some vehicle');

console.log(fails ? `\n${fails} failed` : '\nall vehicle gates pass');
// flights.js arms its schedule and hour timers on start; they would hold the
// process open for up to an hour.
w.close();
process.exit(fails ? 1 : 0);
