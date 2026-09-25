/* Shabbos Clock — everything that paints.

   Loaded as ordinary scripts, in the order index.html lists them, sharing one
   script scope. Not ES modules: jsdom cannot load <script type="module"> at
   all, and both behavioural suites work by loading the real index.html and
   running the real app inside it. Splitting the file was worth doing; giving up
   that harness to get import statements was not. */

const PER_PAGE = 3;
let page = 0;

/* Rendering ------------------------------------------------------------- */

// The shuls on the board, in the order the person put them in.
//
// This used to filter the master list, which is alphabetical — so settings.shuls
// recorded WHICH shuls were chosen and silently discarded the order, and someone
// selecting six had no way to decide which three landed on the first page.
// Mapping over settings.shuls makes that array mean what it looks like it means.
function chosenShuls() {
  const bySlug = new Map(shuls.map((s) => [s.slug, s]));
  return settings.shuls.map((slug) => bySlug.get(slug)).filter(Boolean);
}

// Which page of them is up, when there are more than fit at once.
function pageInfo() {
  const total = chosenShuls().length;
  if (total <= PER_PAGE) return null;
  const pages = Math.ceil(total / PER_PAGE);
  return { at: page % pages, pages };
}

function shownShuls() {
  const chosen = chosenShuls();
  const info = pageInfo();
  if (!info) return chosen;
  const start = info.at * PER_PAGE;
  return chosen.slice(start, start + PER_PAGE);
}

// Two dots and no explanation. The board rotates every 45 seconds whether or
// not anyone is watching, and until this there was nothing to say that the
// other three shuls existed at all.
function renderPager() {
  const el = $('pager');
  if (!el) return;
  const info = pageInfo();
  el.hidden = !info;
  if (!info) { el.innerHTML = ''; return; }
  const html = Array.from({ length: info.pages },
    (_, i) => `<i class="${i === info.at ? 'on' : ''}"></i>`).join('');
  if (html !== el.innerHTML) el.innerHTML = html;
}

const GROUPS = { shacharis: 'Shacharis', mincha: 'Mincha', maariv: 'Maariv' };
let lastBoard = '';
let lastMarks = '';

function render() {
  const now = new Date();
  const info = dayInfo(now);

  document.body.classList.toggle('day', themeIsDay(now, info));
  document.body.dataset.accent = settings.accent;
  document.body.dataset.face = settings.face;
  const locked = isLocked(now, info);
  document.body.classList.toggle('locked', locked);
  document.body.classList.toggle('clock-only', settings.layout === 'clock');
  if (locked) $('sheet').hidden = true;   // never leave settings open into Shabbos
  document.documentElement.style.setProperty('--clock-scale', settings.clockSize);

  $('hebrewDate').textContent = fmtHeb.format(info.hebrew.jc);
  $('occasion').textContent = occasionOf(info.hebrew.jc, info.hebrewFor);
  $('civilDate').textContent = now.toLocaleDateString('en-US',
    { weekday: 'long', month: 'long', day: 'numeric' });

  renderEdge(now, info);
  renderZmanim(info);
  // Everything that claims a band goes first, and the cards fit what is left.
  // renderShuls ends by MEASURING the cell it was given, so anything inserted
  // after it has already been measured around — with the strip painted last,
  // the first frame sized the type against a board that was about to lose
  // 15vh to the weather, and a portrait card clipped its own times until the
  // next render corrected it thirty seconds later.
  renderHorizon(now, info);
  // The scores borrow this band for half a minute at a time. Both painters own
  // the same element, so each clears the other's memo on the way in or the
  // swap back would be skipped as "nothing changed".
  if (sportsUp()) { lastWeather = ''; renderSports(now); }
  else { lastSports = ''; $('weather').className = 'weather'; renderWeather(now, info); }
  // One list, so the footer describes the same span the cards do.
  const days = daysShown(now, info);
  renderShuls(now, days);
  renderPager();
  renderFreshness(now, days);
}

function themeIsDay(now, info) {
  if (settings.theme !== 'auto') return settings.theme === 'day';
  return now >= toDate(info.cal.getSunrise()) && now < info.sunset;
}

// Formatted by hand: some iOS builds separate the meridiem with U+202F rather
// than a space, which breaks any parse of toLocaleTimeString output.
function hhmm(d) {
  return { hour: d.getHours() % 12 || 12,
    minute: String(d.getMinutes()).padStart(2, '0'),
    meridiem: d.getHours() < 12 ? 'am' : 'pm' };
}

// The full meridiem. It was a single letter to save width back when the tile
// was narrow enough for that to matter; "6:41p" reads as a typo on a wall.
const clockTime = (d) => { const t = hhmm(d); return `${t.hour}:${t.minute}${t.meridiem}`; };
// The shape clockFace parses, so the horizon sets its meridiems exactly as the
// cards do rather than inventing a second convention.
const clockTimeLong = (d) => { const t = hhmm(d); return `${t.hour}:${t.minute} ${t.meridiem.toUpperCase()}`; };

