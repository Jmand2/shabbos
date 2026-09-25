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
    plane: 1, train: 1.05, helicopter: 1.2, boat: 1.35,
    balloon: 1.4, rocket: 1.35, parachute: 1.5, car: 1.6,
  };

  function faceRadius(v, i) {
    const [cx, cy, r] = v.slots[i];
    let gap = Infinity;
    v.slots.forEach(([ox, oy], j) => {
      if (j !== i) gap = Math.min(gap, Math.hypot(ox - cx, oy - cy));
    });
    return Math.min(r * FACE, gap * NEIGHBOUR);
  }

  const VEHICLES = {
    train: {
      vb: [210, 66], seats: 4, colour: '#D9544D', speed: 67, lane: 'horizon', dir: 1,
      slots: [[24, 33, 11], [66, 33, 11], [108, 33, 11], [150, 33, 11]],
      art: `<rect class="hull" x="6" y="18" width="36" height="28" rx="6"/>
        <rect class="hull" x="48" y="18" width="36" height="28" rx="6"/>
        <rect class="hull" x="90" y="18" width="36" height="28" rx="6"/>
        <rect class="hull" x="132" y="18" width="36" height="28" rx="6"/>
        <path class="hull" d="M174 46 V24 q0-8 8-8 h14 q6 0 6 6 v24 z"/>
        <path class="solid" d="M180 16 h10 v-9 h-10 z"/>
        <path class="thin" d="M6 12 H196"/>
        <path d="M2 50 H204"/>
        <circle class="solid" cx="18" cy="54" r="5"/><circle class="solid" cx="34" cy="54" r="5"/>
        <circle class="solid" cx="60" cy="54" r="5"/><circle class="solid" cx="76" cy="54" r="5"/>
        <circle class="solid" cx="102" cy="54" r="5"/><circle class="solid" cx="118" cy="54" r="5"/>
        <circle class="solid" cx="144" cy="54" r="5"/><circle class="solid" cx="160" cy="54" r="5"/>
        <circle class="solid" cx="186" cy="54" r="6"/>`,
    },
    boat: {
      vb: [134, 74], seats: 2, colour: '#4FA3A5', speed: 47, lane: 'horizon', dir: -1,
      slots: [[38, 52, 10], [92, 52, 10]],
      art: `<path class="hull" d="M14 42 H120 L104 64 H30 z"/>
        <path class="glass" d="M66 38 V6 L104 34 z"/>
        <path d="M66 4 V44"/>
        <path class="thin" d="M4 68 q12-7 22 0 t22 0 t22 0 t22 0 t22 0 t20 0"/>`,
    },
    plane: {
      vb: [252, 62], seats: 3, colour: '#6E8BD6', speed: 98, lane: 'upper', dir: 1,
      slots: [[32, 32, 15], [80, 32, 15], [128, 32, 15]],
      art: `<rect class="hull" x="6" y="12" width="124" height="40" rx="8"/>
        <path class="thin" d="M130 32 H150"/>
        <path class="hull" d="M150 32 q28-16 62-14 q14 1 20 14 q-6 13-20 14 q-34 2-62-14 z"/>
        <path class="hull" d="M176 26 L168 4 h12 l18 22 z"/>
        <path class="hull" d="M176 38 L168 60 h12 l18-22 z"/>
        <path class="glass" d="M198 25 q11-2 18 7 q-7 9-18 7 z"/>`,
    },
    helicopter: {
      vb: [190, 92], seats: 1, colour: '#5D7CA6', speed: 60, lane: 'upper', dir: 1,
      slots: [[70, 62, 15]],
      art: `<path class="hull" d="M34 62 q0-30 36-30 q34 0 44 26 q2 6-4 10 H42 q-8 0-8-6 z"/>
        <path class="hull" d="M112 54 L176 46 q8-1 8 6 q0 7-8 7 l-64 4 z"/>
        <path class="hull" d="M40 72 q34 10 66 0 q-4 8-14 8 H54 q-10 0-14-8 z"/>
        <path d="M70 32 V16"/>
        <ellipse class="glass" cx="70" cy="12" rx="62" ry="5"/>
        <circle class="thin" cx="180" cy="52" r="13"/>
        <path class="thin" d="M180 39 V65 M167 52 H193"/>
        <path class="thin" d="M46 84 H96"/>`,
    },
    car: {
      vb: [116, 62], seats: 1, colour: '#E0A030', speed: 80, lane: 'lap', dir: 1,
      slots: [[52, 32, 10]],
      art: `<path class="hull" d="M6 48 L10 34 q3-9 14-9 h60 q11 0 15 9 l8 14 z"/>
        <path class="glass" d="M24 32 q3-5 10-5 h38 q7 0 10 5 l3 8 H21 z"/>
        <path class="hull" d="M2 46 H114 q4 0 4 5 v3 q0 4-4 4 H2 q-4 0-4-4 v-3 q0-5 4-5 z"/>
        <circle class="solid" cx="28" cy="56" r="8"/>
        <circle class="solid" cx="88" cy="56" r="8"/>`,
    },
    balloon: {
      vb: [128, 118], seats: 2, colour: '#A96FA0', speed: 24, lane: 'rise',
      slots: [[42, 101, 9], [86, 101, 9]],
      art: `<path class="hull" d="M64 6 q40 0 40 40 q0 26-24 44 H48 q-24-18-24-44 q0-40 40-40 z"/>
        <path class="thin" d="M64 6 q-16 20-16 44 q0 22 10 40"/>
        <path class="thin" d="M64 6 q16 20 16 44 q0 22-10 40"/>
        <path class="thin" d="M44 92 L52 104 M84 92 L76 104"/>
        <path class="hull" d="M46 102 h36 q4 0 4 5 v10 q0 4-4 4 H46 q-4 0-4-4 v-10 q0-5 4-5 z"/>
        <path class="thin" d="M46 110 H86"/>`,
    },
    parachute: {
      vb: [108, 118], seats: 1, colour: '#6FA96B', speed: 29, lane: 'leaf',
      slots: [[54, 100, 13]],
      art: `<path class="hull" d="M8 52 q0-44 46-44 q46 0 46 44 q-20-10-46-10 q-26 0-46 10 z"/>
        <path class="thin" d="M31 46 q6-30 23-38 M77 46 q-6-30-23-38"/>
        <path class="thin" d="M8 52 L48 90 M54 42 L54 90 M100 52 L60 90"/>
        <path class="hull" d="M40 86 h28 q5 0 5 6 v14 q0 6-5 6 H40 q-5 0-5-6 V92 q0-6 5-6 z"/>`,
      pivot: [54, 26],
    },
    rocket: {
      vb: [120, 132], seats: 1, colour: '#C2703D', speed: 200, lane: 'launch',
      slots: [[60, 34, 12]],
      art: `<path class="hull" d="M60 4 q24 22 24 58 v20 H36 V62 q0-36 24-58 z"/>
        <path class="hull" d="M36 66 L14 92 q-2 14 6 18 l16-14 z"/>
        <path class="hull" d="M84 66 L106 92 q2 14-6 18 l-16-14 z"/>
        <path class="hull" d="M36 82 h48 v14 q0 6-6 6 H42 q-6 0-6-6 z"/>
        <path class="thin" d="M44 74 H76"/>
        <path class="solid" d="M52 104 q8 20 8 26 q0-6 8-26 z"/>`,
    },
  };

  /* Paths ----------------------------------------------------------------- */
  // p is 0..1 of the journey. Returns position in px plus rotation.

  const LANES = {
    horizon: (p, v, W, H) => ({ x: (v.dir > 0 ? -0.15 + p * 1.3 : 1.15 - p * 1.3) * W, y: H * 0.56, rot: 0 }),
    upper: (p, v, W, H) => ({
      x: (-0.15 + p * 1.3) * W,
      y: H * (0.30 + 0.05 * Math.sin(p * Math.PI * 2 * 1.3 + 0.4)),
      rot: 4 * Math.cos(p * Math.PI * 2 * 1.3 + 0.4),
    }),
    // Slow into the middle, hover, then away. Only vehicle that stops.
    hover: (p, v, W, H) => {
      const ease = (t) => 0.5 * (1 - Math.cos(Math.PI * Math.min(1, Math.max(0, t))));
      const d = ease((p - 0.12) / 0.28) * 0.42 + ease((p - 0.7) / 0.3) * 0.58;
      return { x: (-0.15 + d * 1.3) * W, y: H * 0.30, rot: 0 };
    },
    lap: (p, v, W, H) => {
      const m = lapMargin(v), w = W - m * 2, h = H - m * 2, per = 2 * (w + h);
      // brake into each corner
      const d = (p + 0.055 * Math.sin(p * Math.PI * 2 * 4)) * per;
      const s = ((d % per) + per) % per;
      if (s < w) return { x: m + s, y: H - m, rot: 0 };
      if (s < w + h) return { x: W - m, y: H - m - (s - w), rot: -90 };
      if (s < 2 * w + h) return { x: W - m - (s - w - h), y: m, rot: 180 };
      return { x: m, y: m + (s - 2 * w - h), rot: 90 };
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
    lap: (W, H, v) => 2 * ((W - lapMargin(v) * 2) + (H - lapMargin(v) * 2)),
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
    const scale = Math.min(1, W / 1024) * 1.8 * (SIZE[name] ?? 1);
    // Carried on the per-flight copy so a path can ask how big it actually is.
    // Set BEFORE the duration is worked out: the lap's length depends on its
    // margin, and its margin depends on this. Computing ms first gave the car a
    // path measured for a margin it was not going to use, and therefore the
    // wrong speed.
    v.scale = scale;
    const ms = LENGTH[lane](W, H, v) / (v.speed * jitter) * 1000;
    el.style.setProperty('--vs', scale);
    layer.appendChild(el);

    const t0 = performance.now();
    (function step(now) {
      const p = (now - t0) / ms;
      if (p >= 1) { el.remove(); return; }
      const { x, y, rot } = LANES[lane](p, v, W, H);
      el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%) `
        + `rotate(${rot}deg) scale(${scale})`;
      requestAnimationFrame(step);
    })(t0);

    // Belt and braces: if rAF is throttled away, the node still goes.
    setTimeout(() => el.remove(), ms + 4000);
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
  // Close enough together to read as one event, far enough apart that ten
  // vehicles do not leave stacked on top of one another.
  const PARADE_STAGGER_MS = 340;

  // `force` is the deliberate launch, from the settings sheet or a test. It
  // skips the same guards send() skips: those are about whether the hour should
  // fire on its own, not about whether the thing works.
  function parade(force = false) {
    if (!force) {
      if (reduced() || settings.every === 'off' || settings.hourly === 'off') return 0;
      if (!faces.length) return 0;
    }
    const n = PARADE_MIN + Math.floor(Math.random() * (PARADE_MAX - PARADE_MIN + 1));
    // Drawn ONE AT A TIME rather than as one batch of n. The bag refuses to
    // repeat within a single draw, so asking it for ten when there are eight
    // vehicles returns eight and spins its guard doing it. Drawn singly it
    // hands back its whole shuffled pool before reshuffling, so a parade of ten
    // is eight different things and then two more — the most variety available,
    // and any repeat is at least a full pool behind its twin rather than
    // beside it.
    const names = Array.from({ length: n }, () => vehicleBag()[0]).filter(Boolean);
    names.forEach((name, i) => {
      setTimeout(() => {
        try { fly(name); } catch (err) { console.error(err); }
      }, (i * PARADE_STAGGER_MS) + (Math.random() * 220));
    });
    return names.length;
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
