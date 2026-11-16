// What must be true of data/minyanim.json, on its own.
//
// The scraper pushes three times a day and changes nothing else, so the full
// suites no longer run on those commits — WebKit on macOS plus every
// behavioural test is minutes of CI for a file the app only reads. This is the
// part that actually matters for a scrape, it needs no browser and no jsdom,
// and it runs where a bad one would come from: the refresh workflow itself.
//
//   node scripts/check-data.mjs
import { appendFile, readFile } from 'node:fs/promises';
import { cleanLabel, cleanTime, normaliseSections, coversRange } from './fetch-minyanim.mjs';

const OUT = new URL('../data/minyanim.json', import.meta.url);
const GROUPS = ['shacharis', 'mincha', 'maariv'];

let bad = 0;
const fail = (msg) => { bad += 1; console.log('  FAIL', msg); };

/* TWO KINDS OF PROBLEM, AND ONLY ONE OF THEM MAY STOP THE COMMIT ------------

   A MALFORMED file breaks the app, and the run must not commit it. That is
   fail(): it exits non-zero, and the workflow's commit step never runs.

   An INCOMPLETE file is a different thing entirely. It is well-formed and it
   is current; some source simply has not published something yet. Gating the
   commit on that was a two-week outage. From 2026-10-30 every run fetched the
   days correctly, found one shul whose furthest-out Mincha the aggregator had
   not rendered, failed, and skipped the commit — so the wall went on serving
   the file from 2026-10-30, which was staler and emptier than the one being
   thrown away each time. The check written to keep one wrong day off the wall
   is the reason a wrong month stayed on it.

   Freshness must never be gated on the source being complete. So
   incompleteness warns, the data lands, and the workflow fails the job
   AFTERWARDS, so a human still sees red without the board paying for it. */
const warnings = [];
const warn = (msg) => { warnings.push(msg); console.log('  WARN', msg); };

const data = JSON.parse(await readFile(OUT, 'utf8'));
const days = Object.keys(data.days ?? {}).sort();

if (!days.length) fail('no days on file at all');
if (!data.generated_at) fail('no generated_at');

let rows = 0;
let stamped = 0;
for (const day of days) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) fail(`"${day}" is not a date`);
  for (const [slug, entry] of Object.entries(data.days[day])) {
    if (entry.fetched_at) stamped += 1;
    for (const group of GROUPS) {
      const list = entry[group];
      if (list === undefined) continue;
      if (!Array.isArray(list)) { fail(`${day} ${slug} ${group} is not a list`); continue; }
      const seen = new Set();
      for (const row of list) {
        rows += 1;
        // Normalisation is meant to have already settled all of this. If any of
        // it is still true, the stage did not run or has been bypassed.
        if (cleanTime(row.time) !== row.time) fail(`${day} ${slug}: time "${row.time}"`);
        if (cleanLabel(row.label) !== row.label) fail(`${day} ${slug}: label "${row.label}"`);
        const key = `${String(row.label).toLowerCase()}|${row.time}|${row.note ?? ''}`;
        if (seen.has(key)) fail(`${day} ${slug}: duplicate ${row.label} ${row.time}`);
        seen.add(key);
      }
      // And in the order the day happens.
      const mins = list.map((r) => {
        const m = /^(\d{1,2}):(\d{2}) ([AP])M$/.exec(r.time ?? '');
        return m ? ((Number(m[1]) % 12) + (m[3] === 'P' ? 12 : 0)) * 60 + Number(m[2]) : -1;
      });
      if (mins.some((v, i) => i && v < mins[i - 1])) fail(`${day} ${slug} ${group} is out of order`);
    }
    // Running it again must change nothing: normalisation is idempotent, and a
    // difference here means the committed file is not what the stage produces.
    const again = normaliseSections(entry);
    for (const group of GROUPS) {
      if (JSON.stringify(again[group]) !== JSON.stringify(entry[group])) {
        fail(`${day} ${slug} ${group}: normalising again would change it`);
      }
    }
  }
}

/* A shul on the wall with a morning and no afternoon -----------------------

   Beth Aaron sat on the wall through Succos showing four Shacharis and nothing
   else, which does not read as "we could not find their Mincha" — it reads as
   "Beth Aaron has no Mincha on Succos", which is false. A wrong statement on a
   wall is worse than a blank one, and this one was silent: every other check
   passed, because the data was well-formed. It was simply incomplete.

   So: a shul the display actually shows, on a day it has an entry for, must
   have somewhere to daven after the morning. A missing DAY is left alone —
   that is the scraper's own "unavailable" path and the board says so honestly.
   This is only about a day that is present and quietly half-empty.

   The wall's shuls are the ones with a site of their own in shuls.json, which
   is also what settings.js defaults to.

   TODAY, AND ONLY TODAY.
   ---------------------
   This ran over every day on file, and the scrape reaches three days out. An
   afternoon missing from a future day is not a dropped service. Some shuls set
   Mincha and Maariv by the zman and publish them on the day itself, and Ohr
   Saadya is one: on any future date, its own widget and teaneckminyanim both
   carry the two Shacharis and no afternoon at all, every weekday, by design.
   It appears the morning of, and the scrape picks it up the same day.

   (Both sources agree, and always did. The line "Next Minyan Today:
   Mincha/Maariv at 4:25 PM", read off a /next page for a future date and once
   cited here as the aggregator contradicting its own empty section, is the
   site's TODAY widget and belongs to the real today, whatever date the page
   below it renders. It disappears once today's last minyan has gone. There was
   never a contradiction to explain.)

   So asking about tomorrow means asking a question whose answer is "not yet"
   almost every weekday, and a check that cries every day is one nobody reads
   the day it means something. scheduleFor() in minyanim.js pools the days it
   shows in any case, so a future day short of its afternoon never reaches the
   wall as a claim about anything.

   Today is different. Today's times are published by now, and the board is
   making a live statement about them — which is exactly what the Succos bug
   was: Beth Aaron ON the wall, four Shacharis, nothing after. A gap here means
   the day-of publication actually failed, and that is worth waking somebody
   for. Tomorrow is left to fill itself in, because it will. */
