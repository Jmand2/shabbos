// The service worker's one real promise: a page is never assembled out of two
// generations.
//
// That is not something the other suites can see. jsdom has no service worker
// at all, and the layout suite loads each page once over a healthy network,
// which is precisely the case where nothing goes wrong. This installs one
// generation, publishes a second, and then reloads through a network that only
// half works — which is the situation the guarantee exists for.
//
//   npx playwright install webkit
//   node scripts/check-sw.mjs

import { webkit } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

// Every file of the shell carries a generation tag, so the page can be asked
// which generation each of its parts came from.
// EXACTLY the coupled shell from sw.js. sports.js was missing from this list,
// so the one file most likely to be edited on its own was the one file this
// test never checked was part of the generation.
const SHELL = ['index.html', 'styles.css', 'flights.css', 'flights.js',
  'kinetics.js', 'vehicles.js', 'util.js', 'calendar.js', 'settings.js', 'minyanim.js',
  'weather.js', 'sports.js', 'display.js', 'app.js'];

let generation = 'A';
// Requests the server should refuse, to stand in for a network that is up but
// not reliably so.
let blocked = [];
let served = [];

function tag(path, body) {
  const mark = `GEN:${generation}`;
  if (path.endsWith('.html')) return body.replace('<head>', `<head><!-- ${mark} -->`);
  if (path.endsWith('.css')) return `/* ${mark} */\n${body}`;
  if (path.endsWith('.js')) return `/* ${mark} */\n${body}`;
  return body;
}

const server = createServer(async (req, res) => {
  let path = decodeURIComponent(req.url.split('?')[0]).replace(/^\//, '');
  if (path === '') path = 'index.html';
  served.push(path);

  if (blocked.some((b) => path.endsWith(b))) {
    res.writeHead(503).end('nope');
    return;
  }
  try {
    let body = await readFile(join(ROOT, path), 'utf8').catch(async () =>
      (await readFile(join(ROOT, path))).toString('binary'));
    // The worker's VERSION is what identifies a generation, so the two test
    // generations must differ in it exactly as two real deploys would.
    if (path === 'sw.js') body = body.replace(/^const VERSION = '[^']*';/m, `const VERSION = 'gen-${generation}';`);
    else if (SHELL.includes(path)) body = tag(path, body);
    res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'text/plain', 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404).end('no');
  }
});

let pass = 0;
let fail = 0;
const ok = (cond, msg, extra = '') => {
  if (cond) { pass += 1; console.log('  PASS', msg); }
  else { fail += 1; console.log('  FAIL', msg, extra); }
};

