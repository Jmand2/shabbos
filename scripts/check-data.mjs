// What must be true of data/minyanim.json, on its own.
//
// The scraper pushes three times a day and changes nothing else, so the full
// suites no longer run on those commits — WebKit on macOS plus every
// behavioural test is minutes of CI for a file the app only reads. This is the
// part that actually matters for a scrape, it needs no browser and no jsdom,
// and it runs where a bad one would come from: the refresh workflow itself.
//
//   node scripts/check-data.mjs
import { readFile } from 'node:fs/promises';
import { cleanLabel, cleanTime, normaliseSections } from './fetch-minyanim.mjs';

const OUT = new URL('../data/minyanim.json', import.meta.url);
const GROUPS = ['shacharis', 'mincha', 'maariv'];

let bad = 0;
const fail = (msg) => { bad += 1; console.log('  FAIL', msg); };

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
   is also what settings.js defaults to. */
const WALL = JSON.parse(await readFile(new URL('../data/shuls.json', import.meta.url), 'utf8'))
  .filter((s) => s.site).map((s) => s.slug);
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

for (const day of days.filter((d) => d >= today)) {
  for (const slug of WALL) {
    const entry = data.days[day][slug];
    if (!entry) continue;                       // no entry at all: not this check's business
    const later = (entry.mincha?.length ?? 0) + (entry.maariv?.length ?? 0);
    if (later) continue;
    const morning = entry.shacharis?.length ?? 0;
    fail(`${day} ${slug}: ${morning} shacharis and nothing after — no mincha, no maariv. `
      + 'Either the source dropped it or data/overrides.json needs extending.');
  }
}

console.log(`  ${days.length} day(s), ${rows} row(s), ${stamped} entry stamp(s)`);
console.log(`  ${days[0]} to ${days.at(-1)}`);
console.log(bad ? `\n${bad} problem(s)` : '\nthe scrape is clean');
process.exit(bad ? 1 : 0);
