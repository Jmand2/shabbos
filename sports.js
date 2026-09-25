/* Shabbos Clock — scores, occasionally.

   Loaded as an ordinary script alongside the others, sharing one script scope.

   This is the least important thing on the board and is built to behave like
   it: it owns no space of its own, it borrows the weather band for half a
   minute at a set interval so there is a moment to look for, and it says
   nothing at all when there is nothing to say. If the feed disappears
   tomorrow the display loses a half-minute of borrowed band and nothing
   else. */

const SPORTS_CACHE = 'shabbos-clock-sports';
// One league per pass, in rotation. Each scoreboard is about 280KB and there
// are four of them; fetching all four every time is a megabyte an hour of wifi
// for something nobody is waiting on.
//
// Ten minutes is plenty. What this is for is looking at last night's result on
// the way out of the door, and last night's result does not change. The
// interval in Settings is about how long you wait for the band to come ROUND,
// not about how fresh the numbers are — two minutes is there so somebody with
// their coat on can wait for it, not so anybody can follow a game from the
// kitchen.
const SPORTS_REFRESH_MS = 600000;
// Long enough to read four or five games from across a room, short enough that
// nobody waiting on a minyan time is kept waiting.
const SPORTS_SHOW_MS = 30000;
const SPORTS_MAX = 5;
// A final from last night is still worth seeing over breakfast; a game four
// days out is not.
const SPORTS_BACK_MS = 20 * 3600 * 1000;
const SPORTS_AHEAD_MS = 14 * 3600 * 1000;
// A live score is only as true as the snapshot it came from. One league is
// refreshed about every forty minutes, which is fine for a result and useless
// for a game in play — past this, "2nd 8:24" is a guess wearing a fact's
// clothes.
const SPORTS_LIVE_TRUST_MS = 15 * 60000;

// Abbreviations are scoped per league deliberately. "Rangers" is NYR in hockey
// and TEX in baseball, "Giants" is NYG in football and SF in baseball, and
// "Jets" is NYJ and WPG — a flat list of names or abbreviations would quietly
// follow the wrong teams.
const LEAGUES = [
  { id: 'baseball/mlb', tag: 'MLB', teams: ['NYY', 'NYM'] },
  { id: 'football/nfl', tag: 'NFL', teams: ['NYG', 'NYJ'] },
  { id: 'hockey/nhl', tag: 'NHL', teams: ['NYR', 'NJ', 'NYI'] },
  { id: 'basketball/nba', tag: 'NBA', teams: ['NY', 'BKN'] },
];

let sports = readJSON(SPORTS_CACHE) ?? { leagues: {} };
let sportsLeague = 0;
// When the strip last took the band, and when it may next.
let sportsAt = 0;
let sportsNext = 0;

// Checks the setting too, not just the timer. Switching to Off while the band
// is up otherwise left it there until the next tick noticed.
const sportsUp = () => settings.sports !== 'off'
  && sportsAt > 0 && Date.now() - sportsAt < SPORTS_SHOW_MS;

// A game is worth keeping if one of the local teams is in it, or if it is a
// postseason game at all — October baseball is worth a glance whoever is
// playing. season.type 3 is the postseason.
function sportsPick(event, league) {
  const comp = event?.competitions?.[0];
  const sides = comp?.competitors ?? [];
  const away = sides.find((s) => s.homeAway === 'away');
  const home = sides.find((s) => s.homeAway === 'home');
  if (!away || !home) return [];

  const abbr = (s) => s.team?.abbreviation ?? '';
  const post = Number(event.season?.type) === 3;
  const local = league.teams.includes(abbr(away)) || league.teams.includes(abbr(home));
  if (!local && !post) return [];

  const status = event.status?.type ?? {};
  return [{
    league: league.tag,
    post,
    local,
    a: abbr(away),
    as: away.score ?? '',
    h: abbr(home),
    hs: home.score ?? '',
    // in / post / pre, which is what decides the ordering below.
    state: status.state ?? 'pre',
    detail: status.shortDetail ?? '',
    at: event.date ?? '',
  }];
}

// Plain rotation. An earlier version chased whichever league had a game in
// progress and tightened to two minutes to keep up with it — which was solving
// for standing at the screen following a game, and that is the opposite of what
// this is for.
function sportsNextLeague() {
  const league = LEAGUES[sportsLeague % LEAGUES.length];
  sportsLeague += 1;
  return league;
}

