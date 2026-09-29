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
  // Kept so the wait can stop the world on the frame it approved of, and start
  // it again for the next vehicle. flights.js calls the bare global once per
  // frame, so replacing it ends the loop where it stands.
  window.__raf = window.requestAnimationFrame.bind(window);
});
await page.goto(`http://127.0.0.1:${server.address().port}/index.html`, { waitUntil: 'load' });
await page.waitForTimeout(1400);

const names = want.length ? want : await page.evaluate(() => window.shabbosFlights.names());

// Clear the stage: the previous vehicle, its leavings, and any pan.
const reset = (face) => page.evaluate((f) => {
  window.requestAnimationFrame = window.__raf;
  const fw = document.querySelector('.flyway');
  if (fw) { fw.style.transform = ''; fw.style.overflow = ''; }
  const scr = document.getElementById('screen');
  if (scr) scr.style.overflow = '';
  document.querySelectorAll('.card,.weather,.topline,.footer,.horizon').forEach((n) => { n.style.visibility = 'hidden'; });
  document.querySelectorAll('.flight').forEach((n) => n.remove());
  // The world layer outlives any one flight by design — smoke belongs to the
  // air, and the track stays put while the train crosses it. That is right in
  // life and wrong in a reference render, where the previous vehicle's leavings
  // would appear in the next one's portrait.
  document.querySelectorAll('.flyway .puffs > *, .flyway .rails > *').forEach((n) => n.remove());
  window.__face = `data:image/svg+xml;base64,${btoa(f)}`;
}, face);

const send = (name, rare = false) => page.evaluate(({ n, rare: r }) => {
  window.__sent = performance.now();
  window.shabbosFlights.send(n, r ? { rare: true } : undefined);
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
}, { n: name, rare });

// Wait for a frame worth photographing, then STOP THE WORLD on that frame. A
// screenshot costs a couple of hundred milliseconds, which for the rocket is
// most of the screen: its portrait came back as an exhaust column with nothing
// on the end of it, because it had climbed out of the top of the frame between
// the test passing and the shutter opening.
//
// `strict` wants the whole vehicle in the frame. Most of them manage it and
// their portraits are then the screen exactly as it is. The rocket never does —
// it climbs at 82% of the width and grows past the 180 px it has to its right
// as it tilts — so it gets a second run under the loose test, and a pan.
const settle = (name, strict, rare = false) => page.waitForFunction(({ n, strict: hard, rare: wantMoment }) => {
  const el = document.querySelector(`.flight.${n}`);
  if (!el) return false;
  const b = el.getBoundingClientRect();
  if (!b.width) return false;
  // Not in its first second and a bit. update() is skipped on frame one — there
  // is no previous sample to difference — so a vehicle photographed the instant
  // it appears is a pile of undriven parts: the rotor a straight bar across its
  // disc, the prop a stick, nothing yet where its motion puts it. Long enough,
  // too, for what a vehicle LEAVES BEHIND to exist: a dancer drops a note about
  // twice a second, and a portrait taken before the first one has no wake.
  // The loose pass waits longer: it is there for the vehicles that are only
  // ever partly in frame, and those are the fast ones, whose wake is the other
  // half of the picture. A rocket photographed at 1.2 s has a stub of exhaust.
  if (performance.now() - window.__sent < (hard ? 1200 : 2000)) return false;
  // Strict: all of it inside, on each axis where it fits. Loose: anywhere on
  // screen at all, because a pan follows and will put it in the middle. Asking
  // a loose frame to be CENTRED is asking the same impossible thing again —
  // the rocket's lane is at 82% of the width, so its centre is never near the
  // middle of the screen and that test simply never fired.
  const span = (lo, hi, size, limit) => (hard
    ? size >= limit - 40 || (lo > -16 && hi < limit + 16)
    : hi > 0 && lo < limit);
  // A light that only comes on part of the time is the point of the vehicle it
  // is on — the balloon's burner is what a balloon does at night, the car's
  // horn is two blasts of a tenth of a second — and a portrait taken between
  // them shows a vehicle that does not do the thing it is here to do.
  for (const sel of wantMoment ? ['.inner', '.honk'] : ['.inner']) {
    const lit = el.querySelector(sel);
    if (lit && Number(getComputedStyle(lit).opacity) < 0.3) return false;
  }
  // update() sets this while the rare moment is actually on the screen. Given
  // a moment or two to develop: frozen on the frame the flag went up, a jet of
  // steam is four small circles at the whistle and a loop has not yet bent.
  // Not much longer than that, though — a dropped sandbag falls at 520 px/s²
  // and is off the bottom of the frame in half a second.
  if (wantMoment) {
    if (!el.dataset.moment) { window.__moment = 0; return false; }
    window.__moment = window.__moment || performance.now();
    if (performance.now() - window.__moment < 200) return false;
  }
  const good = span(b.left, b.right, b.width, innerWidth)
    && span(b.top, b.bottom, b.height, innerHeight);
  if (good) window.requestAnimationFrame = () => 0;
  return good;
}, { n: name, strict, rare }, { timeout: strict ? 14000 : 20000 }).then(() => true, () => false);

// Pan to what could not fit, by moving the whole flyway rather than the
// vehicle. Smoke, exhaust, the sea and the track are world-space siblings of
// the flight inside that layer, so they travel with it. Moving the vehicle
// alone would leave its own wake behind, pointing at where it used to be.
const panTo = (name) => page.evaluate((n) => {
  const el = document.querySelector(`.flight.${n}`);
  const fw = document.querySelector('.flyway');
  if (!el || !fw) return;
  const b = el.getBoundingClientRect();
  const pan = (lo, hi, limit) => (lo > -8 && hi < limit + 8 ? 0 : limit / 2 - (lo + hi) / 2);
  // The layer clips to the screen, and the clip travels with the layer: pan it
  // 500 px right and the vehicle arrives in the middle of the frame with its
  // own left edge cut off, which is how the helicopter's portrait came back as
  // a sliver of tail fin on an empty sky.
  fw.style.overflow = 'visible';
  const scr = document.getElementById('screen');
  if (scr) scr.style.overflow = 'visible';
  fw.style.transform = `translate(${Math.round(pan(b.left, b.right, innerWidth))}px, `
    + `${Math.round(pan(b.top, b.bottom, innerHeight))}px)`;
}, name);

// Which vehicles have a rare moment, asked of the definitions rather than
// listed here: a sixth one added later gets its portrait without this knowing.
const rareKinds = new Set(await page.evaluate(
  () => window.shabbosFlights.names().filter((n) => window.shabbosFlights.spec(n).moment),
));

const shoot = async (name, file, rare) => {
  await reset(FACE);
  await send(name, rare);
  let framed = await settle(name, true, rare);
  if (!framed) {
    await reset(FACE);
    await send(name, rare);
    framed = await settle(name, false, rare);
    await panTo(name);
  }
  await page.screenshot({ path: join(OUT, `${file}.png`) });
  await page.evaluate(() => { document.documentElement.style.filter = 'blur(3px)'; });
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(OUT, `${file}-room.png`) });
  await page.evaluate(() => { document.documentElement.style.filter = ''; });
  console.log(`  ${file}${framed ? '' : ' (never framed)'}`);
};

for (const name of names) {
  await shoot(name, name, false);
  // The one flight in fifteen gets its own portrait: nobody can review a moment
  // by waiting for it to come round.
  if (rareKinds.has(name)) await shoot(name, `${name}-rare`, true);
}
await browser.close();
server.close();
