/* Family flights — self-contained.
 *
 * Every few minutes a vehicle crosses the screen carrying family faces. Photos
 * live in the repo encrypted; the passphrase is entered once on this iPad and
 * only the derived key is kept, non-extractable, in IndexedDB.
 *
 * Attaches to nothing in app.js. It owns its own layer, its own localStorage
 * key, and injects its own settings block. Load it after app.js.
 */
(() => {
  'use strict';

  const STORE = 'shabbos-flights';
  const FACE_DB = 'shabbos-clock-faces';
  const KEY_ID = 'face-key';
  // A RANGE of minutes, not a mean: each gap is drawn uniformly between the two
  // bounds. Stating it as a range is also the honest label — the gap has been
  // random since it stopped being a fixed interval, so "every 10 min" was never
  // what happened.
  const DEFAULTS = { every: '2-5', hourly: 'on' };
  const EVERY = ['off', '2-5', '5-10', '10-20', '20-40', '45-90'];
  const HOURLY = ['on', 'off'];

  let settings = { ...DEFAULTS, ...read(STORE) };
  // A value saved by an older build is not in the list any more. Without this
  // the menu shows blank and the schedule runs on a stale number that no option
  // corresponds to.
  if (!EVERY.includes(String(settings.every))) settings.every = DEFAULTS.every;
  if (!HOURLY.includes(String(settings.hourly))) settings.hourly = DEFAULTS.hourly;
  let faces = [];
  // What the last load actually managed, for the status panel.
  let loadReport = null;
  let layer = null;
  let timer = null;
  let hourTimer = null;

  function read(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }
  const save = () => localStorage.setItem(STORE, JSON.stringify(settings));
  const reduced = () => typeof matchMedia === 'function'
    && matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* Faces ---------------------------------------------------------------- */

  function idbGo(mode, fn) {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(FACE_DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('keys');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const tx = req.result.transaction('keys', mode);
        const r = fn(tx.objectStore('keys'));
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      };
    });
  }

  const unhex = (h) => Uint8Array.from(h.match(/../g).map((b) => parseInt(b, 16)));

  async function deriveKey(pass, salt, iterations) {
    const base = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey'],
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['decrypt'],
    );
  }

  const openBlob = async (key, buf) => {
    const d = new Uint8Array(buf);
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv: d.subarray(0, 12) }, key, d.subarray(12));
  };

  async function loadFaces(key) {
    const m = await fetch('faces/manifest.json').then((r) => r.json());
    const k = key ?? await idbGo('readonly', (s) => s.get(KEY_ID)).catch(() => null);
    if (!k || !m.faces?.length) return [];
    // Each face independently. One unreachable file or one failed decrypt used
    // to reject the whole function, the caller caught it, and every face
    // vanished — so a single wifi hiccup at startup meant no photos at all until
    // the next reload. Twenty of twenty-one is a rounding error; nought of
    // twenty-one is the feature being gone.
    const out = [];
    let lost = 0;
    for (const f of m.faces) {
      try {
        const buf = await fetch(`faces/${f.file}`).then((r) => r.arrayBuffer());
        const plain = await openBlob(k, buf);
        // The type the crop actually was. Faces encrypted before the manifest
        // carried one are jpegs, which is what the old hard-coded value assumed.
        const type = f.type ?? 'image/jpeg';
        out.push({ ring: f.ring, url: URL.createObjectURL(new Blob([plain], { type })) });
      } catch { lost += 1; }
    }
    loadReport = { got: out.length, of: m.faces.length, lost };
    return out;
  }

  // Probes a real file before storing, so a wrong passphrase reports itself
  // instead of silently saving a key that decrypts nothing.
  async function unlock(pass) {
    const m = await fetch('faces/manifest.json').then((r) => r.json());
    if (!m.faces?.length) return { ok: false, why: 'no faces in the repo yet' };
    const key = await deriveKey(pass, unhex(m.salt), m.iterations);
    try {
      await openBlob(key, await fetch(`faces/${m.faces[0].file}`).then((r) => r.arrayBuffer()));
    } catch {
      return { ok: false, why: 'that passphrase does not match these files' };
    }
    await idbGo('readwrite', (s) => s.put(key, KEY_ID));
    faces.forEach((f) => URL.revokeObjectURL(f.url));
    faces = await loadFaces(key);
    return { ok: true, count: faces.length };
  }

  /* Vehicles -------------------------------------------------------------- */
  // Every path and duration here was plotted before it was written. Durations
  // are derived from measured distance at a target px/s, so the character holds
  // at any screen size or orientation.
  // slots are [cx, cy, r] in viewBox units.

  // Faces were 20-38px on a 1024-wide screen, which is nothing across a room.
  // They are now drawn well outside their seat and cover part of the vehicle —
  // the face is the point, the vehicle is only the frame. The one thing that
  // still bounds them is each other: a face never grows past this share of the
  // gap to the next seat, or a full train would be one smear.
  const FACE = 2.1;
  const NEIGHBOUR = 0.62;

  // Per-vehicle size. A flat scale made the long ones — plane, train — 2.3x the
  // width of the compact ones, so a parachute or a car read as an afterthought
  // beside them. These even the footprints out by lifting the small ones rather
  // than shrinking the large, since bigger is the point.
  const SIZE = {
    // The train is drawn at its natural size now — a locomotive and three
    // carriages measured in the same units as a 72 px face — so it needs far
    // less multiplying than a four-face sketch did.
    plane: 1, train: 0.56, helicopter: 1.2, boat: 1.35,
    // The car grew a proper body around a sitting-up driver, so it needs less
    // multiplying to reach the same size on the wall.
    balloon: 1.4, rocket: 1.35, parachute: 1.5, car: 1.25,
  };

  // One formula for how big a vehicle flies, used by fly() AND by the checks,
  // so a test measures the real thing rather than a copy of it. The gates in
  // check-vehicles.mjs turn on face diameter and stroke width AT SCREEN SIZE,
  // and a second copy of this arithmetic would let the artwork drift under a
  // suite that went on passing.
  const scaleFor = (name, W) => Math.min(1, W / 1024) * 1.8 * (SIZE[name] ?? 1);

  function faceRadius(v, i) {
    const [cx, cy, r] = v.slots[i];
    let gap = Infinity;
    v.slots.forEach(([ox, oy], j) => {
      if (j !== i) gap = Math.min(gap, Math.hypot(ox - cx, oy - cy));
    });
    return Math.min(r * FACE, gap * NEIGHBOUR);
  }

  // The artwork and rigging live in vehicles.js. flights.js keeps scheduling,
  // faces, paths, the parade and the frame loop; a vehicle keeps what it looks
  // like and how its own parts move. The split is what lets check-vehicles
  // reason about artwork without booting the whole module.
  const { VEHICLES, DEFS, RAIL: RAIL_UNITS } = globalThis.shabbosVehicles;
  const K = globalThis.shabbosKinetics;


  /* Paths ----------------------------------------------------------------- */
  // p is 0..1 of the journey. Returns position in px plus rotation.

  // THE CIRCUIT, worked out once and shared. The lane and LENGTH both need the
  // same numbers, and they disagreed: LENGTH measured a rectangle with square
  // corners while the lane drove one with rounded ones, so the car was given a
  // duration for a path 5.5% longer than the path it actually took — and ran
  // 5.5% under its speed for the whole lap.
  const lapShape = (v, W, H) => {
    const m = lapMargin(v);
    const w = W - m * 2;
    const h = H - m * 2;
    const r = Math.max(24, Math.min(w, h) * 0.16);
    const sw = w - 2 * r;
    const sh = h - 2 * r;
    const arc = (Math.PI * r) / 2;
    return { m, w, h, r, sw, sh, arc, per: 2 * (sw + sh) + 4 * arc };
  };

  // HOW FAR ROUND IT IS AT EACH POINT OF THE FLIGHT.
  //
  // LANES stays pure — same signature, same meaning — so the speed profile
  // cannot be integrated inside it. It is integrated ONCE per circuit shape and
  // cached, and the lane reads the answer off the table.
  //
  // The old easing was a sine that happened to be slowest at 12, 37, 62 and 87%
  // of the lap, while the corners are at 27, 47, 77 and 97: it braked on the
  // straights and accelerated into the bends. This brakes BEFORE a bend, holds
  // through it and powers out, because that is what speedTarget() is for.
  const lapTables = new Map();
  function lapTable(v, W, H) {
    const g = lapShape(v, W, H);
    const key = `${Math.round(g.per)}|${Math.round(g.r)}|${Math.round(g.sw)}|${Math.round(g.sh)}`;
    const hit = lapTables.get(key);
    if (hit) return hit;

    // The four arcs, in distance along the circuit.
    const bends = [];
    let at = g.sw;
    for (const straight of [g.sh, g.sw, g.sh]) {
      bends.push([at, at + g.arc]);
      at += g.arc + straight;
    }
    bends.push([at, at + g.arc]);

    // Integrated in REAL units — pixels and seconds — because that is what
    // speedTarget and stepSpeed are written in: the lookahead is 0.9 seconds of
    // travel and the braking limit is 260 px/s². Normalised afterwards, since
    // the flight's duration is already settled by LENGTH and the vehicle's own
    // speed; what is wanted here is the SHAPE of the journey, not its clock.
    //
    // A first version integrated with vmax = 1 and covered 166 px of a 3100 px
    // circuit before the iteration cap stopped it, so the car crept along the
    // opening straight and never reached a corner at all.
    const step = 1 / 120;
    const VMAX = 260;
    const samples = [0];
    let sp = VMAX;
    let dist = 0;
    for (let i = 0; i < 40000 && dist < g.per; i += 1) {
      sp = K.stepSpeed(sp, K.speedTarget(dist, sp, bends, VMAX, VMAX * 0.42), step).v;
      dist += sp * step;
      samples.push(Math.min(dist, g.per));
    }
    const table = { g, samples };
    lapTables.set(key, table);
    return table;
  }

  const LANES = {
    horizon: (p, v, W, H) => ({
      x: (v.dir > 0 ? -0.15 + p * 1.3 : 1.15 - p * 1.3) * W,
      // [4] The train and the boat both live here and travel towards each
      // other, so in a parade they met in the middle and drove through one
      // another. A lane offset separates them by a body's height: the outbound
      // one runs a little nearer, the inbound one a little further away, which
      // also reads as depth rather than as a dodge.
      y: H * (0.56 + (v.band ?? 0)),
      rot: 0,
    }),
    // ALONG THE BOTTOM, UPRIGHT. Its own comment said "across the bottom of the
    // screen" while its lane was the full lap — so it danced up the walls
    // sideways and crossed the top upside down. It also shared the circuit with
    // the car, which travels at 80 px/s against its 42 and caught it about two
    // and a half seconds after a parade launched them together.
    promenade: (p, v, W, H) => ({
      x: (v.dir > 0 ? -0.15 + p * 1.3 : 1.15 - p * 1.3) * W,
      y: H - lapMargin(v),
      rot: 0,
    }),
    upper: (p, v, W, H) => ({
      x: (-0.15 + p * 1.3) * W,
      // [4] Shared by the plane and the helicopter, offset the same way.
      y: H * (0.30 + (v.band ?? 0) + 0.05 * Math.sin(p * Math.PI * 2 * 1.3 + 0.4)),
      rot: 4 * Math.cos(p * Math.PI * 2 * 1.3 + 0.4),
    }),
    // Slow into the middle, hover, then away. Only vehicle that stops.
    hover: (p, v, W, H) => {
      const ease = (t) => 0.5 * (1 - Math.cos(Math.PI * Math.min(1, Math.max(0, t))));
      const d = ease((p - 0.12) / 0.28) * 0.42 + ease((p - 0.7) / 0.3) * 0.58;
      return { x: (-0.15 + d * 1.3) * W, y: H * 0.30, rot: 0 };
    },
    // A ROUNDED CIRCUIT, because a car does not pivot on the spot.
    //
    // This was four straight edges and the heading snapped 0 → -90 → 180 → 90
    // at each corner, in one frame. A car crossing the bottom of the screen
    // arrived at the right-hand edge and was instantly pointing upwards, which
    // is the one moment the eye is actually following it.
    //
    // The corners are quarter-arcs now and the heading sweeps through them with
    // the position, so it drives round. The rotation is kept DECREASING all the
    // way to -360 rather than wrapping through 180, because a wrap is a spin:
    // the shortest path from 179 to -179 is two degrees and CSS does not know
    // that, it would turn the long way.
    lap: (p, v, W, H) => {
      const { m, r, sw, sh, arc, per } = lapShape(v, W, H);

      // Still eases through the turns — a little slower into them, a little
      // quicker out — but gently, now that the corner has a shape.
      // Read off the profile rather than eased by a sine. CLAMPED, not wrapped:
      // a vehicle drives this circuit exactly once and is then removed, so
      // there is no second lap for a modulo to serve — and at p = 1 it wrapped
      // back to zero, which snapped the heading from -360 to 0 and spun the car
      // through a whole turn on its final frame.
      const tab = lapTable(v, W, H);
      const q = Math.max(0, Math.min(p, 0.99999)) * (tab.samples.length - 1);
      const lo = Math.floor(q);
      const frac = q - lo;
      const a0 = tab.samples[lo];
      const a1 = tab.samples[Math.min(lo + 1, tab.samples.length - 1)];
      let s = Math.min(a0 + (a1 - a0) * frac, per * 0.99999);

      // rot = theta - 90 on every corner, which is what makes the four of them
      // one expression instead of four.
      const corner = (cx, cy, from, t) => {
        const th = (from - 90 * t) * (Math.PI / 180);
        return { x: cx + r * Math.cos(th), y: cy + r * Math.sin(th), rot: (from - 90 * t) - 90 };
      };

      if (s < sw) return { x: m + r + s, y: H - m, rot: 0 };
      s -= sw;
      if (s < arc) return corner(W - m - r, H - m - r, 90, s / arc);
      s -= arc;
      if (s < sh) return { x: W - m, y: H - m - r - s, rot: -90 };
      s -= sh;
      if (s < arc) return corner(W - m - r, m + r, 0, s / arc);
      s -= arc;
      if (s < sw) return { x: W - m - r - s, y: m, rot: -180 };
      s -= sw;
      if (s < arc) return corner(m + r, m + r, -90, s / arc);
      s -= arc;
      if (s < sh) return { x: m, y: m + r + s, rot: -270 };
      return corner(m + r, H - m - r, -180, (s - sh) / arc);
    },
    // Glide, stall, tip, glide back. Two incommensurate sines, so no two falls
    // trace the same shape.
    leaf: (p, v, W, H) => {
      const th = p * Math.PI * 2 * 1.7;
      const sway = Math.sin(th) + 0.38 * Math.sin(2.3 * th + 0.7);
      const dx = Math.cos(th) + 0.874 * Math.cos(2.3 * th + 0.7);
      return {
        x: v.side * W + sway * W * 0.055,
        y: (p + 0.045 * Math.sin(2 * th)) * H * 1.2 - H * 0.12,
        rot: Math.max(-34, Math.min(34, dx * 20)),
      };
    },
    rise: (p, v, W, H) => {
      const th = p * Math.PI * 2;
      return {
        x: v.side * W + (34 * Math.sin(th * 0.8) + 12 * Math.sin(th * 2.1 + 1.2)) / 1000 * W,
        y: H * 1.15 - (p + 0.03 * Math.sin(p * Math.PI * 2 * 3)) * H * 1.3,
        rot: 4 * Math.sin(th * 1.3),
      };
    },
    // Slow off the pad, accelerating, arcing away from the middle.
    launch: (p, v, W, H) => {
      const e = p * p;
      return {
        x: v.side * W + (v.side < 0.5 ? -1 : 1) * 105 * e ** 1.45 / 1000 * W,
        y: H * 1.15 - e * H * 1.3,
        rot: (v.side < 0.5 ? -1 : 1) * 52 * e ** 1.3,
      };
    },
  };

  // How far the centre of a lapping vehicle must stay from the edge.
  //
  // This was a flat 26, written when the car artwork was 62px tall. Every
  // vehicle then got its own scale and the car's grew to 1.6 — 179px on screen
  // — so its centre ran 26px from each edge with 90px of car hanging off. It
  // spent its entire 48-second lap clipped and was never once fully visible,
  // while every other vehicle reached 100%. It is always oriented along its
  // path, so what has to clear the edge is half its HEIGHT, whichever edge it
  // is on.
  // The +30 is not slack for its own sake. Several vehicles draw outside their
  // declared viewBox — the car's wheels sit below its height, and every stroke
  // is centred on its path so half of it hangs beyond — and `overflow: visible`
  // means all of that paints. Half the box is not half the vehicle.
  const lapMargin = (v) => 30 + (v.vb[1] * (v.scale ?? 1)) / 2;

  const LENGTH = {
    horizon: (W, H) => W * 1.3, upper: (W, H) => W * 1.3, hover: (W, H) => W * 1.3,
    promenade: (W, H) => W * 1.3,
    // The ROUNDED perimeter, which is what the lane actually drives.
    lap: (W, H, v) => lapShape(v, W, H).per,
    leaf: (W, H) => H * 1.3, rise: (W, H) => H * 1.3, launch: (W, H) => H * 1.3,
  };

  /* Shuffle bags ---------------------------------------------------------- */

  function bag(items) {
    let pool = [];
    return (n = 1, exclude = []) => {
      const out = [];
      let guard = 0;
      while (out.length < n && guard++ < 200) {
        if (!pool.length) {
          pool = items.slice();
          for (let i = pool.length - 1; i > 0; i -= 1) {
            const j = Math.floor(Math.random() * (i + 1));
            [pool[i], pool[j]] = [pool[j], pool[i]];
          }
        }
        const k = pool.findIndex((x) => !exclude.includes(x) && !out.includes(x));
        if (k < 0) { pool = []; continue; }
        out.push(pool.splice(k, 1)[0]);
      }
      return out;
    };
  }

  const vehicleBag = bag(Object.keys(VEHICLES));
  let faceBag = null;

  /* Flight ---------------------------------------------------------------- */

  // Smoke lives in the world layer at screen coordinates, so the vehicle moves
  // away from it. Drawn as plain circles: no filters, which are slow on iPad
  // Safari and are what a glow would otherwise cost.
  function stepSmoke(rig, dt) {
    paint(rig, 'smoke', 'puffNodes', 'puff', rig.smoke.step(dt, { drag: 0.97 }));
    paint(rig, 'spray', 'sprayNodes', 'spray', rig.spray.step(dt, { drag: 0.99, gravity: 420 }));
  }

  function paint(rig, _which, key, cls, list) {
    const w2 = ensureWorld();
    if (!w2) return;
    if (!rig[key]) rig[key] = [];
    while (rig[key].length < list.length) {
      const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      c.setAttribute('class', cls);
      w2.puffs.appendChild(c);
      rig[key].push(c);
    }
    rig[key].forEach((node, i) => {
      const p = list[i];
      if (!p) { node.style.display = 'none'; return; }
      const age = p.age / p.life;
      node.style.display = '';
      // Where it was RELEASED, carried on the node. A particle belonging to the
      // air rather than to the vehicle is the whole claim being made here, and
      // the only honest way to check it is against the spot it came from.
      if (node.dataset.x0 === undefined || node.dataset.born !== String(p.born)) {
        node.dataset.x0 = (p.x0 ?? p.x).toFixed(1);
        node.dataset.born = String(p.born);
      }
      node.setAttribute('cx', p.x.toFixed(1));
      node.setAttribute('cy', p.y.toFixed(1));
      node.setAttribute('r', (p.size + (p.grow ?? 0) * age).toFixed(1));
      node.style.opacity = (0.42 * (1 - age)).toFixed(2);
    });
  }

  // ONE <defs> AND ONE PARTICLE CANVAS, both in the flyway layer, both made
  // once. The gradients are shared because ids cannot be: two trains in a
  // parade would duplicate them and removing the first would take the second's
  // paint with it. The particle canvas is shared because smoke, once it leaves
  // the funnel, belongs to the air rather than to the train — it has to outlive
  // the vehicle's own element and stay where it was released.
  let world = null;
  function ensureWorld() {
    if (world || !layer) return world;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'world');
    svg.innerHTML = `<defs>${DEFS}</defs><g class="puffs"></g><g class="rails"></g>`;
    layer.appendChild(svg);
    world = { svg, puffs: svg.querySelector('.puffs'), rails: svg.querySelector('.rails') };
    return world;
  }

  function build(name, riders) {
    const v = VEHICLES[name];
    const [vw, vh] = v.vb;
    const el = document.createElement('div');
    el.className = `flight ${name}`;
    el.style.setProperty('--vc', v.colour);
    // Seats are drawn from the slots rather than hand-placed in every art
    // string: they must line up with the faces exactly, and the faces are
    // already derived from the same numbers.
    const seats = riders.map((f, i) => {
      const [cx, cy] = v.slots[i];
      return `<circle class="seat" cx="${cx}" cy="${cy}" r="${faceRadius(v, i) * 0.92}"/>`;
    }).join('');
    el.innerHTML =
      `<svg viewBox="0 0 ${vw} ${vh}" width="${vw}" height="${vh}">${v.art}${seats}</svg>` +
      riders.map((f, i) => {
        const [cx, cy] = v.slots[i];
        const R = faceRadius(v, i);
        return `<img src="${f.url}" style="left:${(cx - R) / vw * 100}%;top:${(cy - R) / vh * 100}%;`
          + `width:${R * 2 / vw * 100}%;height:${R * 2 / vh * 100}%;border-color:${f.ring}">`;
      }).join('');
    return el;
  }

  function fly(name) {
    // A copy. `side` was written straight onto the shared definition, so two of
    // the same vehicle in the air at once had the second one move the first's
    // path out from under it. They cannot currently overlap at the shipped
    // intervals; this costs nothing and stops that being load-bearing.
    const v = { ...VEHICLES[name] };
    const lane = name === 'helicopter' ? 'hover' : v.lane;
    const seats = Math.min(v.seats, faces.length);
    const riders = faceBag(seats);
    const el = build(name, riders);

    // Outer lanes pick a side; keeps the middle of the screen clear.
    v.side = Math.random() < 0.5 ? 0.18 : 0.82;

    const W = layer.clientWidth || window.innerWidth;
    const H = layer.clientHeight || window.innerHeight;
    const jitter = 0.85 + Math.random() * 0.3;          // ±15%, so it never feels canned

    // Everything flies larger now, and the multi-seat bonus is gone: the faces
    // themselves already carry those vehicles.
    const scale = scaleFor(name, W);
    // Carried on the per-flight copy so a path can ask how big it actually is.
    // Set BEFORE the duration is worked out: the lap's length depends on its
    // margin, and its margin depends on this. Computing ms first gave the car a
    // path measured for a margin it was not going to use, and therefore the
    // wrong speed.
    v.scale = scale;
    const ms = LENGTH[lane](W, H, v) / (v.speed * jitter) * 1000;
    el.style.setProperty('--vs', scale);
    layer.appendChild(el);

    // THE RIG: what a vehicle's update() is handed. Queries are cached by the
    // vehicle itself on its first frame; `mem` is its own scratch space.
    const [vw, vh] = v.vb;
    const svg = el.querySelector('svg');
    const imgs = [...el.querySelectorAll('img')];
    const rig = {
      el,
      svg,
      mem: {},
      q: (sel) => svg.querySelector(sel),
      qa: (sel) => [...svg.querySelectorAll(sel)],
      seat: (i) => imgs[i] ?? null,
      smoke: K.particles(),
      // Spray is not smoke: it is thrown up and falls back. Its own system, so
      // it can be integrated with gravity while the smoke drifts.
      spray: K.particles(24),
      // Artwork coordinates to screen coordinates. The element is translated to
      // the path point, centred, then scaled, so a point in the viewBox lands
      // this far from that centre.
      point: (ax, ay) => ({
        x: rig.at.x + (ax - vw / 2) * scale,
        y: rig.at.y + (ay - vh / 2) * scale,
      }),
      at: { x: 0, y: 0 },
      // The layer a vehicle may put things into that outlive it: smoke, spray,
      // a sea, a track. Anything here is in screen coordinates and is the
      // vehicle's to remove when it goes.
      world: ensureWorld(),
      t: 0,
    };

    // Track, laid along the lane once and left alone: the train crosses it, it
    // does not travel with the train.
    let rails = null;
    if (v.track) {
      const w2 = ensureWorld();
      if (w2) {
        const y = LANES[lane](0.5, v, W, H).y + (RAIL_UNITS - vh / 2) * scale;
        rails = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        rails.setAttribute('class', 'track');
        rails.innerHTML = `<path class="rail" d="M0 ${y.toFixed(1)} H${W}"/>`
          + `<path class="sleepers" stroke-dasharray="${(7 * scale).toFixed(1)} ${(11 * scale).toFixed(1)}" `
          + `d="M0 ${(y + 5 * scale).toFixed(1)} H${W}"/>`;
        w2.rails.appendChild(rails);
      }
    }

    const t0 = performance.now();
    let last = null;
    (function step(now) {
      const p = (now - t0) / ms;
      if (p >= 1) { el.remove(); rails?.remove(); rig.own?.remove(); return; }
      const pose = LANES[lane](p, v, W, H);
      el.style.transform = `translate(${pose.x}px, ${pose.y}px) translate(-50%, -50%) `
        + `rotate(${pose.rot}deg) scale(${scale})`;
      rig.at = pose;

      // Velocity and acceleration by differencing the path, so every vehicle
      // gets physical inputs without a single lane having to know about them.
      // On the first frame there is no previous sample: seed from the pose and
      // skip the derivatives rather than dividing by a dt of zero.
      const dt = K.clampDt(last ? (now - last.t) / 1000 : 0);
      rig.t = (now - t0) / 1000;
      if (!last) {
        last = { t: now, x: pose.x, y: pose.y, speed: 0, dist: 0 };
      } else if (dt > 0) {
        const vx = (pose.x - last.x) / dt;
        const vy = (pose.y - last.y) / dt;
        const speed = Math.hypot(vx, vy);
        const accel = (speed - last.speed) / dt;
        const dist = last.dist + speed * dt;
        last = { t: now, x: pose.x, y: pose.y, speed, dist };
        if (v.update) {
          try { v.update(rig, { ...pose, speed, accel, dist, p, scale }, dt); }
          catch (err) { console.error(err); }
        }
      }
      stepSmoke(rig, dt);
      requestAnimationFrame(step);
    })(t0);

    // Belt and braces: if rAF is throttled away, the node still goes.
    setTimeout(() => { el.remove(); rails?.remove(); rig.own?.remove(); }, ms + 4000);
  }

  function tick() {
    if (reduced() || settings.every === 'off' || !faces.length) return;
    try { fly(vehicleBag()[0]); } catch (err) { console.error(err); }
  }

  // Uniform inside the chosen range, redrawn after every flight, so the next one
  // is never predictable from the last.
  function nextGap() {
    const [lo, hi] = String(settings.every).split('-').map(Number);
    if (!Number.isFinite(lo)) return Number(DEFAULTS.every.split('-')[0]) * 60000;
    const top = Number.isFinite(hi) ? hi : lo;
    return (lo + Math.random() * (top - lo)) * 60000;
  }

  function schedule() {
    clearTimeout(timer);
    if (settings.every === 'off' || !faces.length) return;
    timer = setTimeout(() => { tick(); schedule(); }, nextGap());
  }

  /* The top of the hour --------------------------------------------------- */

  // Ordinary flights are deliberately unpredictable — a gap drawn at random
  // inside a range, so nothing about them can be waited for. The hour is the
  // opposite of that, and the opposite is the point: everything goes at once,
  // on the hour, against the clock on the wall directly above it. A child can
  // see 11:58 and know to keep watching, which is not something a random
  // interval can ever offer.
  const PARADE_MIN = 7;
  const PARADE_MAX = 10;
  // Close enough together that the whole parade is in the air at once — a lap
  // takes the better part of a minute, so everything launched inside a few
  // seconds is on screen together, which is the point of it.
  const PARADE_STAGGER_MS = 340;
  // Two of the SAME vehicle share a lane and a path, so the gap between them is
  // not a nudge — it is a fraction of the lap. At 1.1s against a lap of twenty
  // to fifty seconds they came out two or three percent apart, which is to say
  // directly on top of one another, and that is exactly what it looked like.
  //
  // Eight seconds puts a repeat a good part of the way behind its twin while
  // both are still crossing, because this gap only has to be small against the
  // LAP — not against the parade.
  const PARADE_SAME_KIND_MS = 8000;
  // The ordinary stagger is over inside this, so the parade reads as one event.
  // Only a repeat pushes past it, and a repeat has to.
  const PARADE_WINDOW_MS = 2200;
  // How long a vehicle is still coming in through its edge. Nothing else enters
  // that way until it is clear.
  const PARADE_SIDE_CLEAR_MS = 2600;

  // `force` is the deliberate launch, from the settings sheet or a test. It
  // skips the same guards send() skips: those are about whether the hour should
  // fire on its own, not about whether the thing works.
  function parade(force = false) {
    if (!force) {
      if (reduced() || settings.every === 'off' || settings.hourly === 'off') return 0;
      if (!faces.length) return 0;
    }
    const n = PARADE_MIN + Math.floor(Math.random() * (PARADE_MAX - PARADE_MIN + 1));
    // Drawn freely, repeats and all — there are eight vehicles and up to ten
    // going, so insisting on all-different would only mean a shorter parade.
    const kinds = Object.keys(VEHICLES);
    const used = new Map();
    const lastOut = new Map();
    // Sides currently being entered through, released once a vehicle is clear
    // of the edge it came in at.
    const taken = new Set();
    let at = 0;
    let sent = 0;
    for (let i = 0; i < n; i += 1) {
      // Free, except that nothing goes more than twice. Purely random draws
      // clump — a kind pulled four times has to be spaced four times, and the
      // tail of the parade ended up ten seconds behind its head, which is no
      // longer one event. Twice is enough for a repeat to read as deliberate.
      // AND NOT ONTO AN OCCUPIED SIDE. Vehicles that share a lane and a
      // direction enter the screen through the same doorway; two of them
      // launched together arrive stacked. Lane offsets separate a train from a
      // boat coming the other way, but nothing separates two things coming from
      // the same side at the same moment — so a side is claimed for as long as
      // a vehicle is still entering through it.
      const sideOf = (k) => `${VEHICLES[k].lane}|${VEHICLES[k].dir ?? 0}`;
      let name = kinds[Math.floor(Math.random() * kinds.length)];
      for (let tries = 0; tries < 24; tries += 1) {
        const tooMany = (used.get(name) ?? 0) >= 2;
        const blocked = taken.has(sideOf(name));
        if (!tooMany && !blocked) break;
        name = kinds[Math.floor(Math.random() * kinds.length)];
      }
      used.set(name, (used.get(name) ?? 0) + 1);
      at += PARADE_STAGGER_MS * (0.7 + (Math.random() * 0.6));
      // The window caps the ordinary stagger; it never overrides the gap between
      // two of the same vehicle. Clamping AFTER that push was a way of putting
      // two identical trains on the path at the same instant, which is the one
      // thing the push exists to prevent.
      const base = Math.min(at, PARADE_WINDOW_MS);
      const twin = lastOut.get(name);
      const go = twin === undefined ? base : Math.max(base, twin + PARADE_SAME_KIND_MS);
      lastOut.set(name, go);
      const side = sideOf(name);
      taken.add(side);
      // Long enough for the one that went first to be fully on screen.
      setTimeout(() => taken.delete(side), go + PARADE_SIDE_CLEAR_MS);
      setTimeout(() => {
        try { fly(name); } catch (err) { console.error(err); }
      }, go);
      sent += 1;
    }
    return sent;
  }

  // On the wall clock, not on however long this tab has happened to be open —
  // the same reason the scores band lands on :00 and :05.
  function untilTheHour() {
    const next = new Date();
    next.setMinutes(60, 0, 0);
    const ms = next - Date.now();
    // Standing exactly on the hour means the NEXT one, not this one again.
    return ms < 1000 ? ms + 3600000 : ms;
  }

  function scheduleParade() {
    clearTimeout(hourTimer);
    if (settings.every === 'off' || settings.hourly === 'off') return;
    hourTimer = setTimeout(() => { parade(); scheduleParade(); }, untilTheHour());
  }

  /* Settings -------------------------------------------------------------- */

  function mountSettings() {
    const host = document.querySelector('.sheet-inner');
    if (!host || document.getElementById('flightEvery')) return;
    const block = document.createElement('div');
    block.innerHTML = `
      <h3>Family flights</h3>
      <p class="hint">Photos are stored encrypted. Enter the passphrase once on this
        iPad; only the derived key is kept here, and it never leaves the device.</p>
      <div class="unlock">
        <input type="password" id="flightPass" placeholder="Passphrase"
               autocomplete="off" autocapitalize="off" spellcheck="false">
        <button class="close" id="flightUnlock" type="button">Unlock</button>
      </div>
      <p class="hint" id="flightStatus"></p>
      <label class="row"><span>Something crosses</span>
        <select id="flightEvery">
          <option value="off">Off</option>
          <option value="2-5">Every 2–5 min</option>
          <option value="5-10">Every 5–10 min</option>
          <option value="10-20">Every 10–20 min</option>
          <option value="20-40">Every 20–40 min</option>
          <option value="45-90">Every 45–90 min</option>
        </select>
      </label>
      <label class="row"><span>On the hour</span>
        <select id="flightHourly">
          <option value="on">A few at once</option>
          <option value="off">Off</option>
        </select>
      </label>
      <label class="row"><span>Try one now</span>
        <button class="gear" id="flightNow" type="button">Send one</button>
      </label>`;
    host.appendChild(block);

    const every = block.querySelector('#flightEvery');
    every.value = settings.every;
    every.addEventListener('change', () => {
      settings.every = EVERY.includes(every.value) ? every.value : DEFAULTS.every;
      save(); schedule(); scheduleParade();
    });

    const hourly = block.querySelector('#flightHourly');
    hourly.value = settings.hourly;
    hourly.addEventListener('change', () => {
      settings.hourly = HOURLY.includes(hourly.value) ? hourly.value : DEFAULTS.hourly;
      save(); scheduleParade();
    });

    // Waiting several minutes to find out whether anything is set up correctly
    // is no way to check it.
    block.querySelector('#flightNow').addEventListener('click', () => {
      const status = block.querySelector('#flightStatus');
      if (!faces.length) { status.textContent = 'Nothing to send — unlock the photos first.'; return; }
      tick();
    });

    block.querySelector('#flightUnlock').addEventListener('click', async () => {
      const field = block.querySelector('#flightPass');
      const status = block.querySelector('#flightStatus');
      if (!field.value) return;
      status.textContent = 'Unlocking…';
      try {
        const r = await unlock(field.value);
        field.value = '';
        status.textContent = r.ok
          ? `${r.count} face${r.count === 1 ? '' : 's'} unlocked on this iPad.`
          : `Could not unlock — ${r.why}.`;
        if (r.ok) {
          faceBag = bag(faces);
          schedule();
          scheduleParade();
          tick();                     // one straight away, so you can see it worked
        }
      } catch (err) {
        console.error(err);
        status.textContent = 'Could not unlock — no faces found in the repo.';
      }
    });
  }

  // The settings sheet said nothing until you tried to unlock, so a display that
  // was never unlocked looked identical to one that was working and simply had
  // not flown yet.
  function announce() {
    const status = document.getElementById('flightStatus');
    if (!status) return;
    status.textContent = faces.length
      ? `${faces.length} photo${faces.length === 1 ? '' : 's'} ready on this iPad.`
      : 'Locked — enter the passphrase to show the photos.';
  }

  /* Start ----------------------------------------------------------------- */

  async function start() {
    layer = document.createElement('div');
    layer.className = 'flyway';
    layer.setAttribute('aria-hidden', 'true');
    (document.getElementById('screen') ?? document.body).appendChild(layer);
    // Before any flight, so the world sits UNDER them and — just as much to the
    // point — so a flight is still the last child of the layer. Creating this
    // lazily on the first puff put it after the first vehicle, and the suites
    // that reach for `.flight:last-child` quietly stopped finding one.
    ensureWorld();
    mountSettings();
    // One line for the status panel in Settings. This module keeps its own
    // state and its own storage and reads nothing from app.js; this is the only
    // thing it publishes, and app.js omits the row when the module is absent.
    window.shabbosFlights = {
      // Lets a flight be launched by name, which is the only way any of this
      // can be tested or looked at deliberately: flights are otherwise random,
      // minutes apart, and gone in seconds.
      send: (name) => { try { fly(name ?? vehicleBag()[0]); } catch (e) { console.error(e); } },
      names: () => Object.keys(VEHICLES),
      // What a vehicle actually measures on screen at a given width: the scale
      // it flies at, and each face's radius in real pixels. The size gates need
      // the numbers the display uses, not the numbers in the artwork.
      metrics: (name, W = 1024) => {
        const v = VEHICLES[name];
        if (!v) return null;
        const scale = scaleFor(name, W);
        return { scale, faces: v.slots.map((_, i) => faceRadius(v, i) * scale) };
      },
      // Where a vehicle would BE at a given point of its journey, without
      // waiting for the journey. A lap takes the better part of a minute and a
      // test cannot watch one — sampling the rendered element only ever sees
      // the first second or two of it, which on the lap circuit is the opening
      // straight where nothing turns at all.
      path: (name, p, W, H, side = 0.82) => {
        const v = VEHICLES[name];
        if (!v) return null;
        // `side` is chosen per flight in fly(), not stored on the definition, so
        // asking the definition for a path gave NaN on every lane that uses it —
        // the rocket, the parachute and the balloon all go up one side or the
        // other. A default keeps the hook usable; callers that care pass one.
        return LANES[name === 'helicopter' ? 'hover' : v.lane](p, { ...v, side }, W, H);
      },
      // The hourly parade, on demand. Waiting up to an hour to see whether it
      // works is no way to check it, and a test cannot wait at all.
      parade: () => parade(true),
      untilTheHour: () => untilTheHour(),
      // The artwork and seat slots, so a reference sheet can be rendered
      // without waiting minutes for each vehicle to happen to fly past.
      spec: (name) => (name ? VEHICLES[name] : VEHICLES),
      status: () => {
        if (settings.every === 'off') return 'off';
        if (!faces.length) {
          return loadReport && loadReport.of
            ? `none of ${loadReport.of} could be loaded`
            : 'locked — passphrase not entered on this iPad';
        }
        const missing = loadReport?.lost ? `, ${loadReport.lost} unavailable` : '';
        return `${faces.length} unlocked${missing} · every ${settings.every} min`;
      },
    };
    try { faces = await loadFaces(); } catch { faces = []; }
    faceBag = bag(faces);
    schedule();
    scheduleParade();
    announce();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