// Every league at once, once. The rotation is a bandwidth measure for a display
// that has been running for days; on a first install, after a cache clear, or
// the moment Scores is switched on, it means the picture is a quarter complete
// for ten minutes and three quarters complete for thirty. Four responses one
// time is nothing against making the first thing somebody sees true.
// How old a league's board may be before a catch-up bothers with it.
const SPORTS_STALE_MS = 12 * 60000;

// Everything at once on a cold start or when Scores is switched on, because
// there is nothing on file and the rotation would take forty minutes to fill.
//
// `staleOnly` is for coming back: reconnecting, or the screen waking. Those fire
// on every brief app switch, and warming unconditionally meant eight ESPN
// requests each time — for four boards that were very often fetched a minute
// ago. It asks only for what has actually gone off.
async function warmSports({ staleOnly = false } = {}) {
  if (settings.sports === 'off') return 0;
  const now = Date.now();
  const want = LEAGUES.filter((l) => !staleOnly
    || now - (sports.leagues?.[l.tag]?.at ?? 0) > SPORTS_STALE_MS);
  if (!want.length) return 0;
  await Promise.allSettled(want.map((l) => fetchLeague(l)));
  return want.length;
}

async function refreshSports() {
  if (settings.sports === 'off') return;
  await fetchLeague(sportsNextLeague());
}

// YESTERDAY IS THE WHOLE POINT, AND IT WAS NEVER BEING FETCHED.
//
// The plain scoreboard endpoint answers for TODAY. At eight in the morning
// that is a list of games which have not been played yet — so the band said
// "Later today" over four fixtures, and last night's result, which is the one
// thing this is for, was not in the payload at all. SPORTS_BACK_MS says a
// finished game stays interesting for twenty hours, and it had nothing to keep:
// the data was already gone before the filter saw it.
//
// So: yesterday as well, and merge. ESPN takes ?dates=YYYYMMDD for one day but
// answers a date RANGE with something that is not JSON, so it has to be two
// requests. The plain call is kept as the second of them rather than asking for
// today by name, because NFL answers it with the whole current week — Sunday's
// fixtures included — and asking for a single Thursday would throw that away.
const espnDay = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`
  + `${String(d.getDate()).padStart(2, '0')}`;

// What makes two entries the same fixture.
const espnKey = (e) => {
  if (e?.id != null) return `id:${e.id}`;
  const sides = e?.competitions?.[0]?.competitors ?? [];
  return `${e?.date ?? ''}|${sides.map((c) => c?.team?.abbreviation ?? '').join('/')}`;
};

async function fetchLeague(league) {
  try {
    const base = `https://site.api.espn.com/apis/site/v2/sports/${league.id}/scoreboard`;
    const yesterday = new Date(Date.now() - 86400000);
    const urls = [`${base}?dates=${espnDay(yesterday)}`, base];

    const events = [];
    const seen = new Set();
    let answered = false;
    for (const url of urls) {
      const res = await fetch(url, { cache: 'no-store' }).catch(() => null);
      if (!res?.ok) continue;
      const data = await res.json().catch(() => null);
      // An unexpected shape is not a scoreboard, and overwriting a good cache
      // with it would lose the other leagues' games for nothing.
      if (!Array.isArray(data?.events)) continue;
      answered = true;
      for (const e of data.events) {
        // A game can appear in both answers — a late start is yesterday's date
        // in one and today's slate in the other. Keyed on the id where there is
        // one, and on the fixture itself where there is not: keying on the id
        // ALONE quietly let every game through twice the moment a feed omitted
        // it, and the band showed the same final side by side with itself.
        const key = espnKey(e);
        if (seen.has(key)) continue;
        seen.add(key);
        events.push(e);
      }
    }
    // Only a total failure keeps the old cache. A day that genuinely had no
    // games is an empty list, not a reason to go on showing yesterday's.
    if (!answered) return;

    sports.leagues[league.tag] = {
      at: Date.now(),
      games: events.flatMap((e) => sportsPick(e, league)),
    };
    localStorage.setItem(SPORTS_CACHE, JSON.stringify(sports));
  } catch { /* this is the least important thing here; it fails silently */ }
}