// Nightfall is a fact; havdalah is a practice, and the two shuls that have one
// hold by their own motzei Shabbos maariv plus a fixed few minutes. That is the
// number their members actually wait on, so it beats a computed tzeis — but it
// only exists for a shul we have both an offset and a maariv time for.
function havdalahFor(slug, endDay) {
  const day = minyanim.days?.[isoOf(endDay)]?.[slug];
  // If the shul publishes when its fast or Shabbos ends, that is the answer and
  // no arithmetic can improve on it.
  const published = timeToDate(endDay, day?.edge?.havdalah ?? '');
  if (published) return published;

  const mins = shuls.find((s) => s.slug === slug)?.havdalahAfterMaariv;
  if (!mins) return null;
  const times = (day?.maariv ?? [])
    // Neila and Kol Nidrei sit in the evening bucket but neither is the maariv
    // the practice counts from; measuring off Neila put havdalah an hour early.
    .filter((row) => !/neila|ne'?ilah?|kol ?nidre/i.test(row.label ?? ''))
    .map((row) => timeToDate(endDay, row.time)).filter(Boolean)
    .sort((a, b) => a - b);
  // The maariv that ends the day, not an earlier one sharing the slot.
  const sunset = toDate(zmanim(endDay).getSunset());
  const maariv = times.find((t) => t >= sunset) ?? times[0];
  return maariv ? new Date(maariv.getTime() + mins * 60000) : null;
}

// One time when the shuls on screen agree, one line each when they do not —
// which is the whole point, since they end Shabbos minutes apart. With nothing
// shul-specific to show we fall back to tzeis, the town-wide answer.
function havdalahLines(now) {
  const end = restEnd(now);
  if (!end) return [];
  const shown = shownShuls();
  const per = shown.map((s) => ({ name: s.name, at: havdalahFor(s.slug, end.day) }))
    .filter((r) => r.at);
  if (!per.length) return [`Havdalah <b>${clockTime(end.tzeis)}</b>`];
  const distinct = new Set(per.map((r) => clockTime(r.at)));
  // An unlabelled time has to speak for every shul on screen, so it is only
  // safe when they all agree AND none of them is missing from the list.
  if (distinct.size === 1 && per.length === shown.length) {
    return [`Havdalah <b>${[...distinct][0]}</b>`];
  }
  return ['Havdalah', ...per.map((r) => `${r.name} <b>${clockTime(r.at)}</b>`)];
}

/* A shul's own edges, in a shul's own box ----------------------------------

   Candle lighting and havdalah used to live in the tile beside the clock: one
   candle time for a town whose two shuls light at 6:30 and 6:31, and a
   havdalah that had to print each shul's NAME beside it because they differ by
   minutes. Both scrapers now bring back each shul's own published edges, so
   they belong in that shul's own box beside its own minyanim, where nothing
   needs labelling to say whose it is.

   The shul's published time wins. The fallback is a calculation, and it is
   only there so a shul that publishes nothing still shows something. */
function edgeRowsFor(slug, day) {
  const out = [];
  const published = minyanim.days?.[isoOf(day)]?.[slug]?.edge ?? {};
  const jc = new JewishDay(day).jc;
  const resting = jc.isAssurBemelacha();
  const more = jc.isTomorrowShabbosOrYomTov();

  if (more) {
    const afterDark = resting && day.getDay() !== 5;
    const at = timeToDate(day, published.candles ?? '')
      // Erev Shabbos or a first night: eighteen minutes before sunset is a
      // published standard and is what every shul here prints, so calculating
      // it puts nothing on the wall that anybody disputes.
      //
      // A SECOND night is different and must not be calculated. Nothing is lit
      // until the previous day is out, and which nightfall a shul holds by for
      // that is its own — Beth Aaron prints 7:39pm for a night this computed
      // 7:26pm from tzeis, so the wall was telling people to light thirteen
      // minutes into Yom Tov. There is no standard to fall back on here, so
      // when a shul has not published one, nothing is shown.
      ?? (afterDark ? null : toDate(zmanim(day).getCandleLighting()));
    if (at) out.push({ label: afterDark ? 'Candles after' : 'Candles', at });
  }
  // Havdalah belongs to the day the rest actually ENDS, not to each day of it.
  if (resting && !more) {
    const at = havdalahFor(slug, day);
    if (at) out.push({ label: 'Havdalah', at });
    else {
      // This shul publishes no havdalah and keeps no offset we know of, so it
      // does not get handed somebody else's. Nightfall is the town-wide fact
      // and is named as such rather than dressed up as this shul's practice.
      const dark = toDate(zmanim(day).getTzais());
      if (dark) out.push({ label: 'Nightfall', at: dark });
    }
  }
  return out;
}

function renderEdge(now, info) {
  // The board carries these in the cards now, one shul at a time. This tile is
  // kept for the clock-only layout, which hides the cards altogether — take it
  // away there and the one mode with nothing else on screen would be the one
  // mode that never says when Shabbos is out.
  if (settings.layout !== 'clock') {
    $('edge').innerHTML = '';
    $('edge').hidden = true;
    return;
  }
  const jc = info.civil.jc;
  const candles = toDate(info.cal.getCandleLighting());
  const restingNow = jc.isAssurBemelacha() && now < info.tzeis;
  const restingNext = jc.isTomorrowShabbosOrYomTov();
  const parts = [];
  if (restingNow && restingNext) {
    // Another day of rest starts tonight. Into Shabbos, lighting is at the usual
    // time; into a second day of Yom Tov, nothing is lit until nightfall.
    const intoShabbos = now.getDay() === 5;
    const lightAt = intoShabbos ? candles : info.tzeis;
    if (now < lightAt) {
      parts.push(`Candles ${intoShabbos ? '' : 'after '}<b>${clockTime(lightAt)}</b>`);
    }
    parts.push(...havdalahLines(now));
  } else if (isLocked(now, info)) {
    parts.push(...havdalahLines(now));
  } else if (restingNext && now < candles) {
    // Both ends, not just the one about to happen. Knowing Shabbos is in at
    // 6:41 is half the question; the other half is when it is out.
    parts.push(`Candles <b>${clockTime(candles)}</b>`, ...havdalahLines(now));
  }
  // On an ordinary weekday there is no transition to announce. Hide the element
  // rather than leaving an empty one contributing a gap to the column.
  // One line per fact. The tile is only as wide as the Hebrew date, so an inline
  // separator always wrapped anyway and left the dot dangling off the first line.
  $('edge').innerHTML = parts.map((p) => `<span class="line">${p}</span>`).join('');
  $('edge').hidden = !parts.length;
}

// Netz, shkiya and tzeis, in the tile beside the clock. They used to appear
// only on the horizon, so turning that off — which is now the default — left
// them nowhere. These are the three that pace the day; the setting adds the
// rest for anyone who wants them.
let lastZmanim = '';

function renderZmanim(info) {
  const cal = info.cal;
  // Each zman by its own name, and then what it is for. "Netz" on its own
  // assumes you already know; the pairing is how a luach reads.
  const rows = [['נץ החמה', 'Earliest Shacharis', toDate(cal.getSunrise()), 'netz']];
  if (settings.showZmanim) {
    rows.push(['סוף זמן שמע', 'Latest Shema', toDate(cal.getSofZmanShmaGRA()), 'mid'],
      ['מנחה גדולה', 'Earliest Mincha', toDate(cal.getMinchaGedola()), 'mid'],
      ['פלג המנחה', 'Early Maariv', toDate(cal.getPlagHamincha()), 'mid']);
  }
  rows.push(['שקיעה', 'Sunset', info.sunset, 'shkiya'],
    ['צאת הכוכבים', 'Nightfall', info.tzeis, 'tzeis']);

  // dir on the Hebrew span, so the pipe and the English stay to its right
  // instead of the bidi algorithm reordering the line.
  const html = rows.filter(([, , d]) => d).map(([heb, eng, d, kind]) =>
    `<div class="zrow ${kind}">`
    + `<div class="zname"><span class="zheb" dir="rtl">${esc(heb)}</span>`
    + `<span class="zsep">|</span><span class="zeng">${esc(eng)}</span></div>`
    + `<div class="ztime">${clockFace(clockTimeLong(d))}</div></div>`).join('');
  if (html !== lastZmanim) {
    lastZmanim = html;
    $('zmanimList').innerHTML = html;
  }
}

// One writer for the board, so every state updates the cache. Writing the DOM
// directly anywhere else leaves lastBoard stale and the next identical render
// gets skipped.
function paintBoard(html) {
  if (html === lastBoard) return;
  lastBoard = html;
  $('shuls').innerHTML = html;
}

// Cleared before every measurement, or a card keeps the size it was given for
// different content and the search starts from a lie.
function resetCardScales() {
  for (const card of document.querySelectorAll('.card')) {
    card.style.removeProperty('--minyan-scale');
  }
}

// A card wide enough for this much gets its content in two columns.
//
// On a wide screen a card was using under a third of its own width: one narrow
// list of "SHACHARIS 6:30pm" down the left and two thirds of the panel empty,
// while the HEIGHT was the thing rationing how many times could be shown at a
// readable size. Height was scarce and width was idle. Two columns spend the
// idle one: the same rows in half the height, so the type stays large and twice
// as many times fit.
const COLUMN_AT = 460;

// Columns break between DAYS, never inside one.
//
// Dealt by line count alone, a column ended with "Tomorrow · Succos I" at its
// foot and that day's times at the head of the next — and a row could land in
// the second column with its heading left behind in the first, which is worse
// than the empty space this was meant to reclaim: a time under no day at all.
// A day is the unit, so a heading always leads its own column.
//
// With fewer days than columns there is nothing to break on, so the card stays
// single-column rather than splitting a day across two.
function dealIntoColumns(blocks, columns) {
  if (!blocks.length) return '';
  const one = () => blocks.map((b) => b.html).join('');
  if (columns < 2) return one();

  // Gather each heading with the rows that belong to it.
  const days = [];
  for (const b of blocks) {
    if (b.head || !days.length) days.push({ blocks: [], lines: 0 });
    const day = days[days.length - 1];
    day.blocks.push(b);
    day.lines += b.lines;
  }
  if (days.length < columns) return one();

  // A card holds a handful of days at most, so the split is simply solved: try
  // every way of cutting the run into that many contiguous groups and keep the
  // one whose tallest column is shortest. Greedy got this wrong — running left
  // to right against a target, its "can I still fill the columns left" guard
  // vetoed the only legal cut on a three-day card and the whole thing collapsed
  // back into a single column.
  const cuts = [];
  const search = (start, left, acc) => {
    if (left === 1) { cuts.push([...acc, days.length]); return; }
    for (let end = start + 1; end <= days.length - (left - 1); end += 1) {
      search(end, left - 1, [...acc, end]);
    }
  };
  search(0, columns, []);

  const lines = (from, to) => days.slice(from, to).reduce((n, d) => n + d.lines, 0);
  let best = null;
  let bestTall = Infinity;
  for (const cut of cuts) {
    let from = 0;
    let tall = 0;
    for (const to of cut) { tall = Math.max(tall, lines(from, to)); from = to; }
    if (tall < bestTall) { bestTall = tall; best = cut; }
  }

  const cols = [];
  let from = 0;
  for (const to of best) { cols.push(days.slice(from, to).flatMap((d) => d.blocks)); from = to; }
  return cols.map((c) => `<div class="col">${c.map((b) => b.html).join('')}</div>`).join('');
}

function renderShuls(now, days) {
  const list = shownShuls();
  if (!list.length) {
    paintBoard('<p class="none">No shuls chosen. Open Settings to pick some.</p>');
    return;
  }

  // How wide each card will be, worked out before anything is painted: the band
  // is already laid out, and the cards divide it evenly.
  const band = $('shuls').clientWidth;
  const gap = 22 * (list.length - 1);
  const padding = 52;
  const cardInner = band ? (band - gap) / list.length - padding : 0;
  const columns = cardInner >= COLUMN_AT ? 2 : 1;

  // Counted per card, not pooled. Averaging across the board let one heavy shul
  // hide behind two light ones and clip its own times.
  const build = (cap, withEdges = true) => {
  const perCardLines = [];
  let lines = 0;

  const cards = list.map((shul) => {
    lines = 0;
    const s = scheduleFor(shul.slug, now, days);
    if (s.state === 'unavailable') {
      lines += 1;
      perCardLines.push(lines);
      return card(shul.name, `<p class="unavailable">Times unavailable — check ${esc(shul.name)}'s own schedule.</p>`);
    }
    if (s.state === 'awaiting') {
      lines += 1;
      perCardLines.push(lines);
      return card(shul.name, '<p class="unavailable">Done for today. Tomorrow\'s times not confirmed yet.</p>');
    }

    // Grouped by the day each time actually falls on, then capped — the cap
    // has to be spent with the days in view, or it is spent entirely on the
    // first of them.
    const grouped = new Map();
    for (const r of [...s.rows].sort((a, b) => a.at - b.at)) {
      const k = isoOf(r.at);
      if (!grouped.has(k)) grouped.set(k, []);
      grouped.get(k).push(r);
    }
    const ahead = capRows(grouped, cap);
    const next = ahead[0];

    const byDay = new Map();
    for (const r of ahead) {
      const k = isoOf(r.at);
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(r);
    }

    // Collected as blocks rather than one string, so they can be dealt into
    // columns below. Each carries the number of lines it will occupy, which is
    // what the balancing works on.
    const blocks = [];
    for (const [iso, rows] of byDay) {
      const when = dayName(now, rows[0].at);
      // Anything that is not today is always announced. Without this, a board
      // late at night shows tomorrow's 5:10 AM with nothing saying it is not
      // tonight — and on a long Yom Tov, three identical mornings in a row.
      if (when.cls !== 'today' || byDay.size > 1) {
        blocks.push({ head: true, lines: 1,
          html: `<p class="group ${when.cls}">${esc(when.label)}</p>` });
        lines += 1;
      }
      const day = when.cls;

      // Same tefillah on one line, but only while its times stay consecutive.
      // Grouping every row that shares a label merges times that are hours
      // apart and then places the row by the earliest of them: Beth Aaron
      // lists Night Selichos at both 5:00 AM and 9:45 PM, which put the last
      // minyan of the day above times sixteen hours earlier. Runs keep the
      // board in the order things actually happen. The label is always the
      // tefillah — never blanked, or Mincha and Maariv collapse into one
      // unlabelled row.
      const runs = [];
      for (const r of rows) {
        const label = r.label.toLowerCase() === r.group ? GROUPS[r.group] : r.label;
        const open = runs[runs.length - 1];
        if (open && open.label === label) open.times.push(r);
        else runs.push({ label, times: [r] });
      }

      // A run of times wraps, so count the lines it will actually occupy.
      // Narrower cards (more shuls across) fit fewer per line.
      const perLine = list.length <= 2 ? 4 : 3;
      for (const { label, times } of runs) {
        lines += Math.ceil(times.length / perLine);
        // The next minyan is decided per card, so neither shul becomes the more
        // important one just by being first.
        const here = times.includes(next) ? ' next-row' : '';
        // The marker lives in the LABEL cell, under the service name, not in
        // the times. In the times it sat between the label and the first time
        // and pushed that row's times a flag's width to the right — so the one
        // row anybody is looking for was the one row whose time did not line up
        // with the rest of the column.
        //
        // It carries the MOMENT, not the countdown: the board is memoised on
        // its own markup, so a changing string in here would rebuild every card
        // twice a minute, which is the thing E1 exists to prevent. The text is
        // written in place by paintCountdowns from the clock's own tick.
        const rowLines = Math.ceil(times.length / perLine);
        blocks.push({ head: false, lines: rowLines,
          html: `<span class="label ${day}${here}">${esc(label)}`
            + (here ? `<span class="nextflag" data-at="${next.at.getTime()}">Next</span>` : '')
            + `</span>`
            + `<span class="times ${day}${here}">`
            + times.map((r) => `<span class="time${r === next ? ' next' : ''}">${clockFace(r.time)}</span>`).join('')
            + `</span>` });
      }

      // The shul's own candle lighting and havdalah, under that day's times.
      for (const e of withEdges ? edgeRowsFor(shul.slug, rows[0].at) : []) {
        lines += 1;
        blocks.push({ head: false, lines: 1,
          html: `<span class="label ${day} edgerow">${esc(e.label)}</span>`
            + `<span class="times ${day} edgerow">`
            + `<span class="time edgetime">${clockFace(clockTimeLong(e.at))}</span></span>` });
      }
    }
    // Lines per column, not per card, once the content is split.
    perCardLines.push(Math.ceil(lines / columns));
    return card(shul.name, dealIntoColumns(blocks, columns)
      || '<p class="none">Nothing further listed.</p>');
  });

  // Scale on LINES, which is what actually consumes height, and on the fullest
  // card rather than the average of them.
  const perCard = Math.max(1, ...perCardLines);
  const scale = perCard <= 4 ? 1.15 : perCard <= 6 ? 1 : perCard <= 8 ? 0.9
    : perCard <= 10 ? 0.82 : perCard <= 13 ? 0.72 : 0.64;
  document.documentElement.style.setProperty('--minyan-scale', scale);

  // Cards hug their content, so the clock inherits the rest of the column. A
  // sparse evening gives it room; a full Friday board takes it back.
  const fill = perCard <= 3 ? 1.5 : perCard <= 5 ? 1.3 : perCard <= 7 ? 1.15
    : perCard <= 9 ? 1 : 0.85;
  document.documentElement.style.setProperty('--clock-fill', fill);

  paintBoard(cards.join(''));
  return fitBoard();
  };

  // Auto turns the question round. Instead of being told a count and then
  // shrinking the type until it fits — which is how a board ends up at 10px and
  // still clipped — it asks how many rows survive at a size worth reading, and
  // shows that many. A quiet Tuesday gets more than a crowded erev Yom Tov.
  //
  // A chosen 4/8/12 is still honoured, but only as a CEILING: if the board
  // cannot fit that many at any size it shows fewer rather than clipping them,
  // because a clipped time is worse than an absent one.
  const auto = settings.perShul === 'auto';
  const ceiling = auto ? AUTO_MAX : Number(settings.perShul);
  const floor = auto ? AUTO_MIN_PX : 0;
  // Each probe REBUILDS every card and then measures it, which is the most
  // expensive thing the board does and the reason the search is a binary one.
  // The probes were not remembered, so the re-probe below repeated one the
  // search had just done, and the final paint repeated whichever one it landed
  // on — two full rebuilds per render that had already been performed.
  const probed = new Map();
  let painted = null;
  const goodAt = (cap, withEdges = true) => {
    const memo = `${cap}|${withEdges}`;
    if (probed.has(memo)) return probed.get(memo);
    painted = memo;
    const r = build(cap, withEdges);
    // No geometry to measure (jsdom, or a board with no times on it) — take the
    // requested count at face value rather than searching against nothing.
    const good = r.px === null ? true : (r.fitted && r.px >= floor);
    probed.set(memo, good);
    return good;
  };

  // Only if the board is not already showing it.
  const paint = (cap, withEdges = true) => {
    if (painted !== `${cap}|${withEdges}`) build(cap, withEdges);
  };

  const search = (withEdges) => {
    let lo = AUTO_MIN_ROWS;
    let hi = ceiling;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (goodAt(mid, withEdges)) lo = mid; else hi = mid - 1;
    }
    return lo;
  };

  if (goodAt(ceiling)) { paintCountdowns(now); return; }
  const rowsShown = search(true);

  // Candle lighting and havdalah are rows like any other, and on a small enough
  // board they are rows the type cannot afford. Once the minyanim are already
  // down to the fewest Auto will show, they are the only lever left before
  // clipping — and a time nobody can read across the room is worth less than
  // one fewer line. They go last, and only here.
  if (auto && !goodAt(rowsShown, true)) {
    if (goodAt(ceiling, false)) { paintCountdowns(now); return; }
    paint(search(false), false);
    paintCountdowns(now);
    return;
  }

  // The search leaves the board at whatever it probed last, so paint the answer
  // — unless that is already what is on it.
  paint(rowsShown);
  paintCountdowns(now);
}

