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
// A SERVICE IS ALL OF IT OR NONE OF IT.
//
// This capped individual TIMES, so the budget could run out half way through a
// service and the card showed Shacharis at 7:00 and 8:00 and stopped — with the
// 8:45 and the 9:15 cut off and nothing saying so. A partial list is worse than
// a short one: somebody reads four times, sees two, and walks out believing
// there is no 8:45.
//
// The unit is a RUN: one service and every consecutive time it is davened at.
// Whole runs are taken, never part of one. Every day keeps its first run
// whatever the budget, because a day heading with nothing under it says less
// than no heading at all — and if that overruns the cap, the fit loop shrinks
// the type, which is the honest lever.
// `whole` is Auto. The two modes are answering different questions and it is
// worth being explicit about which:
//
//   Auto      — "show what reads across a room, completely". Splitting a
//               service is the thing it must never do: four Shacharis with the
//               last two cut off tells somebody there is no 8:45.
//   4 / 8 / 12 — "show me this many times". That is an explicit count, chosen
//               by the person, and it wins. Bnai Yeshurun daven Shacharis nine
//               times in a row; under "never split" a cap of four would return
//               all nine, which is not a cap at all.
function capRows(byDay, cap, { whole = true } = {}) {
  const days = [...byDay.values()].map((rows) => runsOf(rows));

  const kept = [];
  let spent = 0;
  const take = (run) => { kept.push(run); spent += run.times.length; };

  // Each day's FIRST service before any day's second, so a long Yom Tov morning
  // does not crowd the days behind it off the card — the thing this function
  // was written for. Conditional, except for the very first: a card has to say
  // something, and one service over budget beats a heading with nothing under
  // it. Everything after that respects the cap.
  const rest = [];
  let opening = true;
  for (const runs of days) {
    if (!runs.length) continue;
    if (opening || spent + runs[0].times.length <= cap) {
      take(runs[0]);
      opening = false;
      rest.push(...runs.slice(1));
    } else {
      rest.push(...runs);
    }
  }

  // Then the rest in time order — whole runs only. A run that will not fit is
  // SKIPPED, not truncated, and a later shorter one may still get in.
  rest.sort((a, b) => a.times[0].at - b.times[0].at);
  for (const run of rest) {
    if (spent + run.times.length <= cap) take(run);
  }

  const out = kept.flatMap((r) => r.times).sort((a, b) => a.at - b.at);
  return whole ? out : out.slice(0, cap);
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