// What a cached game is still entitled to claim.
//
// The scoreboard is fetched one league at a time and each is refreshed only
// every forty minutes or so. That is exactly right for a final — it does not
// change, so an old snapshot of it is still true — and wrong for everything
// else. A game cached as `in` goes on saying "2nd 8:24" long after the period
// ended; a game cached as `pre` goes on advertising a start time that has been
// and gone, and because eligibility was decided from the SCHEDULED time rather
// than the age of the snapshot, it stayed on screen through the whole game it
// claimed had not started.
//
// So: a final may be old. A live score has to be recent. An unstarted game has
// to be either genuinely unstarted, or confirmed unstarted since its own start
// time — which is what a real delay looks like.
function sportsTrustworthy(game, snapshotAt, t) {
  if (game.state === 'post') return true;
  if (game.state === 'in') return t - snapshotAt <= SPORTS_LIVE_TRUST_MS;
  const start = Date.parse(game.at);
  if (Number.isNaN(start)) return false;
  // Before its own start time, a scheduled game needs no corroboration: it has
  // not happened yet and the schedule is the fact.
  if (t < start) return true;
  // After it, "not started" is a claim about right now, and one snapshot is not
  // a standing licence to keep making it. A genuine delay confirmed at 7:05 is
  // worth showing for a while; the same snapshot still insisting at midnight
  // that the game has not begun is the feed having gone away, not a delay.
  return snapshotAt > start && t - snapshotAt <= SPORTS_LIVE_TRUST_MS;
}

// FINISHED GAMES FIRST, most recent first.
//
// This is the whole point and the first version had it upside down. What
// somebody wants from this is last night's result, at eight in the morning,
// on the way out — not a game in progress, which at that hour there almost
// never is, and which if there were would mean standing and watching. A game
// still to come is context and goes last. Within each, a local team ahead of a
// playoff between two others.
function sportsGames(now = new Date()) {
  const t = now.getTime();
  const rank = (g) => (g.state === 'post' ? 0 : g.state === 'in' ? 2 : 4) + (g.local ? 0 : 1);
  return Object.values(sports.leagues ?? {})
    // Carry each league's fetch time onto its games. It was stored and then
    // dropped here, which is how a stale state could pass as a current one.
    .flatMap((l) => (l.games ?? []).map((g) => ({ ...g, snap: l.at ?? 0 })))
    .filter((g) => {
      const when = Date.parse(g.at);
      if (Number.isNaN(when)) return false;
      if (when <= t - SPORTS_BACK_MS || when >= t + SPORTS_AHEAD_MS) return false;
      return sportsTrustworthy(g, g.snap, t);
    })
    .sort((a, b) => rank(a) - rank(b)
      // A result: the latest one is the one you have not seen. Anything else:
      // soonest first.
      || (a.state === 'post' ? Date.parse(b.at) - Date.parse(a.at)
        : Date.parse(a.at) - Date.parse(b.at)))
    .slice(0, SPORTS_MAX);
}

// On the wall clock, not on however long ago this happened to start.
//
// "Every five minutes" now means :00, :05, :10 — so somebody can glance at the
// numerals above and know the scores are ninety seconds away, rather than
// having to catch them by luck. That is the whole reason for choosing a short
// interval: to wait for it deliberately, on the way out.
//
// Every interval offered divides an hour, so the boundaries are the same every
// hour. They are computed from the epoch, which lands on the same minutes in
// any timezone offset by a whole number of hours.
//
// This is deliberately NOT true of the family photos. Those should stay
// unpredictable — it is the information that wants a timetable, not the
// whimsy.
function sportsBoundary(mins, now) {
  const step = mins * 60000;
  return Math.ceil((now + 1) / step) * step;
}

// Called when the setting changes, so a new cadence starts at the next boundary
// of the NEW interval. Without this, going from twenty minutes to two waited out
// the old twenty-minute boundary first — which is precisely the moment somebody
// has changed it because they want the scores sooner.
function sportsReset() {
  sportsAt = 0;
  sportsNext = 0;
}