// Fit to the box, in both directions.
//
// The line count is only a first guess. This measures, and — the part that was
// missing — it GROWS as well as shrinks. Cards fill their cells, so any room
// left over is legibility left on the table: on a wall display read across a
// room, empty panel is worse than large numerals. Shrink-only sizing is why
// every card was a small table floating in a large blank rectangle.
//
// Binary search on the scale: find the largest value where the tallest card
// still fits its cell, both ways.
// Low enough that the board can always shrink to fit. Six zmanim in portrait
// makes the tile half the screen tall, and at a 0.45 floor the loop ran out of
// room and clipped rather than shrinking further.
const MIN_SCALE = 0.3;
// 2.6 let a card with two rows blow its times up to 86px against a 36px label
// — top-heavy, and wide enough to run to the card's clip edge. A card with
// little to say should read as a calm card, not a billboard. Down again from
// 1.8 now that the weather strip has taken a band off the cards: in a shorter
// cell the old ceiling put a two-row card's numerals hard against its own
// padding, which is the billboard the note above is about.
const MAX_SCALE = 1.7;

// Auto sizing. AUTO_MIN_PX is the point where numerals stop carrying across a
// room — the whole purpose of the board — so it is the thing held fixed and the
// row count is what gives way. AUTO_MAX is a sanity ceiling: past a dozen or so
// nobody is reading a wall, they are reading a timetable.
const AUTO_MIN_PX = 22;
const AUTO_MAX = 14;
const AUTO_MIN_ROWS = 2;

