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

const sportsUp = () => sportsAt > 0 && Date.now() - sportsAt < SPORTS_SHOW_MS;

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

async function refreshSports() {
  if (settings.sports === 'off') return;
  const league = sportsNextLeague();
  try {
    const res = await fetch(
      `https://site.api.espn.com/apis/site/v2/sports/${league.id}/scoreboard`,
      { cache: 'no-store' },
    );
    if (!res.ok) return;
    const data = await res.json();
    // An unexpected shape is not a scoreboard, and overwriting a good cache
    // with it would lose the other leagues' games for nothing.
    if (!Array.isArray(data?.events)) return;
    sports.leagues[league.tag] = {
      at: Date.now(),
      games: data.events.flatMap((e) => sportsPick(e, league)),
    };
    localStorage.setItem(SPORTS_CACHE, JSON.stringify(sports));
  } catch { /* this is the least important thing here; it fails silently */ }
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
    .flatMap((l) => l.games ?? [])
    .filter((g) => {
      const when = Date.parse(g.at);
      if (Number.isNaN(when)) return false;
      return when > t - SPORTS_BACK_MS && when < t + SPORTS_AHEAD_MS;
    })
    .sort((a, b) => rank(a) - rank(b)
      // A result: the latest one is the one you have not seen. Anything else:
      // soonest first.
      || (a.state === 'post' ? Date.parse(b.at) - Date.parse(a.at)
        : Date.parse(a.at) - Date.parse(b.at)))
    .slice(0, SPORTS_MAX);
}

// Checked once per second by the clock's tick, but only actually evaluated when
// the interval is up — sorting every game every second for a strip that shows
// twice an hour would be silly.
function sportsTick() {
  const mins = Number(settings.sports);
  if (!mins) { sportsAt = 0; sportsNext = 0; return; }
  const now = Date.now();
  if (!sportsNext) { sportsNext = now + mins * 60000; return; }
  if (now < sportsNext) return;
  sportsNext = now + mins * 60000;
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
  if (lead.state !== 'post') return 'Later today';
  const when = new Date(Date.parse(lead.at));
  return when.toDateString() === now.toDateString() ? 'Final' : 'Last night';
}

let lastSports = '';

function renderSports(now = new Date()) {
  const el = $('weather');
  const games = sportsGames(now);
  el.hidden = !games.length;
  if (el.hidden) { lastSports = ''; el.innerHTML = ''; return; }


  const cols = games.map((g) => {
    // A scheduled game has no score yet, so it shows the time instead of 0-0.
    const pending = g.state === 'pre';
    const score = (t, s, lead) => `<div class="steam${lead ? ' lead' : ''}">`
      + `<span class="sabbr">${esc(t)}</span>`
      + `<span class="sscore">${pending ? '' : esc(String(s))}</span></div>`;
    const an = Number(g.as);
    const hn = Number(g.hs);
    const decided = !pending && !Number.isNaN(an) && !Number.isNaN(hn) && an !== hn;
    return `<div class="sgame${g.state === 'in' ? ' live' : ''}">`
      + `<div class="sleague">${esc(g.league)}${g.post ? ' · Playoff' : ''}</div>`
      + score(g.a, g.as, decided && an > hn)
      + score(g.h, g.hs, decided && hn > an)
      + `<div class="sstate">${esc(g.detail)}</div></div>`;
  }).join('');

  const html = `<div class="snow"><span class="slabel">Scores</span>`
    + `<span class="ssub">${sportsLabel(games, now)}</span></div>`
    + `<div class="sgames">${cols}</div>`;
  if (html !== lastSports) {
    lastSports = html;
    el.className = 'weather sports';
    el.innerHTML = html;
  }
}