// Checked once per second by the clock's tick, but only actually evaluated when
// the interval is up — sorting every game every second for a strip that shows
// twice an hour would be silly.
function sportsTick() {
  const mins = Number(settings.sports);
  if (!mins) { sportsAt = 0; sportsNext = 0; return; }
  const now = Date.now();
  if (!sportsNext) { sportsNext = sportsBoundary(mins, now); return; }
  if (now < sportsNext) return;
  sportsNext = sportsBoundary(mins, now);
  if (!sportsGames().length) return;      // nothing to say, so nothing is said
  sportsAt = now;
  render();
  // And put the weather back.
  setTimeout(() => { sportsAt = 0; render(); }, SPORTS_SHOW_MS);
}

// Describes what is LEADING, not whatever happens to be on somewhere. The first
// column is what a glance lands on, so if that is last night's result the band
// should say so — it said "Live now" whenever any game anywhere was in play,
// while showing a final from twelve hours earlier in the first column.
function sportsLabel(games, now) {
  const lead = games[0];
  if (!lead) return 'NY &amp; NJ';
  if (lead.state === 'in') return 'Live now';
  if (lead.state !== 'post') {
    // The window reaches fourteen hours ahead, which crosses midnight in the
    // evening — a game at one tomorrow afternoon is not "later today".
    const start = new Date(Date.parse(lead.at));
    return start.toDateString() === now.toDateString() ? 'Later today' : 'Tomorrow';
  }
  const when = new Date(Date.parse(lead.at));
  return when.toDateString() === now.toDateString() ? 'Final' : 'Last night';
}

// One line for the status panel: how old each league's scoreboard is.
function sportsAges() {
  const now = Date.now();
  const parts = LEAGUES
    .filter((l) => sports.leagues?.[l.tag]?.at)
    .map((l) => `${l.tag} ${Math.round((now - sports.leagues[l.tag].at) / 60000)}m`);
  return parts.length ? parts.join(' · ') : 'none fetched yet';
}

let lastSports = '';


/* Sport marks -------------------------------------------------------------

   A shape reads from across the room before three capitals do, and the whole
   point of this strip is that you can take it in on the way out of the door.
   The league tag stays next to it: a baseball and a basketball are both a
   circle with lines on it at this size, and the letters are what tell them
   apart when the icon is only a hint.

   Drawn rather than fetched. An emoji is a different glyph on every device and
   a sprite sheet is another file to keep in step with the app shell, whereas
   these cost nothing and inherit their colour from the text beside them.

   A postseason game wears a crown. October baseball is worth a glance whoever
   is playing, and a crown says that in less width than "· Playoff" did. */
const SPORT_ART = {
  MLB: '<circle cx="12" cy="12" r="8.6"/>'
    + '<path d="M6 6.1c2.5 2.5 2.5 9.3 0 11.8M18 6.1c-2.5 2.5-2.5 9.3 0 11.8"/>',
  NBA: '<circle cx="12" cy="12" r="8.6"/>'
    + '<path d="M12 3.4v17.2M3.4 12h17.2M6.1 6c2.6 2.6 2.6 8.8 0 11.4M17.9 6c-2.6 2.6-2.6 8.8 0 11.4"/>',
  // Laces only, no seam line down the middle: at thirty pixels a horizontal
  // rule with four ticks crossing it closed up into a solid blob.
  NFL: '<ellipse cx="12" cy="12" rx="8.8" ry="5.6"/>'
    + '<path d="M9.4 10.5v3M12 10.1v3.8M14.6 10.5v3"/>',
  NHL: '<ellipse cx="12" cy="9.2" rx="7.8" ry="2.9"/>'
    + '<path d="M4.2 9.2v5c0 1.6 3.5 2.9 7.8 2.9s7.8-1.3 7.8-2.9v-5"/>',
};
// Path data only: three peaks and a band, sitting above the ball's box.
const SPORT_CROWN = 'M4.3 -1.4 5.5 -8.8 9.2 -5.2 12 -10 14.8 -5.2 18.5 -8.8 19.7 -1.4Z';