function fitBoard() {
  const cards = [...document.querySelectorAll('.card')];
  if (!cards.length) return { px: null, fitted: true };
  // No layout (jsdom, or a hidden board) reports 0 for everything, and a search
  // against zeros would settle on nonsense. Leave the heuristic value alone.
  if (!cards.some((c) => c.clientHeight > 0)) return { px: null, fitted: true };

  // Measure the body, not just the card. The card clips (overflow: hidden), so
  // the rows can spill out of the body while the card itself still reports no
  // overflow — the test would pass on content that is already being cut off.
  const boxes = cards.flatMap((c) => [c, c.querySelector('.body')]).filter(Boolean);
  // Scroll metrics are not enough. A time that is wider than its grid track
  // overflows and is clipped by the card, and the browser still reports
  // scrollWidth === clientWidth to the pixel — the same blindness that let
  // alignment overflow through before. So compare the rows' own rectangles
  // against the body they are supposed to sit in.
  const rows = cards.map((c) => [c.querySelector('.body'),
    [...c.querySelectorAll('.time, .label, .group')]]).filter(([b]) => b);
  const root = document.documentElement;
  resetCardScales();
  const fits = (v) => {
    root.style.setProperty('--minyan-scale', v);
    if (!boxes.every((b) => b.scrollHeight <= b.clientHeight + 1
      && b.scrollWidth <= b.clientWidth + 1)) return false;
    return rows.every(([body, els]) => {
      const bodyBox = body.getBoundingClientRect();
      return els.every((el) => {
        const r = el.getBoundingClientRect();
        if (r.bottom > bodyBox.bottom + 1) return false;
        // SIDEWAYS, AGAINST ITS OWN COLUMN — not against the whole card.
        //
        // Everything was measured against the body, and two columns sitting on
        // top of each other are both entirely inside the body, so this could
        // not see it. Ohr Saadya's "Mincha/Maariv" has no space to break at, so
        // it ran the width of its track and straight through the column beside
        // it: the 6:35pm chip printed over "Shacharis", and "Candles after"
        // over 6:31pm. The board reported that it fitted.
        const col = el.closest('.col');
        const box = col ? col.getBoundingClientRect() : bodyBox;
        return r.right <= box.right + 1 && r.left >= box.left - 1;
      });
    });
  };

  if (fits(MAX_SCALE)) { stretchCards(MAX_SCALE); return achieved(true); }
  // Cannot fit even at the floor. It used to return here and leave the board
  // clipped at 0.3; now it says so, and the caller shows fewer rows instead.
  if (!fits(MIN_SCALE)) return achieved(false);

  let lo = MIN_SCALE;
  let hi = MAX_SCALE;
  for (let i = 0; i < 9; i += 1) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid; else hi = mid;
  }
  fits(lo);
  stretchCards(lo);
  return achieved(true);
}