/* THE LISTS THAT HAVE TO AGREE ------------------------------------------- */
//
// The shell is written down in three places — sw.js precaches it, sw.js couples
// it, and this file asserts on it — and index.html is what actually loads it.
// Every one of them is edited by hand, and a file added to the page and left
// out of one list fails in a way none of the runtime checks can see: it is
// simply fetched from the network, outside the generation, and the atomic
// promise quietly stops covering it. kinetics.js and vehicles.js arrived that
// way and had to be added to all three by hand.
//
// Not consolidated into one shared file on purpose: sw.js is a worker that must
// know its shell before it can fetch anything, and reading the list over the
// network first would put a request in front of the atomic addAll that the
// whole model rests on. Kept in three places and checked to be the same.
{
  const sw = await readFile(join(ROOT, 'sw.js'), 'utf8');
  const html = await readFile(join(ROOT, 'index.html'), 'utf8');
  const list = (name) => {
    const m = new RegExp(`const ${name} = \\[([\\s\\S]*?)\\]`).exec(sw);
    return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [];
  };
  const APP = list('APP');
  const FILES = list('FILES').flatMap((f) => (f === '...APP' ? APP : [f]));
  // FILES splices APP in with a spread, which the quote scan above cannot see.
  const precached = new Set([...FILES, ...APP]);
  const coupledSrc = /const COUPLED = new RegExp\(`\/\(\$\{\[([\s\S]*?)\]/.exec(sw);
  const coupled = new Set([
    ...APP,
    ...(coupledSrc ? [...coupledSrc[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : []),
  ]);

  // What the page actually loads, minus the vendored library, which is third
  // party and versioned by its filename rather than by our generation.
  const loaded = [
    ...[...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]),
    ...[...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)].map((m) => m[1]),
    ...[...html.matchAll(/<link[^>]+href="([^"]+)"[^>]+rel="stylesheet"/g)].map((m) => m[1]),
  ].filter((f) => !/^https?:/.test(f));

  const missing = loaded.filter((f) => !precached.has(f));
  ok(!missing.length, `every file index.html loads is precached (${missing.join(', ') || 'all of them'})`);

  const ours = loaded.filter((f) => !f.startsWith('vendor/'));
  const uncoupled = ours.filter((f) => !coupled.has(f));
  ok(!uncoupled.length,
    `and every one of ours moves with the generation (${uncoupled.join(', ') || 'all of them'})`);

  const want = [...coupled].filter((f) => f !== 'index.html').sort();
  const have = [...SHELL].filter((f) => f !== 'index.html').sort();
  const drift = [
    ...want.filter((f) => !have.includes(f)).map((f) => `+${f}`),
    ...have.filter((f) => !want.includes(f)).map((f) => `-${f}`),
  ];
  ok(!drift.length, `and this suite checks exactly that set (${drift.join(' ') || 'no drift'})`);
}

// Asks the PAGE which generation each shell file came from. Fetching from the
// page means the request goes through the worker, which is the thing under test.
const GENS = (files) => Promise.all(files.map(async (f) => {
  try {
    const res = await fetch(f, { cache: 'no-store' });
    const text = await res.text();
    const m = /GEN:([A-Z])/.exec(text);
    return [f, m ? m[1] : '?'];
  } catch { return [f, 'x']; }
}));

await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const url = `http://127.0.0.1:${port}/index.html`;

const browser = await webkit.launch();
const context = await browser.newContext({ serviceWorkers: 'allow' });
const page = await context.newPage();
// Third-party APIs are not part of this and must not make the test flaky.
await page.route('**/api.open-meteo.com/**', (r) => r.abort());
await page.route('**site.api.espn.com**', (r) => r.abort());

console.log('=== Generation A installs ===');
await page.goto(url, { waitUntil: 'load' });
await page.evaluate(() => navigator.serviceWorker.ready);
await page.waitForTimeout(1500);
await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(800);

let gens = await page.evaluate(GENS, SHELL);
let values = new Set(gens.map(([, g]) => g));
ok(values.size === 1 && values.has('A'),
  `every file of the shell is generation A (${[...values].join(', ')})`,
  JSON.stringify(gens.filter(([, g]) => g !== 'A')));

console.log('\n=== Generation B is published, but the network only half works ===');
generation = 'B';
// sw.js and index.html get through; several scripts and the stylesheet do not.
// Under the old network-first model this is exactly the shape that produced a
// page built from both.
blocked = ['calendar.js', 'display.js', 'styles.css', 'weather.js'];
served = [];

await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(2000);

gens = await page.evaluate(GENS, SHELL);
values = new Set(gens.map(([, g]) => g));
ok(values.size === 1,
  `the shell is all one generation, not a mixture (${[...values].join(', ')})`,
  JSON.stringify(gens));
ok(values.has('A'),
  'and it is still A, because B could not install completely');

console.log('\n=== The network recovers ===');
blocked = [];
await page.reload({ waitUntil: 'load' });
await page.evaluate(() => navigator.serviceWorker.ready);
await page.waitForTimeout(2000);
await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(1000);

gens = await page.evaluate(GENS, SHELL);
values = new Set(gens.map(([, g]) => g));
ok(values.size === 1, `still one generation (${[...values].join(', ')})`, JSON.stringify(gens));
ok(values.has('B'), 'and now it is B, taken whole');

console.log('\n=== The page still works on the new generation ===');
const live = await page.evaluate(() => ({
  clock: document.getElementById('clockTime')?.textContent ?? '',
  cards: document.querySelectorAll('.card').length,
}));
ok(/^\d{1,2}:\d{2}$/.test(live.clock), `the clock is on the wall (${live.clock})`);
ok(live.cards > 0, `and the board rendered (${live.cards} cards)`);

await browser.close();
server.close();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
