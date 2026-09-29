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

  // A turning blade seen from the side sweeps the ELLIPSE of its own disc, not
  // a circle. Spun flat in the plane of the screen it swings out well past the
  // disc it is meant to be inside — a windmill seen face on, bolted to an
  // aircraft seen from beside. `a` is degrees; rx, ry are the disc's radii.
  function sweep(el, a, rx, ry, cx = 0, cy = 0) {
    const r = (a * Math.PI) / 180;
    const x = rx * Math.sin(r);
    const y = ry * Math.cos(r);
    el.setAttribute('d', `M${(cx - x).toFixed(1)} ${(cy - y).toFixed(1)} `
      + `L${(cx + x).toFixed(1)} ${(cy + y).toFixed(1)}`);
  }

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

  // The train is drawn to a LENGTH rather than written out once: its rare
  // moment is an extra carriage, and a train with four of them has to be the
  // same train, a carriage longer, not a second drawing that will drift from
  // the first. Everything downstream — the viewBox, the seats, where the
  // funnel is — comes off the same number.
  const trainArt = (cars) => {
    const ex = cars * CAR_PITCH;
    const idx = [...Array(cars).keys()];
    return ''
      + idx.map((i) => carriageArt(i * CAR_PITCH, i)).join('')
      + idx.map((i) => `<path class="coupler" d="M${i * CAR_PITCH + 108} ${RAIL - 18} `
        + `H${(i + 1) * CAR_PITCH}"/>`).join('')
      + `<g class="engine" transform="translate(${ex} ${RAIL}) scale(${ENGINE_S})">`
      + engineInner() + `</g>`
      + `<g class="rider driver"><path class="shirt" fill="${SHIRTS[3]}" `
      + `d="M${ex + 35 - 31} ${RAIL - 48} q0 -27 31 -27 q31 0 31 27 z"/></g>`;
  };

  // vb, seats and slots for a train of that length. The engine is 244 units
  // long at its own scale, which is what the 252 of spare width is.
  const trainShape = (cars) => ({
    vb: [cars * CAR_PITCH + 252, 185],
    seats: cars + 1,
    slots: [
      ...[...Array(cars).keys()].map((i) => [i * CAR_PITCH + 54, RAIL - 92, 17.2]),
      [cars * CAR_PITCH + 35, RAIL - 88, 17.2],
    ],
    art: trainArt(cars),
    engineX: cars * CAR_PITCH,
  });

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
      // The same distance, in the same units. A face is inside the flight
      // element, so its px ARE artwork units and the element's scale carries
      // both to the screen: multiplying by the scale a second time moved the
      // face further than the shoulders it is meant to sit on.
      if (seat) seat.style.transform = `translateY(${(-bump).toFixed(2)}px)`;
    });

    // FOUR EXHAUST BEATS PER TURN of the driving wheels, each one a puff left
    // in the air. The smoke used to be drawn inside the train and travelled
    // with it, which is precisely why the train never looked like it was
    // moving: nothing was being left behind.
    // Where the engine is depends on how long the train is, and a rare train is
    // a carriage longer: read it off this flight's own spec rather than off the
    // shared one, or a four-carriage train exhausts out of thin air a hundred
    // units behind its funnel.
    const engX = rig.spec?.engineX ?? ENGINE_X;

    // THE WHISTLE. One in fifteen: a jet of white steam, back and up, held for
    // about half a second, and then the train is past. Steam, not smoke — its
    // own system, so it can be white and thin while the exhaust stays grey and
    // fat, and so neither of them is drawn in the other's colour.
    if (rig.rare) {
      if (!m.whistle && state.p > 0.3) m.whistle = rig.t + 1.1;
      if (m.whistle && rig.t < m.whistle) {
        // Marks the flight while its moment is actually on the screen. The
        // reference renders wait for this rather than for a guessed delay.
        rig.el.dataset.moment = '1';
        if (!rig.steam) rig.steam = K.particles(30);
        // ABOVE THE CAB ROOF, and a long way back from the funnel. The world
        // layer sits under the vehicles, so a jet released anywhere the engine
        // covers is a jet nobody sees: at the dome it was inside the exhaust
        // column, and on the boiler it was behind the cab roof.
        const wp = rig.point(engX + 40 * ENGINE_S, RAIL - 114 * ENGINE_S);
        for (let i = 0; i < 2; i += 1) {
          rig.steam.emit({
            x: wp.x, y: wp.y,
            vx: -150 - Math.random() * 110,
            vy: -40 - Math.random() * 60,
            life: 0.85,
            alpha: 0.92,
            size: (5 + Math.random() * 3) * state.scale,
            grow: 20 * state.scale,
          });
        }
      } else if (m.whistle) {
        // Cleared when it stops, so the flag means IS WHISTLING and not HAS
        // WHISTLED: a reference render that waits on the second gets a picture
        // of a train that has finished.
        delete rig.el.dataset.moment;
      }
    }

    const n = K.beats(m.prevAngle, m.angle, 4);
    for (let i = 0; i < n; i += 1) {
      const p = rig.point(engX + 143 * ENGINE_S, RAIL - 113 * ENGINE_S);
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
      // 17.2 * FACE(2.1) = 36: a 72 px face at 1024 wide, the size the room
      // test says survives. The pitch is 116, well clear of the neighbour
      // limit, so the face radius is set by the slot and not by its neighbour.
      ...trainShape(3),
      colour: '#D9544D', speed: 67, lane: 'horizon', dir: 1,
      band: 0.045,
      track: true,
      update: trainUpdate,
      // ONE IN FIFTEEN: it whistles, and it is a carriage longer. The extra
      // carriage is a fourth child on the train rather than a fourth wagon
      // behind an unchanged one, which is why the shape is generated and not
      // written out: vb, seats, slots and the funnel all move with it.
      rare: () => trainShape(4),
      moment: true,
    },

    /* THE BOAT ---------------------------------------------------------------
       It rides a real sea. hullTarget() reads the water under each end of the
       hull and gives back where it wants to sit and how far over; both go
       through a spring, so the boat lags the swell instead of being welded to
       it.

       This replaces two wake paths that slid sideways on CSS timers. The slower
       of them had a 52-unit wavelength and slid 44, so every loop it snapped
       back 8 units — a visible stutter, on a thing whose entire job was to look
       like water. */
    boat: {
      vb: [150, 96], seats: 2, colour: '#4FA3A5', speed: 47, lane: 'horizon', dir: -1,
      band: -0.055,
      slots: [[52, 46, 11], [96, 46, 11]],
      sea: true,
      art: `
        <path class="mast" d="M104 62 V10"/>
        <path class="sail" d="M100 58 V14 q-34 8-44 44 z"/>
        <path class="flag" d="M104 12 q10 3 18 0 q-8 6 0 12 q-10-3-18 0 z"/>
        <path class="hull" d="M12 62 H138 L120 88 H30 z"/>
        <path class="deck" d="M12 62 H138"/>
        <circle class="port" cx="46" cy="72" r="5"/>
        <circle class="port" cx="104" cy="72" r="5"/>
        <path class="bowwave" d="M6 84 q10-8 22-3"/>`,
      update(rig, state, dt) {
        const m = rig.mem;
        if (!m.init) {
          m.init = true;
          m.heave = { x: 0, v: 0 };
          m.tilt = { x: 0, v: 0 };
          m.lastTilt = 0;
          m.cool = 0;
          m.spray = K.particles(24);
          // The sea belongs to the world, not to the boat: it is there for the
          // crossing and the boat moves over it.
          if (rig.world) {
            m.sea = document.createElementNS('http://www.w3.org/2000/svg', 'g');
            m.sea.setAttribute('class', 'sea');
            m.sea.innerHTML = '<path class="far"/><path class="fill"/><path class="surface"/>';
            rig.world.rails.appendChild(m.sea);
            rig.own = m.sea;
          }
        }
        const h = K.clampDt(dt);
        const sc = state.scale || 1;
        const t = rig.t;

        // WHERE THE WATER IS. The band sits on the lane, and only a little way
        // down it: a full-height fill would put sea over the shul cards, which
        // are the one thing on this screen that is not decoration.
        const y0 = state.y + (78 - 96 / 2) * sc;
        if (m.sea) {
          const far = m.sea.querySelector('.far');
          const fill = m.sea.querySelector('.fill');
          const surf = m.sea.querySelector('.surface');
          const W = rig.world.svg.clientWidth || 1024;
          const d = K.seaPath(-40, W + 40, y0, t, sc, 14);
          surf.setAttribute('d', d);
          fill.setAttribute('d', `${d} L${W + 40} ${(y0 + 26 * sc).toFixed(1)} L-40 ${(y0 + 26 * sc).toFixed(1)} Z`);
          // A second, slower surface behind it, for depth.
          far.setAttribute('d', K.seaPath(-40, W + 40, y0 - 9 * sc, t * 0.72, sc * 0.8, 18, 140));
        }

        // HOW THE HULL SITS ON IT. Measured left end to right end in screen
        // space whichever way the boat is heading — kinetics carries a note
        // about why: measured stern to bow, a boat going left came out about
        // 180 degrees over and rendered upside down.
        const want = K.hullTarget(state.x, t, 126 * sc, y0, sc);
        m.heave = K.spring(m.heave, want.y - y0, h, 42, 10);
        m.tilt = K.spring(m.tilt, want.rot, h, 38, 9);
        // THE WHOLE BOAT, crew included. This used to transform a <g> inside
        // the svg, so the hull rolled through the swell and the two faces hung
        // level and motionless in the air above it.
        rig.pose(0, m.heave.x / sc, m.tilt.x, 75, 70);

        // SPRAY ONLY WHEN THE BOW SLAMS. Not every wave — a boat that throws
        // water continuously is a fountain. The trigger is the RATE the tilt is
        // changing, with a cooldown, so one slam is one burst.
        const rate = Math.abs(m.tilt.x - m.lastTilt) / Math.max(h, 1e-3);
        m.lastTilt = m.tilt.x;
        m.cool = Math.max(0, m.cool - h);
        if (rate > 26 && m.cool === 0) {
          m.cool = 0.8;
          const bow = rig.point(state.rot === 0 && (rig.dir ?? -1) < 0 ? 12 : 138, 84);
          for (let i = 0; i < 7; i += 1) {
            rig.spray.emit({
              x: bow.x, y: bow.y,
              vx: (Math.random() - 0.3) * 90 * (state.x > 0 ? -1 : 1),
              vy: -60 - Math.random() * 70,
              life: 0.9,
              size: 2.2 * sc,
              grow: 1.5 * sc,
            });
          }
        }
      },
    },


    /* THE PLANE ---------------------------------------------------------------
       The banner is CLOTH, not a board. A travelling wave runs along its length
       and each face tilts as the ripple reaches it — which is the one thing
       that stops a row of circles on a line reading as a row of circles on a
       line. The tow rope sags, because rope does. */
    plane: {
      vb: [300, 96], seats: 3, colour: '#6E8BD6', speed: 98, lane: 'upper', dir: 1,
      band: -0.045, moment: true,
      // 56 apart, not 50: at 50 the faces are 50.4 across and touch, which
      // reads as one wobbling caterpillar rather than three people.
      //
      // BEHIND the aircraft, which flies to the right. The banner used to run
      // from the nose forwards, so a plane drawn pointing right was pushing its
      // banner along in front of it — every lane travels one way only and
      // nothing is mirrored, so there is no reading of that picture in which it
      // is being towed.
      slots: [[60, 58, 12], [116, 58, 12], [172, 58, 12]],
      art: `
        <g class="banner">
          <path class="cloth" d="M36 58 H196"/>
        </g>
        <path class="rope" d="M227 52 q-16 10-31 6"/>
        <g class="craft" transform="translate(223 0)">
          <path class="fuse" d="M6 44 q0-16 20-16 h28 q16 0 20 16 l4 12 q0 10-12 10 H16 q-12 0-12-10 z"/>
          <path class="wing" d="M18 42 L44 16 h14 l-12 26 z"/>
          <path class="tail" d="M4 42 L-8 22 h10 l10 20 z"/>
          <path class="bubble" d="M22 40 q3-11 16-11 q13 0 16 11 z"/>
          <g class="prop" data-base="translate(70 46)">
            <ellipse class="disc" rx="7" ry="22"/>
            <path class="blade" d="M0 -22 V22"/>
          </g>
        </g>`,

      update(rig, state, dt) {
        const m = rig.mem;
        if (!m.init) {
          m.init = true;
          m.prop = rig.q('.prop');
          m.blade = rig.q('.blade');
          m.cloth = rig.q('.cloth');
          m.a = 0;
        }
        m.a += 22 + state.speed * 0.12;
        // A disc, plus one blade sweeping through it. The disc alone is a grey
        // ellipse; the blade alone is a flicker. Together they read as turning.
        if (m.blade) sweep(m.blade, m.a, 7, 22);

        // The banner ripples, and each face rides its own point of the wave.
        // Travelling BACKWARDS along the cloth, away from the aircraft: the
        // ripple starts where the rope pulls and runs out to the loose end.
        const wave = (x) => 7 * Math.sin((x / 40) + rig.t * 5.5);
        if (m.cloth) {
          let d = 'M36 58';
          for (let x = 46; x <= 196; x += 10) d += ` L${x} ${(58 + wave(x)).toFixed(1)}`;
          m.cloth.setAttribute('d', d);
        }
        // ONE IN FIFTEEN: A LOOP. A circle laid over the lane, not a different
        // lane — LANES stay pure and give back where the plane would have been,
        // and this is how far it has left that for a second and a half. The
        // banner comes round with it, because it is tied on.
        if (rig.rare) {
          const a = (state.p - 0.42) / 0.15;
          if (a > 0 && a < 1) {
            const th = a * Math.PI * 2;
            const R = 86 * (state.scale || 1);
            // Zero at both ends of the turn, so it leaves the path and rejoins
            // it without a step in either position or heading.
            rig.off = {
              x: R * Math.sin(th),
              y: -R * (1 - Math.cos(th)),
              rot: (th * 180) / Math.PI,
            };
            rig.el.dataset.moment = '1';
          } else {
            rig.off = null;
            delete rig.el.dataset.moment;
          }
        }

        [60, 116, 172].forEach((x, k) => {
          const seat = rig.seat(k);
          if (!seat) return;
          const y = wave(x);
          const slope = (wave(x + 8) - wave(x - 8)) / 16;
          // Translate and rotate only — never scale or skew a face.
          seat.style.transform = `translateY(${y.toFixed(2)}px) rotate(${(Math.atan(slope) * 180 / Math.PI).toFixed(1)}deg)`;
        });
      },
    },


    /* THE HELICOPTER -----------------------------------------------------------
       A bubble sized for a whole face, not a porthole with a face behind it.
       It pitches nose down to set off and nose up to stop, from acceleration —
       which is how a helicopter actually moves, and is most of what tells you
       it is one. */
    helicopter: {
      vb: [210, 120], seats: 1, colour: '#5D7CA6', speed: 60, lane: 'upper', dir: 1,
      band: 0.06,
      slots: [[68, 62, 14]],
      art: `
          <path class="boom" d="M104 62 h68 q7 0 7 7 v5 h-75 z"/>
          <path class="fin" d="M168 56 h9 v20 h-9 z"/>
          <path class="body" d="M26 62 q0-30 42-30 q40 0 46 30 l6 18 q0 14-18 14 H42 q-18 0-18-14 z"/>
          <path class="bubble" d="M34 62 q2-22 34-22 q32 0 34 22 z"/>
          <path class="skid" d="M30 106 h64 M44 92 v14 M84 92 v14"/>
          <path class="mast" d="M68 32 V16"/>
          <ellipse class="disc" cx="68" cy="14" rx="74" ry="9"/>
          <path class="rotor" d="M-6 14 L142 14"/>
          <g class="tailrotor" data-base="translate(180 62)"><path d="M0 -16 V16"/></g>`,
      update(rig, state, dt) {
        const m = rig.mem;
        if (!m.init) {
          m.init = true;
          m.rotor = rig.q('.rotor');
          m.tail = rig.q('.tailrotor');
          m.pitch = { x: 0, v: 0 };
          m.a = 0;
        }
        const h = K.clampDt(dt);
        m.a += 26 + state.speed * 0.05;
        // Swept round the disc's ellipse, not spun in the plane of the screen:
        // a rotor seen from the side passes in front of the mast and behind it,
        // it does not stand on end. See VEHICLES.plane.blade.
        if (m.rotor) sweep(m.rotor, m.a, 74, 9, 68, 14);
        if (m.tail) m.tail.setAttribute('transform', `translate(180 62) rotate(${((m.a * 2.6) % 360).toFixed(1)})`);
        // Nose down to go, nose up to stop, and a slow breath while it holds
        // still — the hover lane is the only one that stops.
        const bob = 1.6 * Math.sin(rig.t * 1.7);
        m.pitch = K.spring(m.pitch, Math.max(-12, Math.min(12, -state.accel * 0.05)), h, 34, 10);
        // The airframe, and the pilot in it. Pitching the drawing alone left a
        // face sitting level in a bubble that had tipped forward around it.
        rig.pose(0, bob, m.pitch.x, 68, 62);
      },
    },


    /* THE CAR ---------------------------------------------------------------
       A CONVERTIBLE, because a roof is a lid over the one thing worth looking
       at. The driver sits up out of it and the face keeps its size.

       The body leans, pitches and squats; the WHEELS DO NOT. A car's wheels
       stay on the road while its body rolls about above them, and leaning the
       whole vehicle is the tell that it is a picture being tilted rather than a
       car taking a bend. */
    car: {
      vb: [150, 92], seats: 1, colour: '#E0A030', speed: 80, lane: 'lap', dir: 1,
      moment: true,
      // 11 * FACE(2.1) = 23 units, which is 104 px across at 1024 wide. The
      // floor is 70 and this was set at 15, giving 142 — a head wider than the
      // bonnet. Rule 1 is a floor, not a target: past a point a bigger face
      // stops helping and starts being a balloon on a trolley.
      slots: [[74, 33, 11]],
      art: `
        <g class="susp">
          <g class="shell">
            <path class="lamp back" d="M8 60 h9 q4 0 4 4 v7 q0 4-4 4 H8 z"/>
            <path class="lamp front" d="M142 60 h-9 q-4 0-4 4 v7 q0 4 4 4 h9 z"/>
            <path class="flank" d="M14 74 L20 54 q4-12 18-12 h74 q14 0 19 12 l9 20 z"/>
            <path class="tub" d="M46 52 q4-7 13-7 h30 q9 0 13 7 l4 10 H42 z"/>
            <path class="screen" d="M96 44 q9 1 13 9 h-17 z"/>
            <path class="sill" d="M10 70 H140 q6 0 6 6 v4 q0 6-6 6 H10 q-6 0-6-6 v-4 q0-6 6-6 z"/>
            <path class="blink left" d="M16 54 h10 v7 h-10 z"/>
            <path class="blink right" d="M124 54 h10 v7 h-10 z"/>
          </g>
        </g>
        <g class="honk">
          <path d="M150 50 q9-4 15-10"/>
          <path d="M152 60 H168"/>
          <path d="M150 70 q9 4 15 10"/>
        </g>
        <g class="wheel" data-base="translate(38 78)">
          <circle class="tyre" r="13"/><circle class="hub" r="4.5"/>
          <path class="spokes" d="M0 -10 V10 M-10 0 H10"/>
        </g>
        <g class="wheel" data-base="translate(114 78)">
          <circle class="tyre" r="13"/><circle class="hub" r="4.5"/>
          <path class="spokes" d="M0 -10 V10 M-10 0 H10"/>
        </g>`,
      update(rig, state, dt) {
        const m = rig.mem;
        if (!m.init) {
          m.init = true;
          m.shell = rig.q('.shell');
          m.susp = rig.q('.susp');
          m.wheels = rig.qa('.wheel');
          m.back = rig.q('.lamp.back');
          m.blinks = rig.qa('.blink');
          m.honk = rig.q('.honk');
          m.lean = { x: 0, v: 0 };
          m.pitch = { x: 0, v: 0 };
          m.head = { x: 0, v: 0 };
          m.prevRot = state.rot;
        }
        const h = K.clampDt(dt);

        // WHEELS ROLL, they do not spin on a timer. They used to turn once every
        // 0.42s whatever the car was doing — about 4.3x faster than it actually
        // travelled — so they skidded the entire lap.
        const deg = (K.wheelAngle(state.dist / (state.scale || 1), 13) * 180) / Math.PI;
        for (const wd of m.wheels) wd.setAttribute('transform', `${wd.dataset.base} rotate(${deg.toFixed(1)})`);

        // Lean out of the bend, from lateral acceleration. The turn rate gives
        // the radius: r = v / omega.
        // The DELTA first, then the new previous. Read after prevRot had been
        // updated, `state.rot - m.prevRot` is exactly zero every frame, so the
        // side always came out the same one and the car leant the same way into
        // both left and right corners.
        const dRot = state.rot - m.prevRot;
        const turn = Math.abs(dRot) / Math.max(h, 1e-3);   // deg/s
        m.prevRot = state.rot;
        const omega = (turn * Math.PI) / 180;
        const radius = omega > 0.02 ? state.speed / omega : 0;
        // Heading falls (0, -90, -180) turning right, in CSS degrees: a falling
        // heading is a right-hand bend, and a car in one leans left, out of it.
        const side = dRot <= 0 ? 1 : -1;
        const want = radius > 0 ? Math.min(14, K.lateral(state.speed, radius) * 0.02) : 0;
        m.lean = K.spring(m.lean, want * side, h, 45, 11);

        // Nose dips under braking, squats under power.
        m.pitch = K.spring(m.pitch, Math.max(-5, Math.min(5, -state.accel * 0.012)), h, 50, 12);
        if (m.shell) {
          m.shell.setAttribute('transform',
            `rotate(${m.lean.x.toFixed(2)} 75 74) rotate(${m.pitch.x.toFixed(2)} 75 74)`);
        }

        // THE RIDER STAYS UPRIGHT. At the top of the lap the car is upside down
        // and the person in it is not. Through a spring, so the head lags the
        // body by a beat instead of snapping level.
        m.head = K.spring(m.head, -state.rot, h, 38, 11);
        const seat = rig.seat(0);
        if (seat) seat.style.transform = `rotate(${m.head.x.toFixed(2)}deg)`;

        // ONE IN FIFTEEN: TWO SHORT BLASTS. Lines off the bonnet, on for a
        // tenth of a second each — a horn is not a light and does not glow, it
        // is there and then it is not. The group scales about the bonnet; no
        // face is inside it.
        if (rig.rare && m.honks === undefined && state.p > 0.22) m.honks = rig.t;
        if (m.honks !== undefined && m.honk) {
          const e = rig.t - m.honks;
          const on = (e > 0 && e < 0.13) || (e > 0.28 && e < 0.41);
          if (on) rig.el.dataset.moment = '1';
          m.honk.style.opacity = on ? '0.95' : '0';
          m.honk.style.transform = on ? `scale(${(1 + (e % 0.13) * 1.4).toFixed(2)})` : 'scale(1)';
        }

        // Brake lights while slowing; indicator before a bend.
        if (m.back) m.back.style.opacity = state.accel < -12 ? '1' : '0.25';
        const soon = Math.abs(state.rot % 90) > 0.5 || turn > 1;
        const on = soon && Math.floor(state.dist / 26) % 2 === 0;
        for (const b of m.blinks) b.style.opacity = on ? '1' : '0';
      },
    },


    /* THE BALLOON --------------------------------------------------------------
       The burner is the whole point of a balloon at night: it flares, it lights
       the envelope FROM INSIDE, and the lift follows the same clock, because
       the flare is what the lift is for. Faces sit over the basket rim, not
       inside a box. */
    balloon: {
      vb: [150, 168], seats: 2, colour: '#A96FA0', speed: 24, lane: 'rise',
      moment: true,
      // OVER the rim, not in front of the basket. At y=140 the faces covered
      // the basket entirely, which reads as two heads on a rope.
      slots: [[56, 118, 12], [96, 118, 12]],
      art: `
          <path class="env" d="M75 6 q46 0 46 46 q0 32-28 52 H57 q-28-20-28-52 q0-46 46-46 z"/>
          <path class="panel a" d="M75 6 q-18 23-18 50 q0 26 11 48 h-11 q-28-20-28-52 q0-46 46-46 z"/>
          <path class="panel b" d="M75 6 q18 23 18 50 q0 26-11 48 h11 q28-20 28-52 q0-46-46-46 z"/>
          <ellipse class="inner" cx="75" cy="58" rx="40" ry="44"/>
          <path class="rope" d="M52 104 L60 126 M98 104 L90 126"/>
          <path class="burner" d="M68 110 h14 l-3 -14 q-4 -9-8 0 z"/>
          <path class="basket" d="M52 124 h46 q6 0 6 6 v22 q0 6-6 6 H52 q-6 0-6-6 v-22 q0-6 6-6 z"/>
          <path class="rim" d="M46 130 H104"/>
          <circle class="sandbag" cx="46" cy="158" r="7"/>
        <circle class="sandbag" cx="104" cy="158" r="7"/>`,
      update(rig, state, dt) {
        const m = rig.mem;
        if (!m.init) {
          m.init = true;
          m.burner = rig.q('.burner');
          m.inner = rig.q('.inner');
          m.rise = { x: 0, v: 0 };
        }
        const h = K.clampDt(dt);
        // One clock for the burn and the lift.
        const phase = (rig.t % 4.2) / 4.2;
        const burn = phase > 0.66 && phase < 0.9
          ? Math.sin(((phase - 0.66) / 0.24) * Math.PI) : 0;
        if (m.burner) {
          m.burner.style.opacity = (0.15 + burn * 0.85).toFixed(2);
          m.burner.style.transform = `scaleY(${(0.25 + burn * 1.1).toFixed(2)})`;
        }
        // Lit from inside, and ONLY AT NIGHT: a glow on a white wall is a
        // smudge. Handed to the stylesheet as a number rather than written as
        // an opacity, because an inline opacity would beat the day rule and the
        // glow would burn through the afternoon.
        if (m.inner) m.inner.style.setProperty('--burn', burn.toFixed(3));

        // ONE IN FIFTEEN: A SANDBAG GOES. It is cut loose, it falls, and the
        // balloon answers by climbing — which is the only reason anyone ever
        // threw one over the side.
        if (rig.rare && !m.dropped && state.p > 0.36) {
          m.dropped = true;
          rig.el.dataset.moment = '1';
          const bag = rig.qa('.sandbag')[0];
          const at = rig.point(46, 158 + m.rise.x);
          if (bag) bag.style.display = 'none';
          rig.drop('<circle class="sandbag" r="7"/>', {
            x: at.x, y: at.y, vx: -14, vy: 10, spin: 40, life: 2.8, scale: state.scale || 1,
          });
          m.lighter = 9;
        }
        m.lighter = Math.max(0, (m.lighter ?? 0) - h * 3);
        m.rise = K.spring(m.rise, -burn * 5 - m.lighter, h, 26, 9);
        // Envelope, basket, ropes, sandbags AND the two faces over the rim:
        // lifting the artwork alone left the passengers behind on every flare.
        rig.pose(0, m.rise.x);
      },
    },


    /* THE PARACHUTE ------------------------------------------------------------
       It swings FROM THE CANOPY. `pivot` was declared here and read by nothing,
       so it turned about its own middle and the canopy and the rider swung in
       opposite directions — which is not how anything hanging from anything has
       ever moved. The pivot is honoured in fly() now.

       The canopy fills in a glide and slackens in a stall; the legs dangle and
       swing a beat behind the body, through a spring. */
    parachute: {
      vb: [140, 170], seats: 1, colour: '#6FA96B', speed: 29, lane: 'leaf',
      slots: [[70, 124, 13]],
      pivot: [70, 34],
      art: `
        <g class="canopy">
          <path class="dome" d="M10 68 q0-58 60-58 q60 0 60 58 q-26-13-60-13 q-34 0-60 13 z"/>
          <path class="gore" d="M40 60 q8-40 30-50 M100 60 q-8-40-30-50"/>
        </g>
        <path class="lines" d="M10 68 L58 116 M70 55 L70 116 M130 68 L82 116"/>
        <g class="rider">
          <path class="body" d="M54 112 h32 q6 0 6 7 v20 q0 7-6 7 H54 q-6 0-6-7 v-20 q0-7 6-7 z"/>
          <g class="legs"><path d="M60 146 V164 M80 146 V164"/></g>
        </g>`,
      update(rig, state, dt) {
        const m = rig.mem;
        if (!m.init) {
          m.init = true;
          m.dome = rig.q('.dome');
          m.legs = rig.q('.legs');
          m.swing = { x: 0, v: 0 };
          m.lastRot = state.rot;
        }
        const h = K.clampDt(dt);
        // Fills in a glide, slackens in a stall. Scale on the CANOPY only —
        // never on anything carrying a face.
        const fill = 0.94 + Math.min(0.1, state.speed / 900);
        if (m.dome) m.dome.setAttribute('transform', `translate(70 68) scale(${fill.toFixed(3)} ${(2 - fill).toFixed(3)}) translate(-70 -68)`);
        // The legs trail the body by a beat.
        const swayTo = (state.rot - m.lastRot) * 6;
        m.lastRot = state.rot;
        m.swing = K.spring(m.swing, Math.max(-22, Math.min(22, swayTo)), h, 24, 7);
        if (m.legs) m.legs.setAttribute('transform', `rotate(${m.swing.x.toFixed(2)} 70 146)`);
      },
    },


    /* THE DANCER ---------------------------------------------------------------
       Two-segment limbs, so there are elbows and knees: a straight line from
       shoulder to hand swinging about one joint is a signpost, not an arm.
       Clothes in colour, and musical notes left behind in the air. */
    dancer: {
      vb: [110, 160], seats: 1, colour: '#D98CB3', speed: 42, lane: 'promenade', dir: 1,
      slots: [[55, 30, 14]],
      art: `
        <circle class="head" cx="55" cy="30" r="19"/>
        <path class="shirt" d="M36 56 q0-8 19-8 q19 0 19 8 v30 q0 6-6 6 H42 q-6 0-6-6 z"/>
        <path class="shorts" d="M38 88 h34 v16 q0 5-5 5 H43 q-5 0-5-5 z"/>
        <g class="arm left">
          <path class="upper" d="M40 62 L26 82"/>
          <g class="fore" data-base="translate(26 82)"><path d="M0 0 L-14 18"/><circle class="hand" cx="-14" cy="18" r="4"/></g>
        </g>
        <g class="arm right">
          <path class="upper" d="M70 62 L84 82"/>
          <g class="fore" data-base="translate(84 82)"><path d="M0 0 L14 18"/><circle class="hand" cx="14" cy="18" r="4"/></g>
        </g>
        <g class="leg left">
          <path class="upper" d="M46 106 L38 130"/>
          <g class="shin" data-base="translate(38 130)"><path d="M0 0 L-6 26"/><path class="foot" d="M-6 26 H-18"/></g>
        </g>
        <g class="leg right">
          <path class="upper" d="M64 106 L72 130"/>
          <g class="shin" data-base="translate(72 130)"><path d="M0 0 L6 26"/><path class="foot" d="M6 26 H18"/></g>
        </g>`,
      update(rig, state, dt) {
        const m = rig.mem;
        if (!m.init) {
          m.init = true;
          m.arms = rig.qa('.arm');
          m.fores = rig.qa('.fore');
          m.legs = rig.qa('.leg');
          m.shins = rig.qa('.shin');
          m.next = 0;
        }
        const t = rig.t;
        // Each joint on its own tempo, none a multiple of another, so the pose
        // never lands on a beat and it does not read as two frames.
        const sw = (hz, amp, ph) => amp * Math.sin(t * hz + ph);
        m.arms.forEach((a, k) => a.setAttribute('transform',
          `rotate(${sw(6.4 + k * 0.7, 38, k * 2.1).toFixed(1)} ${k ? 70 : 40} 62)`));
        m.fores.forEach((f, k) => f.setAttribute('transform',
          `${f.dataset.base} rotate(${sw(7.9 - k * 0.6, 34, 1.3 + k).toFixed(1)})`));
        m.legs.forEach((l, k) => l.setAttribute('transform',
          `rotate(${sw(5.1 + k * 0.5, 16, 0.6 + k * 1.7).toFixed(1)} ${k ? 64 : 46} 106)`));
        m.shins.forEach((sh, k) => sh.setAttribute('transform',
          `${sh.dataset.base} rotate(${sw(6.8 - k * 0.4, 20, 2.4 + k).toFixed(1)})`));

        // Notes, drifting up and back. They belong to the air like everything
        // else released into the world, so the dancer walks away from them.
        if (t > m.next) {
          m.next = t + 0.55 + Math.random() * 0.5;
          if (!rig.notes) rig.notes = K.particles(16);
          const p = rig.point(80, 12);
          rig.notes.emit({
            x: p.x, y: p.y,
            vx: -26 - Math.random() * 20, vy: -34 - Math.random() * 18,
            life: 2.1, size: 9 * (state.scale || 1),
            spin: (Math.random() < 0.5 ? -1 : 1) * (20 + Math.random() * 25),
          });
        }
      },
    },


    /* THE ROCKET ---------------------------------------------------------------
       A porthole sized for a whole face. The flame's length follows thrust, and
       the exhaust column STAYS HANGING in the air — a rocket whose smoke goes up
       with it is a rocket standing still. */
    rocket: {
      vb: [150, 176], seats: 1, colour: '#C2703D', speed: 200, lane: 'launch',
      moment: true,
      slots: [[75, 52, 13]],
      art: `
        <path class="shell" d="M75 6 q30 28 30 72 v30 H45 V78 q0-44 30-72 z"/>
        <path class="fin" d="M45 84 L18 116 q-3 17 8 22 l19-17 z"/>
        <path class="fin" d="M105 84 L132 116 q3 17-8 22 l-19-17 z"/>
        <path class="skirt" d="M45 106 h60 v18 q0 8-8 8 H53 q-8 0-8-8 z"/>
        <path class="stripe" d="M52 96 H98"/>
        <g class="flame" data-base="translate(75 132)">
          <path class="outer" d="M-13 0 q13 34 13 40 q0-6 13-40 z"/>
          <path class="inner" d="M-7 0 q7 24 7 28 q0-4 7-28 z"/>
        </g>`,
      update(rig, state, dt) {
        const m = rig.mem;
        if (!m.init) { m.init = true; m.flame = rig.q('.flame'); m.next = 0; m.f = 0; }
        m.f += 1;
        const sc = state.scale || 1;
        const thrust = Math.max(0.45, Math.min(1.7, 0.5 + state.speed / 520));
        const flick = 1 + 0.2 * Math.sin(m.f * 0.9);
        if (m.flame) {
          m.flame.setAttribute('transform',
            `${m.flame.dataset.base} scale(1 ${(thrust * flick).toFixed(2)})`);
        }

        // ONE IN FIFTEEN: IT DROPS A STAGE. The skirt goes, and the same skirt
        // reappears in the world layer as something falling away — it stopped
        // being part of the rocket at the moment it was let go, so it does not
        // travel with it. A burst out of the joint covers the separation, which
        // is the whole visual point of a staging: a bang, and then two objects
        // where there was one.
        if (rig.rare && !m.staged && state.p > 0.42) {
          m.staged = true;
          rig.el.dataset.moment = '1';
          const j = rig.point(75, 124);
          rig.q('.skirt')?.style.setProperty('display', 'none');
          rig.drop('<g transform="translate(-75 -116)">'
            + '<path class="skirt" d="M45 106 h60 v18 q0 8-8 8 H53 q-8 0-8-8 z"/></g>', {
            x: j.x, y: j.y, vx: (Math.random() - 0.5) * 60, vy: 40, spin: 90, life: 2.4, scale: sc,
          });
          for (let i = 0; i < 12; i += 1) {
            rig.smoke.emit({
              x: j.x, y: j.y,
              vx: (Math.random() - 0.5) * 320, vy: (Math.random() - 0.2) * 190,
              life: 0.8, size: 4 * sc, grow: 22 * sc,
            });
          }
        }
        // The column is left where it was burnt.
        if (rig.t > m.next) {
          m.next = rig.t + 0.045;
          const p = rig.point(75, 150);
          rig.smoke.emit({
            x: p.x + (Math.random() - 0.5) * 8 * sc,
            y: p.y,
            vx: (Math.random() - 0.5) * 30, vy: 18 + Math.random() * 26,
            life: 1.9, size: 5 * sc, grow: 26 * sc,
          });
        }
      },
    },

  };

  globalThis.shabbosVehicles = { VEHICLES, DEFS, RAIL, CAR_PITCH, DRIVE_R, ENGINE_S, ENGINE_X };
})();