// How far a quiet card may outgrow a busy one beside it. Unbounded, a card with
// three rows next to one with eight ends up at twice the type and the two stop
// looking like the same board.
const CARD_STRETCH = 1.45;

// The board scale is set by the FULLEST card, because one size has to fit all
// of them. That leaves a shul with three minyanim showing them in the top two
// thirds of its box with the rest empty — which is most of what "so much empty
// space" is.
//
// So after the board settles, each card is allowed to grow into whatever room
// it has left, on its own. Bounded, because a card is still part of a board.
function stretchCards(base) {
  for (const card of document.querySelectorAll('.card')) {
    const body = card.querySelector('.body');
    if (!body) continue;
    const marks = [...card.querySelectorAll('.time, .label, .group')];
    if (!marks.length) continue;

    const fitsAt = (v) => {
      card.style.setProperty('--minyan-scale', v);
      if (body.scrollHeight > body.clientHeight + 1
        || body.scrollWidth > body.clientWidth + 1) return false;
      const bodyBox = body.getBoundingClientRect();
      return marks.every((el) => {
        const r = el.getBoundingClientRect();
        if (r.bottom > bodyBox.bottom + 1) return false;
        // Its own column sideways, for the reason given in fits() above: a card
        // allowed to grow into its spare room can grow one column through the
        // next, and against the body that reads as fitting.
        const col = el.closest('.col');
        const box = col ? col.getBoundingClientRect() : bodyBox;
        return r.right <= box.right + 1 && r.left >= box.left - 1;
      });
    };

    const ceiling = Math.min(MAX_SCALE, base * CARD_STRETCH);
    if (ceiling <= base || fitsAt(ceiling)) continue;   // already as big as allowed
    let lo = base;
    let hi = ceiling;
    for (let i = 0; i < 7; i += 1) {
      const mid = (lo + hi) / 2;
      if (fitsAt(mid)) lo = mid; else hi = mid;
    }
    fitsAt(lo);
  }
}

