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
const SHELL = ['index.html', 'styles.css', 'flights.css', 'flights.js',
  'util.js', 'calendar.js', 'settings.js', 'minyanim.js', 'weather.js',
  'display.js', 'app.js'];

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
// The forecast is not part of this and must not make the test flaky.
await page.route('**/api.open-meteo.com/**', (r) => r.abort());

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
