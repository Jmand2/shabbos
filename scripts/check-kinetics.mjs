// Checks the motion maths in kinetics.js. No DOM, no browser.
//   node scripts/check-kinetics.mjs
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

vm.runInThisContext(readFileSync(new URL('../kinetics.js', import.meta.url), 'utf8'));
const K = globalThis.shabbosKinetics;

let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? '  ok  ' : '  FAIL'} ${msg}`); if (!cond) fails += 1; };
const DT = 1 / 60;

// Spring: settles, barely overshoots, and survives a hidden tab.
{
  let s = { x: 0, v: 0 }; let peak = 0;
  for (let i = 0; i < 60; i += 1) { s = K.spring(s, 10, DT); peak = Math.max(peak, s.x); }
  ok(Math.abs(s.x - 10) < 0.3, `spring settles within a second (at ${s.x.toFixed(2)} of 10)`);
  ok(peak < 11, `spring overshoots less than 10% (peak ${peak.toFixed(2)})`);
  const after = K.spring({ x: 0, v: 0 }, 10, 40);
  ok(Math.abs(after.x) < 10 && Number.isFinite(after.v), 'a 40 s gap (hidden tab) is clamped, not integrated');
}

// Sea: bounded, moving, and not one shape sliding along.
{
  let max = 0;
  for (let x = 0; x < 2000; x += 7) for (let t = 0; t < 20; t += 0.37) max = Math.max(max, Math.abs(K.sea(x, t)));
  ok(max <= K.SEA_AMP + 1e-9, `sea stays within its amplitude (${max.toFixed(1)} <= ${K.SEA_AMP})`);
  ok(K.sea(300, 0) !== K.sea(300, 0.5), 'sea changes over time');
  // A sliding stamp satisfies sea(x, t) == sea(x - c t, 0) for some speed c.
  // Three waves at three speeds cannot.
  let best = Infinity;
  for (let c = -200; c <= 200; c += 1) {
    let err = 0;
    for (let x = 0; x < 600; x += 10) err += Math.abs(K.sea(x, 1) - K.sea(x - c, 0));
    best = Math.min(best, err / 60);
  }
  ok(best > 1, `no single sliding speed reproduces the sea (closest mean error ${best.toFixed(2)} px)`);
}

// Hull: pitches toward the higher end, and follows the water.
{
  let worst = 0;
  for (let x = 0; x < 1100; x += 13) for (let t = 0; t < 10; t += 0.41) worst = Math.max(worst, Math.abs(K.hullTarget(x, t, 80, 150).rot));
  ok(worst < 30, `hull tilts, never flips, anywhere on the sea (worst ${worst.toFixed(1)} deg)`);
}

// Rolling and exhaust beats.
ok(Math.abs(K.wheelAngle(2 * Math.PI * 15, 15) - 2 * Math.PI) < 1e-9, 'a wheel turns once per circumference travelled');
{
  // Stepped to EXACTLY one turn: stepping by 0.05 stops at 6.25, short of it.
  let n = 0; let prev = 0;
  for (let i = 1; i <= 200; i += 1) { const a = (i / 200) * 2 * Math.PI; n += K.beats(prev, a); prev = a; }
  ok(n === 4, `four exhaust beats per turn (got ${n})`);
}

// Car speed: brakes before the bend, not on the straight after it.
{
  const bends = [[300, 450]];
  ok(K.speedTarget(100, 150, bends, 150, 70) === 150, 'full speed well before the bend');
  ok(K.speedTarget(200, 150, bends, 150, 70) === 70, 'already braking as the bend comes into view');
  ok(K.speedTarget(500, 150, bends, 150, 70) === 150, 'powers out once past it');
  let v = 150; let s = 0; let minInBend = Infinity;
  for (let i = 0; i < 600 && s < 700; i += 1) {
    v = K.stepSpeed(v, K.speedTarget(s, v, bends, 150, 70), DT).v;
    s += v * DT;
    if (s > 300 && s < 450) minInBend = Math.min(minInBend, v);
  }
  ok(minInBend < 90, `slow through the bend (min ${minInBend.toFixed(0)} px/s)`);
}

// Particles: capped, age out, and stay where they were released.
{
  const p = K.particles(10);
  for (let i = 0; i < 25; i += 1) p.emit({ x: 5, y: 5, life: 0.5 });
  ok(p.list.length === 10, `particle cap holds (${p.list.length} of 10)`);
  for (let i = 0; i < 60; i += 1) p.step(DT);
  ok(p.list.length === 0, 'particles age out');
  const q = K.particles(4);
  q.emit({ x: 100, y: 100, vx: 0, vy: -50, life: 2 });
  for (let i = 0; i < 30; i += 1) q.step(DT);
  ok(q.list[0].x === 100 && q.list[0].y < 100, 'a released particle keeps its own x: it is left behind');
}

console.log(fails ? `\n${fails} failed` : '\nall kinetics checks pass');
process.exitCode = fails ? 1 : 0;