// The size the numerals actually came out at, which is the only thing that
// answers "can this be read from the sofa". null means there was nothing to
// measure — jsdom, or a board of unavailable cards.
function achieved(fitted) {
  // The SMALLEST numerals anywhere on the board, not the first card's.
  //
  // Cards carry their own scale now, so the first card is often the one that
  // was allowed to grow — and Auto decides how many rows to show from this
  // number. Reading the stretched card told it the board was comfortable while
  // the card beside it had been squeezed under the readable floor.
  const sizes = [...document.querySelectorAll('.card .body .time')]
    .map((el) => parseFloat(getComputedStyle(el).fontSize))
    .filter((n) => n > 0);
  if (!sizes.length) return { px: null, fitted };
  return { px: Math.min(...sizes), fitted };
}

// The numerals carry the information and the meridiem only disambiguates them,
// so they are separated and set at different weights rather than run together
// as one string. Anything that does not parse is left exactly as it arrived —
// these are real schedule times and are never reformatted into a guess.
function clockFace(text) {
  const m = /^(\d{1,2}):(\d{2})\s*([AP])M$/i.exec(String(text).trim());
  if (!m) return esc(text);
  return `<span class="hm">${m[1]}:${m[2]}</span>`
    + `<span class="ap">${m[3].toLowerCase()}m</span>`;
}