// A short pill rather than a sentence. "Final/OT" and "3rd 04:12" are the two
// shapes ESPN gives, and the useful half of either is the first word.
function statePill(g) {
  const detail = String(g.detail ?? '');
  if (g.state === 'in') {
    // A dot and the word. No blinking: a wall display that flashes is a wall
    // display nobody can sit opposite.
    return '<span class="spill live"><i class="sdot"></i>LIVE</span>'
      + (detail ? `<span class="swhen">${esc(detail)}</span>` : '');
  }
  if (g.state === 'pre') return `<span class="swhen">${esc(detail)}</span>`;
  // Final, and whatever qualified it — OT, SO, or the innings it ran to.
  const extra = /\/(.+)$/.exec(detail)?.[1] ?? '';
  return `<span class="spill">FINAL</span>`
    + (extra ? `<span class="spill soft">${esc(extra.toUpperCase())}</span>` : '');
}

// Team colours, for a thread of accent beside the abbreviation. Only the local
// clubs and their common opponents are named; anything else falls back to the
// muted rule colour, which is what most rows already looked like.
const TEAM_COLOURS = {
  NYY: '#1c2841', NYM: '#ff5910', BOS: '#bd3039', TB: '#8fbce6', BAL: '#df4601',
  NYG: '#0b2265', NYJ: '#115740', PHI: '#004c54', DAL: '#041e42', BUF: '#00338d',
  NYR: '#0038a8', NYI: '#f47d30', NJ: '#ce1126', BKN: '#767676', NY: '#f58426',
  WSH: '#c8102e', PIT: '#ffb81c', CHC: '#0e3386', LAD: '#005a9c', SD: '#2f241d',
  ATL: '#ce1141', HOU: '#002d62', TOR: '#ce1141', MIA: '#98002e',
};
const teamColour = (abbr) => TEAM_COLOURS[String(abbr).toUpperCase()] ?? 'var(--rule)';

function sportsIcon(tag, post) {
  const art = SPORT_ART[tag];
  if (!art) return '';
  // The crown sits ABOVE the ball rather than shrinking it, so a postseason
  // game and an ordinary one show the same size ball and only differ by what
  // is on top of it.
  return `<svg class="sicon" viewBox="${post ? '0 -11 24 35' : '0 0 24 24'}" aria-hidden="true">`
    + (post ? `<path class="scrown" d="${SPORT_CROWN}"/>` : '')
    + `<g class="sball">${art}</g></svg>`;
}

function renderSports(now = new Date()) {
  const el = $('weather');
  const games = sportsGames(now);
  el.hidden = !games.length;
  if (el.hidden) { lastSports = ''; el.innerHTML = ''; return; }


  const cols = games.map((g) => {
    // A scheduled game has no score yet, so it shows the time instead of 0-0.
    const pending = g.state === 'pre';
    // A thread of the team's own colour, not a card painted in it. Enough to
    // tell two rows apart at a glance and to say "that is the Yankees line"
    // without the strip becoming a rosette.
    const score = (t, s, lead) => `<div class="steam${lead ? ' lead' : ''}">`
      + `<span class="sabbr"><i class="sbar" style="--team:${teamColour(t)}"></i>`
      + `${esc(t)}</span>`
      + `<span class="sscore">${pending ? '' : esc(String(s))}</span></div>`;
    const an = Number(g.as);
    const hn = Number(g.hs);
    const decided = !pending && !Number.isNaN(an) && !Number.isNaN(hn) && an !== hn;
    return `<div class="sgame${g.state === 'in' ? ' live' : ''}${g.post ? ' post' : ''}">`
      + `<div class="sleague">${esc(g.league)}</div>`
      + sportsIcon(g.league, g.post)
      + score(g.a, g.as, decided && an > hn)
      + score(g.h, g.hs, decided && hn > an)
      + `<div class="sstate">${statePill(g)}</div></div>`;
  }).join('');

  // A narrower header. "SCORES" over "LAST NIGHT" in two stacked lines took a
  // column's worth of width to say something the games themselves already make
  // obvious; the width is better spent on them.
  const html = `<div class="snow"><span class="slabel">Scores</span>`
    + `<span class="ssub">${sportsLabel(games, now)}</span></div>`
    + `<div class="sgames">${cols}</div>`;
  if (html !== lastSports) {
    lastSports = html;
    // The band is shared, and the strip leaves its fit behind on the element.
    // A scale chosen for twelve hours of weather has nothing to do with five
    // scores, and it would be inherited by them.
    el.style.removeProperty('--wx-scale');
    el.className = 'weather sports';
    el.innerHTML = html;
  }
}