const WALL_ALL = JSON.parse(await readFile(new URL('../data/shuls.json', import.meta.url), 'utf8'));
const WALL = WALL_ALL.filter((s) => s.site).map((s) => s.slug);
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

for (const day of days.filter((d) => d === today)) {
  for (const slug of WALL) {
    const entry = data.days[day][slug];
    if (!entry) continue;                       // no entry at all: not this check's business
    const later = (entry.mincha?.length ?? 0) + (entry.maariv?.length ?? 0);
    if (later) continue;
    const morning = entry.shacharis?.length ?? 0;
    warn(`${day} ${slug}: ${morning} shacharis and nothing after — no mincha, no maariv, `
      + 'and this is TODAY. The source should have published it by now: check '
      + 'whether the shul has changed its schedule, or extend data/overrides.json.');
  }
}

/* [19] The override file is validated, not merely read -----------------------

   `covers` is enforced by the merge, but everything else about an entry was
   taken on trust: a typo in a slug, a service that does not exist, a time in a
   shape cleanTime would reject, a range whose end precedes its start. All of
   those fail SILENTLY — the entry simply does nothing, which is the worst
   possible outcome for a file whose entire job is to be the last source of
   times nobody else publishes. A hand-entered Yom Tov schedule that quietly
   does not apply is indistinguishable from not having written it. */
const OVERRIDES = JSON.parse(
  await readFile(new URL('../data/overrides.json', import.meta.url), 'utf8'));
const SLUGS = new Set(WALL_ALL.map((s) => s.slug));
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const realDate = (d) => ISO.test(d) && !Number.isNaN(Date.parse(`${d}T12:00:00Z`))
  && new Date(`${d}T12:00:00Z`).toISOString().slice(0, 10) === d;

for (const [i, entry] of (OVERRIDES.entries ?? []).entries()) {
  const at = `overrides[${i}]${entry.shul ? ` ${entry.shul}` : ''}`;
  if (!entry.shul) fail(`${at}: no shul named`);
  else if (!SLUGS.has(entry.shul)) fail(`${at}: not a shul in shuls.json`);
  if (!entry.source) fail(`${at}: no source recorded — provenance is the point of this file`);

  const range = coversRange(entry);
  if (!range) {
    fail(`${at}: "covers" is missing or malformed (want YYYY-MM-DD/YYYY-MM-DD, got ${JSON.stringify(entry.covers)})`);
  } else {
    if (!realDate(range.from) || !realDate(range.to)) fail(`${at}: covers names a date that does not exist (${entry.covers})`);
    else if (range.from > range.to) fail(`${at}: covers ends before it starts (${entry.covers})`);
  }

  for (const [date, sections] of Object.entries(entry.days ?? {})) {
    if (!realDate(date)) { fail(`${at}: "${date}" is not a date`); continue; }
    if (range && (date < range.from || date > range.to)) {
      fail(`${at}: ${date} is outside covers ${entry.covers} — it would never be applied`);
    }
    for (const [group, list] of Object.entries(sections)) {
      if (group === 'edge') {
        for (const [k, v] of Object.entries(list ?? {})) {
          if (!['candles', 'havdalah'].includes(k)) fail(`${at} ${date}: "${k}" is not an edge time`);
          else if (cleanTime(v) !== v) fail(`${at} ${date}: edge ${k} "${v}" is not a clean time`);
        }
        continue;
      }
      if (!GROUPS.includes(group)) { fail(`${at} ${date}: "${group}" is not a service`); continue; }
      if (!Array.isArray(list)) { fail(`${at} ${date} ${group}: not a list`); continue; }
      for (const row of list) {
        if (cleanTime(row?.time) !== row?.time) fail(`${at} ${date} ${group}: time "${row?.time}"`);
        if (cleanLabel(row?.label) !== row?.label) fail(`${at} ${date} ${group}: label "${row?.label}"`);
      }
    }
  }
}

console.log(`  ${days.length} day(s), ${rows} row(s), ${stamped} entry stamp(s)`);
console.log(`  ${days[0]} to ${days.at(-1)}`);

// Handed to the workflow, which commits the data and THEN fails the job on it.
// Annotated as well, so the warning is readable from the run summary without
// opening the log of a step that passed.
if (warnings.length) {
  for (const msg of warnings) console.log(`::warning title=Incomplete minyan data::${msg}`);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, 'incomplete=1\n');
}

if (bad) console.log(`\n${bad} problem(s)`);
else if (warnings.length) {
  console.log(`\nwell-formed and current, but ${warnings.length} incomplete day(s)`);
  console.log('committing anyway: stale data on the wall is worse than a short one');
} else console.log('\nthe scrape is clean');
process.exit(bad ? 1 : 0);
