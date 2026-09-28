// Reference renders of the vehicles, sharp and blurred to viewing distance.
//   node scripts/render-vehicles.mjs [name ...]
//
// The blurred pair is the room test: an iPad at ~1024 px across ~20 cm, seen
// from 4 m, resolves about 6 px. Anything that disappears under a 3 px blur is
// detail that cost nodes and bought nothing — and anything that stops reading
// as a face, or as its kind of vehicle, is a redraw that has failed its job.
//
// Faces are encrypted and JJ owns the passphrase, so these use a placeholder
// crop of the same size and shape the real ones occupy.
import { webkit } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'screenshots', 'vehicles');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };

const server = createServer(async (req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]).replace(/^\//, '') || 'index.html';
  try {
    const body = await readFile(join(ROOT, p));
    res.writeHead(200, { 'content-type': TYPES[extname(p)] ?? 'text/plain' });
    res.end(body);
  } catch { res.writeHead(404).end('no'); }
});
await new Promise((r) => server.listen(0, r));
await mkdir(OUT, { recursive: true });

const FACE = `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80">
  <circle cx="40" cy="40" r="40" fill="#e7b89a"/>
  <path d="M0 38 a40 40 0 0 1 80 0 q-40 -20 -80 0z" fill="#5a3b2a"/>
  <circle cx="26" cy="42" r="4" fill="#2a1d18"/><circle cx="54" cy="42" r="4" fill="#2a1d18"/>
  <path d="M26 56 q14 12 28 0" stroke="#7a3b30" stroke-width="4" fill="none"/></svg>`;

const browser = await webkit.launch();
const want = process.argv.slice(2);
const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
await page.route('**site.api.espn.com**', (r) => r.abort());
await page.route('**/api.open-meteo.com/**', (r) => r.abort());
// Night, set the way the app sets it. Stripping body.day by hand did not hold:
// render() reapplies the theme class on every tick, so the next frame undid it
// and the references came back on a white wall — which is the one lighting the
// lamps and burners are explicitly NOT for.
await page.addInitScript(() => {
  localStorage.setItem('shabbos-clock-settings', JSON.stringify({ theme: 'night' }));
});
await page.goto(`http://127.0.0.1:${server.address().port}/index.html`, { waitUntil: 'load' });
await page.waitForTimeout(1400);

const names = want.length ? want : await page.evaluate(() => window.shabbosFlights.names());
for (const name of names) {
  await page.evaluate((face) => {
    document.querySelectorAll('.card,.weather,.topline,.footer,.horizon').forEach((n) => { n.style.visibility = 'hidden'; });
    document.querySelectorAll('.flight').forEach((n) => n.remove());
    // The world layer outlives any one flight by design — smoke belongs to the
    // air, and the track stays put while the train crosses it. That is right in
    // life and wrong in a reference render, where the previous vehicle's
    // leavings would appear in the next one's portrait.
    document.querySelectorAll('.flyway .puffs > *, .flyway .rails > *').forEach((n) => n.remove());
    window.__face = `data:image/svg+xml;base64,${btoa(face)}`;
  }, FACE);
  await page.evaluate((n) => {
    window.shabbosFlights.send(n);
    // Faces on at once, not after the wait: the rocket climbs about 490 px a
    // second, so half a second spent dressing it is half the screen, and it had
    // left before the shutter.
    const f = document.querySelector(`.flight.${n}`);
    if (!f) return;
    const v = window.shabbosFlights.spec(n);
    const [vw, vh] = v.vb;
    const rings = ['#E8C547', '#5FC9A0', '#D98CC8', '#F5A25D'];
    v.slots.forEach(([cx, cy, r], i) => {
      const R = r * 2.1;
      const img = document.createElement('img');
      img.src = window.__face;
      img.style.cssText = `left:${(cx - R) / vw * 100}%;top:${(cy - R) / vh * 100}%;`
        + `width:${R * 2 / vw * 100}%;height:${R * 2 / vh * 100}%;border-color:${rings[i % 4]}`;
      f.appendChild(img);
    });
  }, name);
  // Wait for it to be ON SCREEN rather than for a fixed moment. Lanes differ by
  // a factor of five in speed and the hover lane eases in slowly, so a single
  // delay caught some vehicles mid-entrance and others already leaving.
  await page.waitForFunction((n) => {
    const el = document.querySelector(`.flight.${n}`);
    if (!el) return false;
    const b = el.getBoundingClientRect();
    if (!b.width) return false;
    const cx = b.left + b.width / 2;
    const cy = b.top + b.height / 2;
    // Wide, because several lanes deliberately keep OUT of the middle: the
    // rocket, balloon and parachute go up one side or the other at 18% or 82%
    // of the width, which a centre-band predicate never matches at all.
    return cx > innerWidth * 0.06 && cx < innerWidth * 0.94
      && cy > innerHeight * 0.08 && cy < innerHeight * 0.92;
  }, name, { timeout: 20000 }).catch(() => {});
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  await page.evaluate(() => { document.documentElement.style.filter = 'blur(3px)'; });
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(OUT, `${name}-room.png`) });
  await page.evaluate(() => { document.documentElement.style.filter = ''; });
  console.log(`  ${name}`);
}
await browser.close();
server.close();
