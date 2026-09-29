/* Shabbos Clock — real minyan times, and only ever real ones.

   Nothing here derives a minyan time from sunset or from last week. A day that
   was not confirmed is reported as unavailable instead.

   Loaded as ordinary scripts, in the order index.html lists them, sharing one
   script scope. Not ES modules: jsdom cannot load <script type="module"> at
   all, and both behavioural suites work by loading the real index.html and
   running the real app inside it. Splitting the file was worth doing; giving up
   that harness to get import statements was not. */

const CACHE = 'shabbos-clock-minyanim';
const STALE_HOURS = 36;
let minyanim = readJSON(CACHE) ?? { days: {} };
let shuls = [];

/* Minyan data ----------------------------------------------------------- */

const timeToDate = (base, text) => {
  const m = /^(\d{1,2}):(\d{2})\s*([AP])M$/i.exec(text);
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (m[3].toUpperCase() === 'P') h += 12;
  return new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, Number(m[2]));
};

// The days the board reaches: today and tomorrow normally, and the whole of a
// rest period when we are in one or about to be. A three-day Yom Tov used to
// show its first two days and never its third — you could stand on day one and
// have no way to see Shabbos.
function daysShown(now, info) {
  const out = [now, addDays(now, 1)];
  const jc = info.civil.jc;
  const inIt = jc.isAssurBemelacha() && now < info.tzeis;
  // restEnd walks forward whenever it is asked, so on an ordinary Tuesday it
  // would happily return the coming Shabbos and stretch the board across the
  // week. Only ask when a rest period is actually current or imminent.
  if (!inIt && !jc.isTomorrowShabbosOrYomTov()) return out;
  const end = restEnd(now);
  if (!end) return out;
  for (let i = 2; i < 5; i += 1) {
    const day = addDays(now, i);
    if (day > end.day) break;
    out.push(day);
  }
  return out;
}

// AN EMPTY PARSE IS NOT A SCHEDULE WITH NOTHING IN IT.
//
// `known` used to mean "an entry object exists", and the scraper produces one
// whenever a page rendered the right date — including a page that listed no
// services at all, which the aggregator serves as a normal 200 saying "there
// are no Mincha minyanim scheduled". The board then read that as a schedule it
// had confirmed, and said "Done for today. Tomorrow's times not confirmed yet"
// about a shul whose times it had simply never obtained.
//
// The three states are genuinely different and the board says different things
// about them:
//   unavailable — nothing usable was ever obtained. Say so.
//   awaiting    — services ARE on file for these days; today's have all been
//                 and gone. That is a real "done for today".
//   ok          — there is something still to come.
function scheduleFor(slug, now, days) {
  const rows = [];
  let known = false;
  for (const day of days) {
    const entry = minyanim.days?.[isoOf(day)]?.[slug];
    if (!entry) continue;
    const some = flatten(entry, day);
    // An entry only counts as knowledge if it carries a service.
    if (some.length) known = true;
    rows.push(...some);
  }
  if (!known) return { state: 'unavailable' };

  const ahead = rows.filter((r) => r.at > now).sort((a, b) => a.at - b.at);
  if (!ahead.length) return { state: 'awaiting' };
  return { state: 'ok', rows: ahead };
}

// Chronological order alone lets today crowd out the rest of a long Yom Tov:
// a cap of eight spent on tonight and tomorrow morning leaves day three
// invisible, which is the whole thing this was meant to fix. So every day on
// the board is guaranteed a share first, and whatever is left of the cap is
// then spent in time order.
/* TWO QUESTIONS, TWO ALGORITHMS ---------------------------------------------

   These were made to share one function and it did neither job properly.

   Auto asks "what reads across a room, completely" — its cap is an internal
   search knob, not a promise to anybody, and splitting a service is the thing
   it must never do: four Shacharis with the last two cut off tells somebody
   there is no 8:45.

   4 / 8 / 12 asks "show me this many times". That is a number a person typed
   and it is exact. Trying to honour whole services there produced a "Next 4"
   that returned THREE — three Shacharis taken, a two-time Mincha skipped
   because it would have made five, and nothing said. Three shuls in the
   current data have exactly that shape. The setting must mean what it says. */

