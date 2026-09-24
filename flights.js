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
  const DEFAULTS = { every: '2-5' };
  const EVERY = ['off', '2-5', '5-10', '10-20', '20-40', '45-90'];

  let settings = { ...DEFAULTS, ...read(STORE) };
  // A value saved by an older build is not in the list any more. Without this
  // the menu shows blank and the schedule runs on a stale number that no option
  // corresponds to.
  if (!EVERY.includes(String(settings.every))) settings.every = DEFAULTS.every;
  let faces = [];
  let layer = null;
  let timer = null;

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
    const out = [];
    for (const f of m.faces) {
      const buf = await fetch(`faces/${f.file}`).then((r) => r.arrayBuffer());
      const plain = await openBlob(k, buf);
      // The type the crop actually was. Faces encrypted before the manifest
      // carried one are jpegs, which is what the old hard-coded value assumed.
      const type = f.type ?? 'image/jpeg';
      out.push({ ring: f.ring, url: URL.createObjectURL(new Blob([plain], { type })) });
    }
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

  const A = (d, extra = '') => `<path d="${d}"/>${extra}`;

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
      art: `<rect x="6" y="20" width="36" height="26" rx="4"/><rect x="48" y="20" width="36" height="26" rx="4"/>
        <rect x="90" y="20" width="36" height="26" rx="4"/><rect x="132" y="20" width="36" height="26" rx="4"/>
        <rect x="174" y="14" width="26" height="32" rx="4"/>${A('M188 14 V6 h6 v8')}
        ${[14, 34, 56, 76, 98, 118, 140, 160, 180, 196].map((cx) => `<circle class="wheel" cx="${cx}" cy="52" r="5"/>`).join('')}
        ${A('M2 58 H206')}`,
    },
    boat: {
      vb: [134, 74], seats: 2, colour: '#4FA3A5', speed: 47, lane: 'horizon', dir: -1,
      slots: [[38, 52, 10], [92, 52, 10]],
      art: `${A('M6 44 H124 L110 62 H20 Z')}${A('M65 44 V6')}${A('M65 10 L100 40 H65')}
        ${A('M2 68 q12 -6 24 0 t24 0 t24 0 t24 0 t24 0')}`,
    },
    plane: {
      vb: [252, 62], seats: 3, colour: '#6E8BD6', speed: 98, lane: 'upper', dir: 1,
      slots: [[32, 32, 15], [80, 32, 15], [128, 32, 15]],
      art: `<rect x="2" y="12" width="150" height="40" rx="4"/>${A('M152 32 H172')}
        ${A('M176 38 C190 30 216 26 240 30 C248 31 248 36 240 38 C218 44 192 44 176 38 Z')}
        ${A('M182 30 L176 12 L196 28')}${A('M200 40 L192 54 L216 42')}`,
    },
    helicopter: {
      vb: [190, 92], seats: 1, colour: '#5D7CA6', speed: 60, lane: 'upper', dir: 1,
      slots: [[70, 62, 15]],
      art: `<circle cx="70" cy="62" r="24"/>${A('M92 56 H166 L166 68 H98')}${A('M166 56 V36')}
        ${A('M70 38 V22')}<ellipse class="disc" cx="70" cy="22" rx="54" ry="7"/>
        <line class="rotor" x1="16" y1="22" x2="124" y2="22"/>
        <circle class="disc" cx="168" cy="44" r="11"/><line class="tailrotor" x1="157" y1="44" x2="179" y2="44"/>
        ${A('M48 88 H98 M58 84 v8 M88 84 v8')}`,
    },
    car: {
      vb: [116, 62], seats: 1, colour: '#E0A030', speed: 80, lane: 'lap', dir: 1,
      slots: [[52, 32, 10]],
      art: `${A('M8 44 L14 30 Q18 22 30 22 H72 Q84 22 90 30 L100 44')}${A('M4 44 H110 v6 H4 z')}
        <circle class="wheel" cx="26" cy="52" r="7"/><circle class="wheel" cx="86" cy="52" r="7"/>`,
    },
    balloon: {
      vb: [128, 118], seats: 2, colour: '#A96FA0', speed: 24, lane: 'rise',
      slots: [[42, 101, 9], [86, 101, 9]],
      art: `${A('M64 80 C14 56 16 22 64 6 C112 22 114 56 64 80 Z')}
        ${A('M64 6 Q42 42 64 80 M64 6 Q86 42 64 80')}${A('M44 72 L46 90 M84 72 L82 90')}
        <rect x="40" y="90" width="48" height="22" rx="3"/>
        <path class="burner" d="M56 88 Q64 62 72 88 Z"/>`,
    },
    parachute: {
      vb: [108, 118], seats: 1, colour: '#6FA96B', speed: 29, lane: 'leaf',
      slots: [[54, 100, 13]],
      art: `${A('M8 36 A46 42 0 0 1 100 36')}
        ${A('M8 36 Q26 52 30 38 Q42 54 54 38 Q66 54 78 38 Q82 52 100 36')}
        ${A('M30 40 L48 84 M54 40 L54 84 M78 40 L60 84')}`,
      pivot: [54, 26],
    },
    rocket: {
      vb: [120, 132], seats: 1, colour: '#C2703D', speed: 200, lane: 'launch',
      slots: [[60, 34, 12]],
      art: `${A('M60 6 C74 22 78 42 78 56 H42 C42 42 46 22 60 6 Z')}
        ${A('M42 42 L26 68 H42 M78 42 L94 68 H78')}${A('M42 56 H78 v8 H42 z')}
        <path class="flame outer" d="M44 64 Q60 110 76 64 Z"/>
        <path class="flame inner" d="M52 64 Q60 94 68 64 Z"/>`,
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
      const m = 26, w = W - m * 2, h = H - m * 2, per = 2 * (w + h);
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

  const LENGTH = {
    horizon: (W, H) => W * 1.3, upper: (W, H) => W * 1.3, hover: (W, H) => W * 1.3,
    lap: (W, H) => 2 * ((W - 52) + (H - 52)),
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
    el.innerHTML =
      `<svg viewBox="0 0 ${vw} ${vh}" width="${vw}" height="${vh}">${v.art}</svg>` +
      riders.map((f, i) => {
        const [cx, cy] = v.slots[i];
        const R = faceRadius(v, i);
        return `<img src="${f.url}" style="left:${(cx - R) / vw * 100}%;top:${(cy - R) / vh * 100}%;`
          + `width:${R * 2 / vw * 100}%;height:${R * 2 / vh * 100}%;border-color:${f.ring}">`;
      }).join('');
    return el;
  }

  function fly(name) {
    const v = VEHICLES[name];
    const lane = name === 'helicopter' ? 'hover' : v.lane;
    const seats = Math.min(v.seats, faces.length);
    const riders = faceBag(seats);
    const el = build(name, riders);

    // Outer lanes pick a side; keeps the middle of the screen clear.
    v.side = Math.random() < 0.5 ? 0.18 : 0.82;

    const W = layer.clientWidth || window.innerWidth;
    const H = layer.clientHeight || window.innerHeight;
    const jitter = 0.85 + Math.random() * 0.3;          // ±15%, so it never feels canned
    const ms = LENGTH[lane](W, H) / (v.speed * jitter) * 1000;

    // Everything flies larger now, and the multi-seat bonus is gone: the faces
    // themselves already carry those vehicles.
    const scale = Math.min(1, W / 1024) * 1.8 * (SIZE[name] ?? 1);
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
      <label class="row"><span>Try one now</span>
        <button class="gear" id="flightNow" type="button">Send one</button>
      </label>`;
    host.appendChild(block);

    const every = block.querySelector('#flightEvery');
    every.value = settings.every;
    every.addEventListener('change', () => {
      settings.every = EVERY.includes(every.value) ? every.value : DEFAULTS.every;
      save(); schedule();
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
    try { faces = await loadFaces(); } catch { faces = []; }
    faceBag = bag(faces);
    schedule();
    announce();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
