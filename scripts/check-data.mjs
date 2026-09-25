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

console.log(`  ${days.length} day(s), ${rows} row(s), ${stamped} entry stamp(s)`);
console.log(`  ${days[0]} to ${days.at(-1)}`);
console.log(bad ? `\n${bad} problem(s)` : '\nthe scrape is clean');
process.exit(bad ? 1 : 0);