// Auto. The first `n` SERVICES, in an order fixed before anything is counted.
//
// Two properties have to hold at once and they pull against each other.
//
// MONOTONIC, or the fit search is unsound: the content at n+1 must contain the
// content at n. Counting times broke that — skipping a run that would not fit
// and taking a smaller later one instead meant cap 7 and cap 8 held different
// sets, which is the one shape a binary search cannot reason about.
//
// FINE-GRAINED, or the board gives up far more than it needs to. Counting
// services PER DAY was monotonic but moved in steps of one service on every
// day at once: on a three-day chag the difference between 1 and 2 was six
// services, so the board sat at one apiece and dropped four it had room for.
//
// Both are satisfied by fixing the ORDER first and then taking a prefix of it.
// The order interleaves the days — every day's first service, then every day's
// second — so a long morning cannot crowd out the day behind it, and the step
// is a single service.
// EVERY REPRESENTED DAY KEEPS ITS FIRST SERVICE, whatever the cap says.
//
// Because the order interleaves, its first `represented` entries ARE one
// service from every day — so the floor is a slice length and nothing more
// elaborate. Without it, a cap of two on a three-day Yom Tov returned
// Thursday's Shacharis and Friday's and no Shabbos at all: the third day
// vanished silently, at the fitting stage, long before the explicit "give up
// the furthest day" fallback that is supposed to be the only thing that can
// take a day off the board. Standing on Thursday you could not see Shabbos.
//
// The Auto cap is a fitting control, not a promise about a number of times.
// Nothing outside the search reads it, the search only needs the content to
// grow with it, and it still does: for every n at or below the floor the
// answer is the same mandatory set, and above it services are added one at a
// time in interleaved order. An explicit 4 / 8 / 12 is a different question
// and goes through capTimes, which is exact.
function capRuns(byDay, n) {
  const perDay = [...byDay.values()].map((rows) => runsOf(rows));
  const depth = Math.max(0, ...perDay.map((r) => r.length));
  const order = [];
  for (let i = 0; i < depth; i += 1) {
    for (const runs of perDay) if (runs[i]) order.push(runs[i]);
  }
  const represented = perDay.filter((runs) => runs.length).length;
  const take = Math.max(represented, Math.max(1, n));
  return order.slice(0, take)
    .flatMap((r) => r.times)
    .sort((a, b) => a.at - b.at);
}

// An explicit 4 / 8 / 12. Exactly that many times, split services and all.
function capTimes(byDay, cap) {
  if (byDay.size <= 1) return [...byDay.values()].flat().slice(0, cap);
  // An even division, never a fixed floor. A floor of three under "Next 4"
  // returned six times across two days and quietly broke the setting — the cap
  // is what the person asked for and it wins.
  const share = Math.max(1, Math.floor(cap / byDay.size));
  const kept = [];
  const spare = [];
  for (const rows of byDay.values()) {
    kept.push(...rows.slice(0, share));
    spare.push(...rows.slice(share));
  }
  // Late at night today has nothing left, so its share goes unspent — hand it
  // to the days that can use it rather than showing a half-empty card.
  const room = Math.max(0, cap - kept.length);
  spare.sort((a, b) => a.at - b.at);
  return [...kept, ...spare.slice(0, room)]
    .sort((a, b) => a.at - b.at)
    .slice(0, cap);
}

function flatten(sections, base) {
  return ['shacharis', 'mincha', 'maariv'].flatMap((group) =>
    (sections[group] ?? []).map((row) => ({ ...row, group, at: timeToDate(base, row.time) })))
    .filter((row) => row.at);
}

async function refreshMinyanim() {
  try {
    const res = await fetch(`data/minyanim.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    if (!data.days) return;
    minyanim = data;
    localStorage.setItem(CACHE, JSON.stringify(data));
    render();
  } catch { /* keep showing the last confirmed data */ }
}