const card = (name, body) => `<article class="card"><h2>${esc(name)}</h2><div class="body">${body}</div></article>`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// The strip is the solar day and nothing else: dawn to nightfall, the zmanim
// that actually divide it, and the sun at now. It used to plot every upcoming
// minyan as an unlabelled tick, which put two shuls davening at the same time
// on top of each other, clipped the one labelled tick off the edge when it fell
// near dawn, and disagreed with the cards after tzeis. The cards carry minyan
// times in numerals that can be read across a room; this carries the day.
function renderHorizon(now, info) {
  const figure = document.querySelector('.horizon');
  figure.hidden = !settings.showHorizon;
  if (figure.hidden) return;

  // Past nightfall the day it describes is over, so it moves on to tomorrow's.
  const nightfall = now >= info.tzeis;
  const cal = nightfall ? zmanim(addDays(now, 1)) : info.cal;
  const start = toDate(cal.getAlos72());
  const end = toDate(cal.getTzais());
  const span = end - start;
  const at = (d) => Math.min(100, Math.max(0, ((d - start) / span) * 100));

  $('horizonElapsed').style.width = nightfall ? '0%' : `${at(now)}%`;

  // Its own node, moved in place so the transition runs rather than being
  // destroyed and rebuilt on every render.
  const sun = $('sun');
  sun.hidden = nightfall;
  if (!nightfall) sun.style.left = `${at(now)}%`;

  // Split across two rows by what each mark is. The sun's own two moments go
  // above the line, the halachic boundaries below it. That is not only tidy: it
  // is what keeps them apart. Netz sits ~8% in and shkiya ~95%, so on one row
  // each would crowd the end next to it — "Tomorrow · Alos" ran straight into
  // Netz, and shkiya into tzeis. Split, each row spans almost the whole bar.
  // The two ends anchor to their edges rather than centring on them, or half
  // the label hangs off the screen.
  const marks = [
    { name: nightfall ? 'Tomorrow · Alos' : 'Alos', at: start, cls: 'first' },
    { name: 'Netz', at: toDate(cal.getSunrise()), cls: 'up' },
    { name: 'Chatzos', at: toDate(cal.getChatzos()) },
    { name: 'Shkiya', at: toDate(cal.getSunset()), cls: 'up' },
    { name: 'Tzeis', at: end, cls: 'last' },
  ];
  const html = marks.map((m) => `<span class="zman ${m.cls ?? ''}" style="left:${at(m.at)}%">`
    + `<i></i><b>${esc(m.name)}</b><s>${clockFace(clockTimeLong(m.at))}</s></span>`).join('');
  if (html !== lastMarks) {
    lastMarks = html;
    $('horizonMarks').innerHTML = html;
  }
}

/* Freshness --------------------------------------------------------------
   Lives here rather than in weather.js, where the split first put it: it
   paints the footer and it is mostly about the MINYAN data, which weather.js
   has no business owning. It credits open-meteo too, which is how it ended
   up next to the forecast in the first place. */

// The oldest thing on screen, not the newest thing in the file.
//
// generated_at goes fresh if ANY shul was fetched successfully, while the
// scraper retains the previous entry for any that failed. So a shul quietly
// showing yesterday's schedule sat under a line claiming the data was confirmed
// minutes ago. Each entry now carries its own stamp, and the line describes the
// worst of the ones actually displayed.
function shownStamp(now, days) {
  const file = minyanim.generated_at ? new Date(minyanim.generated_at) : null;
  const stamps = [];
  // Every day the board reaches, not just today. Once the window widened to
  // cover a three-day Yom Tov this still asked about today alone, so a Shabbos
  // entry retained from an older run sat two columns away from a line calling
  // the board current.
  for (const day of days) {
    const iso = isoOf(day);
    for (const s of shownShuls()) {
      const entry = minyanim.days?.[iso]?.[s.slug];
      if (!entry) continue;
      // No per-shul stamp means data written before they existed; the
      // file-level one is the only thing left to fall back on.
      stamps.push(entry.fetched_at ? new Date(entry.fetched_at) : file);
    }
  }
  const known = stamps.filter(Boolean);
  if (!known.length) return file;
  return new Date(Math.min(...known.map((t) => t.getTime())));
}

