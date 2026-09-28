/* Kinetics: the motion maths for family flights, and nothing else.
 *
 * Pure functions, no DOM. Ported from the prototypes in reference/, where each
 * one was rendered and looked at before it was written here. flights.js and
 * vehicles.js call these; tests call them directly.
 *
 * Classic script, like the rest of the app (jsdom cannot load modules).
 */
(() => {
  'use strict';

  // rAF stops while the tab is hidden and resumes with one enormous dt. A spring
  // stepped with dt = 40s does not settle, it explodes. Everything that
  // integrates takes its dt through this.
  const MAX_DT = 1 / 20;
  const clampDt = (dt) => Math.max(0, Math.min(dt, MAX_DT));

  // Damped spring toward a target. Attitude (pitch, lean, sway) goes through
  // this so it lags the motion and settles instead of snapping to it.
  // Defaults are just under critical damping: one small overshoot, then still.
  function spring(state, target, dt, k = 60, c = 12) {
    const h = clampDt(dt);
    const v = state.v + (k * (target - state.x) - c * state.v) * h;
    return { x: state.x + v * h, v };
  }

  // The sea: three travelling waves with incommensurate wavelengths AND speeds,
  // so the surface never repeats and never slides as one piece. Amplitudes in
  // px at 1024 wide; callers scale.
  const WAVES = [
    { amp: 9.0, len: 173, speed: 1.9, phase: 0 },
    { amp: 5.0, len: 97, speed: -1.3, phase: 1.1 },
    { amp: 2.6, len: 61, speed: 3.1, phase: 2.3 },
  ];
  const SEA_AMP = WAVES.reduce((s, w) => s + w.amp, 0);

  function sea(x, t, scale = 1) {
    let y = 0;
    for (const w of WAVES) y += w.amp * Math.sin((2 * Math.PI * x) / (w.len * scale) + w.speed * t + w.phase);
    return y * scale;
  }

  // An SVG path along the surface, for the band drawn under the boat.
  function seaPath(x0, x1, y0, t, scale = 1, step = 6, shift = 0) {
    let d = '';
    for (let x = x0; x <= x1 + step; x += step) {
      d += `${d ? ' L' : 'M'}${x.toFixed(1)} ${(y0 + sea(x + shift, t, scale)).toFixed(1)}`;
    }
    return d;
  }

  // Where a hull wants to sit: heave is the mean of the water under its two
  // ends, tilt is the slope between them. Feed both through spring().
  //
  // Measured left end to right end in SCREEN space, whichever way the boat is
  // heading. Measuring stern to bow gave atan2(dy, -length) for a boat going
  // left, which is about 180 degrees: the hull rendered upside down.
  function hullTarget(x, t, length, y0, scale = 1) {
    const yl = y0 + sea(x - length / 2, t, scale);
    const yr = y0 + sea(x + length / 2, t, scale);
    return { y: (yl + yr) / 2, rot: (Math.atan2(yr - yl, length) * 180) / Math.PI };
  }

  // Wheels roll exactly as far as the vehicle travels. Radians, clockwise
  // positive for rightward travel (SVG rotate is clockwise).
  const wheelAngle = (distance, radius) => distance / radius;

  // Exhaust beats crossed between two wheel angles. A two-cylinder steam engine
  // exhausts four times per turn of the driving wheels.
  function beats(prevAngle, angle, perRev = 4) {
    const q = (2 * Math.PI) / perRev;
    return Math.max(0, Math.floor(angle / q) - Math.floor(prevAngle / q));
  }

  // Speed that looks ahead: brake before a bend, hold through it, power out.
  // `bends` is a list of [start, end] in path distance. Returns the target
  // speed; stepSpeed() moves toward it within real limits.
  function speedTarget(s, v, bends, vmax, vbend, lookahead = 0.9) {
    const ahead = s + v * lookahead;
    for (const [a, b] of bends) if (ahead > a - 20 && s < b) return vbend;
    return vmax;
  }

  function stepSpeed(v, target, dt, accel = 160, brake = 260) {
    const h = clampDt(dt);
    const want = (target - v) * 3;
    const a = Math.max(-brake, Math.min(accel, want));
    return { v: v + a * h, a };
  }

  // Lean out of a bend is proportional to lateral acceleration, v^2 / r.
  const lateral = (v, r) => (r > 0 ? (v * v) / r : 0);

  // World-space particles: smoke, exhaust, spray, notes. Once emitted they
  // belong to the air, not the vehicle, so they are left behind as it moves,
  // which is most of what makes speed visible. Hard-capped: a parade puts ten
  // emitters on screen at once on an iPad.
  function particles(max = 40) {
    const list = [];
    return {
      list,
      emit(p) {
        if (list.length >= max) list.shift();
        list.push({ x: 0, y: 0, vx: 0, vy: 0, age: 0, life: 1, size: 1, ...p });
      },
      step(dt, { drag = 0.97, gravity = 0 } = {}) {
        const h = clampDt(dt);
        for (const p of list) {
          p.vy += gravity * h;
          p.vx *= drag; p.vy *= drag;
          p.x += p.vx * h; p.y += p.vy * h;
          p.age += h;
        }
        for (let i = list.length - 1; i >= 0; i -= 1) if (list[i].age >= list[i].life) list.splice(i, 1);
        return list;
      },
    };
  }

  globalThis.shabbosKinetics = {
    MAX_DT, clampDt, spring, sea, SEA_AMP, seaPath, hullTarget,
    wheelAngle, beats, speedTarget, stepSpeed, lateral, particles,
  };
})();
