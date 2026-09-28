/* The vehicles: what each one looks like, where its riders sit, and how its
 * parts move when it moves.
 *
 * Artwork and rigging only. Scheduling, faces, paths and the frame loop stay in
 * flights.js; the motion maths is in kinetics.js. A vehicle here is a picture
 * plus an update(rig, state, dt) that is handed physical inputs — distance
 * travelled, speed, acceleration — and moves its own parts from them.
 *
 * WHY RIGGED RATHER THAN ANIMATED. Every part used to move on its own CSS
 * timer, at a rate that had nothing to do with the vehicle's speed: the car's
 * wheels turned once every 0.42s whatever it was doing, which is four times
 * faster than it travelled, so it skidded its whole lap. Wheels here roll the
 * distance actually covered. It is the difference between a picture of a train
 * and a train.
 *
 * THE FOUR RULES, from the room test rather than from taste:
 *   1. Faces come first — at least 70 px across at 1024 wide. Build the vehicle
 *      around the rider, never shrink the rider to fit the vehicle.
 *   2. Detail lives in silhouette, colour, light and motion. Nothing thinner
 *      than 2.5 px on screen survives the room; spokes and grilles and fine
 *      stripes are cost with no return.
 *   3. Light is the most visible detail on a dark wall.
 *   4. Riders react; faces never deform. Translate and rotate a seat, never
 *      scale or skew it.
 *
 * Classic script, like the rest of the app.
 */