function renderFreshness(now = new Date(), days = [now]) {
  const stamp = shownStamp(now, days);
  if (!stamp) { $('freshness').textContent = 'No minyan data yet'; return; }
  const hours = (Date.now() - stamp) / 3.6e6;
  // Credit where the times on screen actually came from: a shul that publishes
  // its own schedule is read from its own site, not from the aggregator.
  // Credit where the times on screen came from — across every day on the board,
  // not just today. A shul's own site reaches today and tomorrow; the days past
  // that come from the aggregator, so on a long Yom Tov the same shul is both.
  // Asking about today alone claimed the whole board came from the shul.
  const shown = shownShuls();
  const sources = new Set();
  for (const day of days) {
    for (const shul of shown) {
      const entry = minyanim.days?.[isoOf(day)]?.[shul.slug];
      if (entry) sources.add(entry.source === 'shul' ? 'shul' : 'aggregator');
    }
  }
  const source = !sources.has('shul') ? 'teaneckminyanim.com'
    : !sources.has('aggregator') ? 'each shul’s own website'
      : 'the shuls’ websites and teaneckminyanim.com';
  const times = hours > STALE_HOURS
    ? `Times last confirmed ${stamp.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
    : `Times from ${source}`;
  // Open-Meteo is free to use under CC-BY, which asks for exactly this line.
  if (!settings.showWeather || !weather) { $('freshness').textContent = times; return; }
  const age = weatherAge();
  // Same standard the minyan times are held to on the line beside it: say when
  // it was last confirmed rather than letting age pass for currency.
  const stale = age === null || age > WEATHER_STALE_MS
    ? ` (${age === null ? 'age unknown' : `${Math.floor(age / 3.6e6)}h old`})` : '';
  $('freshness').textContent = `${times} · weather from open-meteo.com${stale}`;
}

/* The clock face ---------------------------------------------------------
   Here rather than in weather.js, where the split first put it: the original
   file had the dial sitting at the tail of the weather section and the cut
   took it along. It paints; it belongs with the painting. */

// The hand's angle only ever increases. Feeding it seconds * 6 would send it
// backwards through a whole revolution at 59 -> 0, which the detent transition
// would then animate; accumulating the step keeps every move a forward one.
// Steps are taken mod 60 seconds, so the angle stays correct mod 360 even after
// the dial has been switched off for a while.
let handAngle = null;
let handAt = -1;

function paintDial(now) {
  // hidden is a property of HTMLElement, and the dial is an <svg>. Assigning
  // el.hidden there sets a plain expando: no attribute is reflected, the
  // stylesheet's [hidden] never matches, and the dial stays on the screen
  // whatever the setting says. toggleAttribute sets the real attribute.
  $('dial').toggleAttribute('hidden', !settings.seconds);
  const second = now.getSeconds();
  if (second === handAt) return;
  const hand = $('dialHand');
  const first = handAngle === null;
  handAngle = first ? second * 6 : handAngle + (((second - handAt + 60) % 60) * 6);
  handAt = second;
  // On the very first paint the hand would wind up from twelve to wherever it
  // belongs. Place it, then let the detent run from the next step on.
  hand.style.transition = first ? 'none' : '';
  hand.style.transform = `rotate(${handAngle}deg)`;
}

// Only inside the last ninety minutes. A minyan six hours out does not need a
// countdown, and "Next · 341m" is arithmetic rather than information.
const COUNTDOWN_FROM_MINS = 90;

// Written in place by the clock that is ticking anyway. Nothing here touches the
// board's markup, so nothing here can invalidate the memoisation that keeps the
// cards from being rebuilt twice a minute.
function paintCountdowns(now = new Date()) {
  for (const el of document.querySelectorAll('.nextflag[data-at]')) {
    const at = Number(el.dataset.at);
    if (!Number.isFinite(at)) continue;
    const mins = Math.round((at - now.getTime()) / 60000);
    const text = mins > COUNTDOWN_FROM_MINS || mins < 0 ? 'Next'
      : mins > 1 ? `Next · ${mins}m`
        : 'Next · soon';
    if (el.textContent !== text) el.textContent = text;

    // [11] Urgency as a STATE, written on the element, not as a size.
    //
    // Three steps: ordinary, close, and about to go. The treatment gets
    // stronger in colour and weight and never in metrics — nothing here
    // changes the line height, because the row is in a grid with its
    // neighbours and a taller "Next" row drags the whole column with it. And
    // nothing blinks: this display is opposite a table for three days of a
    // chag.
    const near = mins >= 0 && mins <= 5 ? 'now'
      : mins >= 0 && mins <= 15 ? 'soon' : '';
    if (el.dataset.urgency !== near) {
      el.dataset.urgency = near;
      const row = el.closest('.label');
      if (row) row.dataset.urgency = near;
    }
  }
}

function tick() {
  const now = new Date();
  const t = hhmm(now);
  $('clockTime').textContent = `${t.hour}:${t.minute}`;
  $('clockMer').textContent = t.meridiem;
  paintDial(now);
  paintCountdowns(now);
  sportsTick();
}