(() => {
  'use strict';

  const K = globalThis.shabbosKinetics;

  /* Shared paint ------------------------------------------------------------
     One <defs>, created once in the flyway layer.

     These carry ids and that is the whole point: a gradient has to be referred
     to by url(#...), so the ids have to exist SOMEWHERE — and putting them in
     a vehicle's artwork is what breaks, because two trains in a parade would
     duplicate every id and removing the first would take the second's paint
     with it. One copy in the layer, referenced by every flight, removed by
     none of them. The gate forbids ids in artwork, not here. */
  const DEFS = `
    <linearGradient id="g-red" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#EE7A70"/><stop offset=".45" stop-color="#D9544D"/>
      <stop offset="1" stop-color="#9E3A35"/></linearGradient>
    <linearGradient id="g-boiler" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#4A5572"/><stop offset=".35" stop-color="#2C3448"/>
      <stop offset="1" stop-color="#171C29"/></linearGradient>
    <linearGradient id="g-roof" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#3A4258"/><stop offset="1" stop-color="#20263A"/></linearGradient>
    <radialGradient id="g-glow">
      <stop offset="0" stop-color="#FFE9A8" stop-opacity=".9"/>
      <stop offset="1" stop-color="#FFE9A8" stop-opacity="0"/></radialGradient>
    <linearGradient id="g-beam" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#FFE9A8" stop-opacity=".25"/>
      <stop offset="1" stop-color="#FFE9A8" stop-opacity="0"/></linearGradient>`;

  const GOLD = '#E8C547';
  const DARK = '#141824';
  const RAIL = 150;          // every vehicle here stands on this line

  /* The train ---------------------------------------------------------------

     Laid out from prototypes/train.py, which was rendered, blurred to viewing
     distance and looked at before any of it was written down. Carriages at a
     116 pitch, faces 72 px across, the engine 1.3x so it sits with them.

     Open carriages, not windows. The first detailed train put faces in proper
     lit windows at 34 px and across the room they were blobs — the whole point
     of the thing, unreadable. Riders sit ABOVE a low wall: shoulders in shirt
     colour behind it, ringed face on top, nothing in front of the photo. */

  const SHIRTS = ['#5D7CA6', '#6FA96B', '#A96FA0', '#C2703D'];
  const CAR_PITCH = 116;
  const DRIVE_R = 15;        // driving wheel radius, in artwork units
  const CRANK = 9;           // crank pin throw

  // Spokes are heavy and few. Ten died in the room test; four read.
  const wheelArt = (cx, cy, r, spokes) => {
    let sp = '';
    for (let k = 0; k < spokes; k += 1) {
      const a = (k * 2 * Math.PI) / spokes;
      sp += `<line x1="0" y1="0" x2="${(r * 0.8 * Math.cos(a)).toFixed(1)}" `
        + `y2="${(r * 0.8 * Math.sin(a)).toFixed(1)}"/>`;
    }
    // data-base carries the wheel's own place, so update() can add a rotation
    // without having to reconstruct where the wheel lives.
    return `<g class="wheel" data-base="translate(${cx} ${cy})" transform="translate(${cx} ${cy})">`
      + `<circle class="tyre" r="${r}"/>`
      + `<g class="spokes">${sp}</g>`
      + `<circle class="hub" r="${(r * 0.24).toFixed(1)}"/></g>`;
  };

  const carriageArt = (x0, i) => {
    const fx = x0 + 54;
    return `<g class="car" transform="translate(0 0)">`
      // Shoulders behind the wall, so the rider reads as sitting in it.
      + `<g class="rider"><path class="shirt" fill="${SHIRTS[i % SHIRTS.length]}" `
      + `d="M${fx - 31} ${RAIL - 40} q0 -27 31 -27 q31 0 31 27 z"/></g>`
      + `<path class="body" d="M${x0 + 4} ${RAIL - 52} h100 q5 0 5 5 v27 H${x0 - 1} v-27 q0 -5 5 -5 z"/>`
      + `<rect class="trim" x="${x0 - 1}" y="${RAIL - 53}" width="110" height="7" rx="3"/>`
      + `<rect class="trim2" x="${x0 - 1}" y="${RAIL - 31}" width="110" height="5"/>`
      + `<rect class="frame" x="${x0 + 5}" y="${RAIL - 21}" width="98" height="7"/>`
      + wheelArt(x0 + 26, RAIL - 10, 10, 4)
      + wheelArt(x0 + 82, RAIL - 10, 10, 4)
      + `</g>`;
  };

  const ENGINE_X = 3 * CAR_PITCH;
  const ENGINE_S = 1.3;

  // Drawn in the engine's own units and scaled as a group, exactly as the
  // prototype does, so the proportions carry over unchanged.
  const engineInner = () => {
    const wx = [30, 64, 98];
    let wheels = '';
    for (const x of wx) wheels += wheelArt(x, -DRIVE_R, DRIVE_R, 6);
    return ''
      // Lamp and its beam first, so everything else sits over the light.
      + `<rect class="lampbox" x="150" y="-96" width="15" height="13" rx="2"/>`
      + `<circle class="lamp" cx="165" cy="-90" r="12"/>`
      + `<path class="beam" d="M167 -95 L272 -116 L272 -62 L167 -85 z"/>`
      + `<path class="boiler" d="M54 -82 H150 q13 0 13 13 v27 q0 13 -13 13 H54 z"/>`
      + `<rect class="band" x="76" y="-82" width="5" height="53"/>`
      + `<rect class="band" x="104" y="-82" width="5" height="53"/>`
      + `<rect class="band" x="132" y="-82" width="5" height="53"/>`
      + `<path class="dome" d="M84 -82 q0 -17 14 -17 q14 0 14 17 z"/>`
      + `<path class="bell" d="M62 -82 q0 -10 8 -10 q8 0 8 10 z"/>`
      + `<path class="funnel" d="M136 -82 l-7 -29 h25 l-7 29 z"/>`
      + `<rect class="funnelcap" x="127" y="-115" width="29" height="7" rx="3"/>`
      + `<rect class="cabroof" x="-7" y="-105" width="68" height="11" rx="4"/>`
      + `<path class="cab" d="M0 -97 h55 v70 H0 z"/>`
      + `<rect class="trim2" x="0" y="-30" width="55" height="5"/>`
      + `<rect class="frame" x="-5" y="-25" width="170" height="8"/>`
      + `<rect class="cyl" x="126" y="-37" width="35" height="19" rx="4"/>`
      + `<g class="cross"><line class="pistonrod" x1="132" y1="-27" x2="163" y2="-27"/></g>`
      + wheels
      + wheelArt(146, -9, 9, 4)
      + `<g class="rods"><line class="coupling" x1="30" y1="-15" x2="98" y2="-15"/></g>`
      + `<line class="mainrod" x1="98" y1="-15" x2="132" y2="-27"/>`
      + `<path class="cow" d="M160 -25 L188 -1 H160 z"/>`;
  };

  const TRAIN_ART = ''
    + [0, 1, 2].map((i) => carriageArt(i * CAR_PITCH, i)).join('')
    + [0, 1, 2].map((i) => `<path class="coupler" d="M${i * CAR_PITCH + 108} ${RAIL - 18} `
      + `H${(i + 1) * CAR_PITCH}"/>`).join('')
    + `<g class="engine" transform="translate(${ENGINE_X} ${RAIL}) scale(${ENGINE_S})">`
    + engineInner() + `</g>`
    + `<g class="rider driver"><path class="shirt" fill="${SHIRTS[3]}" `
    + `d="M${ENGINE_X + 35 - 31} ${RAIL - 48} q0 -27 31 -27 q31 0 31 27 z"/></g>`;

  /* update() ---------------------------------------------------------------
     `state` carries x, y, rot, scale, speed, accel, dist and p. `rig` carries
     the element, a query helper, a screen-space point mapper, a particle
     system, and a scratch object the vehicle owns. */

  function trainUpdate(rig, state, dt) {
    const m = rig.mem;
    if (!m.init) {
      m.init = true;
      m.wheels = rig.qa('.engine .wheel');
      m.carWheels = rig.qa('.car .wheel');
      m.rods = rig.q('.rods');
      m.mainrod = rig.q('.mainrod');
      m.cross = rig.q('.cross');
      m.riders = rig.qa('.rider');
      m.angle = 0;
      m.prevAngle = 0;
    }

    // WHEELS ROLL THE DISTANCE TRAVELLED. dist arrives in screen pixels, so it
    // is converted into the artwork's own units before it becomes an angle:
    // the wheel is DRIVE_R units across whatever the vehicle is scaled to.
    const units = state.dist / (state.scale || 1);
    m.prevAngle = m.angle;
    m.angle = K.wheelAngle(units, DRIVE_R * ENGINE_S);
    const deg = (m.angle * 180) / Math.PI;
    for (const wdom of m.wheels) wdom.setAttribute('transform', `${wdom.dataset.base} rotate(${deg})`);
    // Carriage wheels are smaller, so they turn faster for the same distance.
    const cdeg = ((K.wheelAngle(units, 10) * 180) / Math.PI);
    for (const wdom of m.carWheels) wdom.setAttribute('transform', `${wdom.dataset.base} rotate(${cdeg})`);

    // The coupling rod joins crank pins that are all in phase, so every point
    // on it travels the same circle: it translates and never rotates. That is
    // the real mechanism, and it is also pure transform.
    const cx = CRANK * Math.cos(m.angle);
    const cy = CRANK * Math.sin(m.angle);
    if (m.rods) m.rods.setAttribute('transform', `translate(${cx.toFixed(2)} ${cy.toFixed(2)})`);
    // The crosshead slides along the piston; the main rod is the one thing here
    // that genuinely changes length and angle, so it is the one thing whose
    // geometry is written per frame.
    const headX = 132 + cx;
    if (m.cross) m.cross.setAttribute('transform', `translate(${cx.toFixed(2)} 0)`);
    if (m.mainrod) {
      m.mainrod.setAttribute('x1', (98 + cx).toFixed(2));
      m.mainrod.setAttribute('y1', (-DRIVE_R + cy).toFixed(2));
      m.mainrod.setAttribute('x2', headX.toFixed(2));
    }

    // Riders jostle on the rail joints, each on its own phase. Translation
    // only: a face is never scaled or skewed.
    m.riders.forEach((r, i) => {
      const bump = 1.8 * Math.max(0, Math.sin(m.angle * 2 + i * 1.7));
      r.setAttribute('transform', `translate(0 ${(-bump).toFixed(2)})`);
      const seat = rig.seat(i);
      if (seat) seat.style.transform = `translateY(${(-bump * state.scale).toFixed(2)}px)`;
    });

    // FOUR EXHAUST BEATS PER TURN of the driving wheels, each one a puff left
    // in the air. The smoke used to be drawn inside the train and travelled
    // with it, which is precisely why the train never looked like it was
    // moving: nothing was being left behind.
    const n = K.beats(m.prevAngle, m.angle, 4);
    for (let i = 0; i < n; i += 1) {
      const p = rig.point(ENGINE_X + 143 * ENGINE_S, RAIL - 113 * ENGINE_S);
      const ex = p.x + (Math.random() - 0.5) * 6;
      rig.smoke.emit({
        x: ex,
        x0: ex,
        born: Date.now() + Math.random(),
        y: p.y,
        vx: (Math.random() - 0.5) * 16,
        vy: -70 - Math.random() * 25,
        life: 2.4,
        size: (9 + Math.random() * 3) * state.scale,
        grow: 30 * state.scale,
      });
    }
  }

  /* The vehicles ----------------------------------------------------------- */

  const VEHICLES = {
    train: {
      vb: [600, 185], seats: 4, colour: '#D9544D', speed: 67, lane: 'horizon', dir: 1,
      band: 0.045,
      // 17.2 * FACE(2.1) = 36: a 72 px face at 1024 wide, the size the room
      // test says survives. The pitch is 116, well clear of the neighbour
      // limit, so the face radius is set by the slot and not by its neighbour.
      slots: [[54, RAIL - 92, 17.2], [170, RAIL - 92, 17.2], [286, RAIL - 92, 17.2],
        [ENGINE_X + 35, RAIL - 88, 17.2]],
      art: TRAIN_ART,
      track: true,
      update: trainUpdate,
    },

    boat: {
      vb: [134, 74], seats: 2, colour: '#4FA3A5', speed: 47, lane: 'horizon', dir: -1,
      band: -0.055,
      slots: [[38, 52, 10], [92, 52, 10]],
      art: `<path class="hull" d="M14 42 H120 L104 64 H30 z"/>
        <path class="glass" d="M66 38 V6 L104 34 z"/>
        <path d="M66 4 V44"/>
        <g class="wake">
          <path class="thin" d="M-40 68 q12-7 22 0 t22 0 t22 0 t22 0 t22 0 t22 0 t22 0 t22 0 t22 0"/>
        </g>
        <g class="wake slow">
          <path class="thin" d="M-40 62 q14-5 26 0 t26 0 t26 0 t26 0 t26 0 t26 0 t26 0"/>
        </g>`,
    },

    plane: {
      vb: [252, 62], seats: 3, colour: '#6E8BD6', speed: 98, lane: 'upper', dir: 1,
      band: -0.045,
      slots: [[32, 32, 15], [80, 32, 15], [128, 32, 15]],
      art: `<path class="hull" d="M8 24 h150 q24 0 34 12 l14 16 H8 q-8 0-8-8 V32 q0-8 8-8 z"/>
        <path class="glass" d="M166 28 q14 2 22 10 h-30 z"/>
        <path class="hull" d="M96 24 L120 2 h16 l-10 22 z"/>
        <path class="thin" d="M40 52 h150"/>`,
    },

    helicopter: {
      vb: [190, 92], seats: 1, colour: '#5D7CA6', speed: 60, lane: 'upper', dir: 1,
      band: 0.06,
      slots: [[70, 62, 15]],
      art: `<path class="hull" d="M40 44 q0-22 30-22 q30 0 34 22 l4 16 q0 12-14 12 H52 q-14 0-14-12 z"/>
        <path class="glass" d="M48 44 q2-16 22-16 q20 0 22 16 z"/>
        <path class="hull" d="M100 48 h62 q8 0 8 8 v6 h-70 z"/>
        <path class="thin" d="M52 82 h50 M62 70 v12 M94 70 v12"/>
        <path class="mast" d="M70 22 V10"/>
        <ellipse class="disc" cx="70" cy="9" rx="66" ry="7"/>
        <path class="rotor" d="M4 9 H136"/>
        <g class="tailrotor" transform="translate(166 40)"><path d="M0 -14 V14"/></g>`,
      update(rig, state) {
        const m = rig.mem;
        if (!m.init) { m.init = true; m.rotor = rig.q('.rotor'); m.tail = rig.q('.tailrotor'); m.a = 0; }
        // The rotor turns with airspeed and never stops: a helicopter with a
        // still rotor is a helicopter falling. These were CSS loops that stopped
        // matching anything when the vehicle was redrawn, and no suite noticed.
        m.a += (2.6 + state.speed * 0.02);
        if (m.rotor) m.rotor.setAttribute('transform', `rotate(${(m.a % 360).toFixed(1)} 70 9)`);
        if (m.tail) m.tail.setAttribute('transform', `translate(166 40) rotate(${((m.a * 3) % 360).toFixed(1)})`);
      },
    },

    car: {
      vb: [116, 62], seats: 1, colour: '#E0A030', speed: 80, lane: 'lap', dir: 1,
      slots: [[52, 32, 10]],
      art: `<path class="hull" d="M6 48 L10 34 q3-9 14-9 h60 q11 0 15 9 l8 14 z"/>
        <path class="glass" d="M24 32 q3-5 10-5 h38 q7 0 10 5 l3 8 H21 z"/>
        <path class="hull" d="M2 46 H114 q4 0 4 5 v3 q0 4-4 4 H2 q-4 0-4-4 v-3 q0-5 4-5 z"/>
        <g class="wheel"><circle class="solid" cx="28" cy="56" r="8"/>
          <path class="spoke" d="M28 50 V62 M22 56 H34"/></g>
        <g class="wheel"><circle class="solid" cx="88" cy="56" r="8"/>
          <path class="spoke" d="M88 50 V62 M82 56 H94"/></g>`,
    },

    balloon: {
      vb: [128, 118], seats: 2, colour: '#A96FA0', speed: 24, lane: 'rise',
      slots: [[42, 101, 9], [86, 101, 9]],
      art: `<path class="hull" d="M64 6 q40 0 40 40 q0 26-24 44 H48 q-24-18-24-44 q0-40 40-40 z"/>
        <path class="thin" d="M64 6 q-16 20-16 44 q0 22 10 40"/>
        <path class="thin" d="M64 6 q16 20 16 44 q0 22-10 40"/>
        <path class="thin" d="M44 92 L52 104 M84 92 L76 104"/>
        <path class="burner" d="M58 90 h12 l-3 12 h-6 z"/>
        <path class="hull" d="M46 102 h36 q4 0 4 5 v10 q0 4-4 4 H46 q-4 0-4-4 v-10 q0-5 4-5 z"/>
        <path class="thin" d="M46 110 H86"/>`,
      update(rig, state, dt) {
        const m = rig.mem;
        if (!m.init) { m.init = true; m.burner = rig.q('.burner'); m.t = 0; }
        m.t += K.clampDt(dt);
        // A burn every four seconds or so, and the envelope lifts on the same
        // clock: the flare is what the lift is FOR.
        const phase = (m.t % 4.2) / 4.2;
        const on = phase > 0.68 && phase < 0.88;
        if (m.burner) {
          m.burner.style.opacity = on ? '0.95' : '0';
          m.burner.style.transform = `scaleY(${on ? 1.15 : 0.2})`;
        }
      },
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

    dancer: {
      vb: [96, 136], seats: 1, colour: '#D98CB3', speed: 42, lane: 'promenade', dir: 1,
      slots: [[48, 26, 15]],
      art: `<circle class="head" cx="48" cy="26" r="16"/>
        <path class="torso" d="M48 44 V84"/>
        <g class="limb armL"><path d="M48 56 L22 74"/><circle class="solid" cx="22" cy="74" r="3.5"/></g>
        <g class="limb armR"><path d="M48 56 L74 74"/><circle class="solid" cx="74" cy="74" r="3.5"/></g>
        <g class="limb legL"><path d="M48 84 L30 120"/><path class="thin" d="M30 120 H18"/></g>
        <g class="limb legR"><path d="M48 84 L66 120"/><path class="thin" d="M66 120 H78"/></g>`,
    },

    rocket: {
      vb: [120, 132], seats: 1, colour: '#C2703D', speed: 200, lane: 'launch',
      slots: [[60, 34, 12]],
      art: `<path class="hull" d="M60 4 q24 22 24 58 v20 H36 V62 q0-36 24-58 z"/>
        <path class="hull" d="M36 66 L14 92 q-2 14 6 18 l16-14 z"/>
        <path class="hull" d="M84 66 L106 92 q2 14-6 18 l-16-14 z"/>
        <path class="hull" d="M36 82 h48 v14 q0 6-6 6 H42 q-6 0-6-6 z"/>
        <path class="thin" d="M44 74 H76"/>
        <g class="flame">
          <path class="flame outer" d="M50 102 q10 26 10 30 q0-4 10-30 z"/>
          <path class="flame inner" d="M54 102 q6 18 6 22 q0-4 6-22 z"/>
        </g>`,
      update(rig, state) {
        const m = rig.mem;
        if (!m.init) { m.init = true; m.flame = rig.q('.flame'); m.t = 0; }
        m.t += 1;
        // Length follows thrust: a rocket that is still accelerating is still
        // burning hard. The flicker is on top of that, not instead of it.
        const thrust = Math.max(0.5, Math.min(1.6, 0.6 + state.speed / 400));
        const flick = 1 + 0.22 * Math.sin(m.t * 0.9);
        if (m.flame) m.flame.setAttribute('transform', `translate(60 102) scale(1 ${(thrust * flick).toFixed(2)}) translate(-60 -102)`);
      },
    },
  };

  globalThis.shabbosVehicles = { VEHICLES, DEFS, RAIL, CAR_PITCH, DRIVE_R, ENGINE_S, ENGINE_X };
})();
