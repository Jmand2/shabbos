// Renders the wall display under a range of conditions and prints what would be
// on screen. Needs jsdom:
//   npm i --no-save jsdom
//   TZ=America/New_York node scripts/check.mjs

import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import {
  toText, renderedDate, parseSections, cleanLabel, cleanTime, normaliseSections,
} from './fetch-minyanim.mjs';

const file = (name) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

async function boot(fakeNow, { failFetch = [], settings = null, wakeLock = true } = {}) {
  const dom = new JSDOM(file('index.html'),
    { runScripts: 'outside-only', url: 'https://x.test/', pretendToBeVisual: true });
  const w = dom.window;
  const Real = w.Date;
  class Frozen extends Real {
    constructor(...a) { super(...(a.length ? a : [fakeNow])); }
    static now() { return new Real(fakeNow).getTime(); }
  }
  w.Date = Frozen;
  if (settings) w.localStorage.setItem('shabbos-clock-settings', JSON.stringify(settings));
  w.fetch = async (u) => {
    const path = String(u).replace(/^.*?(data\/[^?]+).*$/, '$1');
    if (failFetch.some((f) => path.includes(f))) throw new Error('offline');
    return { ok: true, json: async () => JSON.parse(file(path)) };
  };
  w.navigator.wakeLock = {
    request: async () => { if (!wakeLock) throw new Error('unsupported'); return {}; },
  };
  w.eval(file('vendor/kosher-zmanim.min.js'));
  w.eval(file('app.js'));
  await new Promise((r) => setTimeout(r, 150));
  return w;
}

const text = (w, id) => (w.document.getElementById(id)?.textContent ?? '').trim();
// The clock is several elements now, so read its parts rather than the container.
const clockOf = (w) => `${text(w, 'clockTime')}${text(w, 'clockMer')}`;

console.log('=== Shabbos and Yom Tov transitions ===');
for (const [when, tag] of [
  ['2026-08-28T14:05:00-04:00', 'Friday afternoon'],
  ['2026-08-28T19:40:00-04:00', 'Friday night, Shabbos in'],
  ['2026-08-29T11:00:00-04:00', 'Shabbos morning'],
  ['2026-08-29T21:00:00-04:00', 'Motzei Shabbos'],
  ['2026-09-11T17:00:00-04:00', 'Erev Rosh Hashana'],
  ['2026-09-12T16:00:00-04:00', 'Rosh Hashana day 1'],
  ['2026-09-12T20:30:00-04:00', 'RH day 1, after tzeis'],
  ['2026-09-13T16:00:00-04:00', 'Rosh Hashana day 2'],
  ['2026-09-21T13:00:00-04:00', 'Yom Kippur'],
  ['2026-09-29T13:00:00-04:00', 'Chol HaMoed Succos'],
  ['2026-10-03T16:00:00-04:00', 'Shemini Atzeres on Shabbos'],
  ['2027-04-23T17:00:00-04:00', 'Pesach on Friday'],
  ['2027-04-23T20:00:00-04:00', 'Pesach Friday, after candles'],
]) {
  const w = await boot(when);
  console.log(' ', tag.padEnd(30), clockOf(w).padEnd(9),
    text(w, 'occasion').padEnd(22), text(w, 'edge').padEnd(30),
    'lock:', w.document.body.classList.contains('locked') ? 'Y' : 'n');
}

// Counted, not just printed. This file ended with an unconditional exit(0), so
// it reported problems in prose and then told the caller everything was fine —
// which is worth nothing now that CI runs it.
let failures = 0;
const must = (cond, what) => { if (!cond) { failures += 1; console.log('  FAIL', what); } };

console.log('\n=== Failure modes: the clock must survive all of these ===');
const when = '2026-08-28T14:05:00-04:00';
for (const [tag, opts] of [
  ['shuls.json down', { failFetch: ['shuls.json'] }],
  ['minyanim.json down', { failFetch: ['minyanim.json'] }],
  ['everything down', { failFetch: ['data/'] }],
  ['wake lock unsupported', { wakeLock: false }],
  ['no shuls selected', { settings: { shuls: [] } }],
  ['unknown shul slug', { settings: { shuls: ['does-not-exist'] } }],
  ['corrupt settings', { settings: { perShul: 'nonsense', accent: 'bogus', clockSize: 'x' } }],
]) {
  const w = await boot(when, opts);
  const clock = clockOf(w);
  console.log(' ', tag.padEnd(24), '| clock', JSON.stringify(clock).padEnd(10),
    '|', text(w, 'shuls').replace(/\s+/g, ' ').slice(0, 58));
  // The whole point of the section: whatever else is broken, the time is on the
  // wall. "--:--" is the placeholder in index.html, so it means start() threw
  // before the first tick.
  must(/^\d{1,2}:\d{2}(am|pm)$/.test(clock), `${tag}: clock reads ${JSON.stringify(clock)}`);
  must(text(w, 'hebrewDate').length > 0, `${tag}: no Hebrew date`);
}

console.log('\n=== Scraper parsing ===');
const page = `<h4>Friday, August 28</h4>
  <h4>Shacharis</h4><li><td>Shacharis<br>Ashkenaz</td><td>6:30 AM</td></li>
  <h4>Mincha</h4><li><td>Mincha/Maariv<br>Ashkenaz</td><td>7:20 PM</td>Shkiya 7:35 PM</li>
  <h4>Maariv</h4><h5>There are no Maariv minyanim scheduled for today.</h5>`;
const lines = toText(page);
console.log('  date read from page :', renderedDate(lines, '2026'));
console.log('  abbreviated form    :', renderedDate(toText('<h4>Fri, Aug 28, 2026</h4>'), '1999'));
console.log('  parsed              :', JSON.stringify(parseSections(lines)));
console.log('  (the Shkiya line must not appear as a minyan)');

console.log('\n=== Normalisation: what the parser is allowed to hand on ===');
for (const [input, want] of [
  ['8:30PM', '8:30 PM'], ['08:30 P.M.', '8:30 PM'], ['7:00  am', '7:00 AM'],
  ['13:00 PM', null], ['8:75 AM', null], ['not a time', null],
]) must(cleanTime(input) === want, `cleanTime(${JSON.stringify(input)}) -> ${JSON.stringify(cleanTime(input))}, wanted ${JSON.stringify(want)}`);

for (const [input, want] of [
  ['Shachris', 'Shacharis'], ['Shacharit', 'Shacharis'], ['Minchah', 'Mincha'],
  ['Mincha:', 'Mincha'], ['  Mincha/Maariv  ', 'Mincha/Maariv'],
  // A synonym, not a misspelling: rewriting it would be editing a shul's words.
  ['Arvit', 'Arvit'],
  ['Preceded by Tehillim, Tefillah and Togetherness at', null],
  ['Please note the time change this week', null],
  ['8:30 PM', null],
]) must(cleanLabel(input) === want, `cleanLabel(${JSON.stringify(input)}) -> ${JSON.stringify(cleanLabel(input))}, wanted ${JSON.stringify(want)}`);

{
  const cleaned = normaliseSections({
    source: 'shul',
    edge: { havdalah: '7:35 PM' },
    shacharis: [
      { label: 'Shacharis', time: '8:45 AM' },
      { label: 'Shacharis', time: '8:45 AM' },
      { label: 'shacharis', time: '8:45 AM' },
      { label: 'Shachris', time: '9:00 AM' },
    ],
    mincha: [],
    maariv: [
      { label: 'Preceded by Tehillim, Tefillah and Togetherness at', time: '8:30PM' },
      { label: 'Maariv', time: '8:30PM' },
    ],
  });
  must(cleaned.shacharis.length === 2, `duplicate rows survived (${cleaned.shacharis.length})`);
  must(cleaned.maariv.length === 1, `a sentence survived as a minyan (${cleaned.maariv.length})`);
  must(cleaned.maariv[0]?.time === '8:30 PM', `time not normalised (${cleaned.maariv[0]?.time})`);
  must(cleaned.edge?.havdalah === '7:35 PM', 'normalisation dropped a key it does not own');
  must(cleaned.shacharis[1]?.raw === 'Shachris',
    `the original label is kept when normalisation changed it (${cleaned.shacharis[1]?.raw})`);
  must(cleaned.shacharis[0]?.raw === undefined,
    'and not kept when it did not');
  console.log('  duplicates collapsed, prose dropped, times and spellings settled');
}

{
  // Sections come out in the order the day happens, whatever order the source
  // listed them in.
  const jumbled = normaliseSections({
    shacharis: [
      { label: 'Shacharis', time: '9:00 AM' },
      { label: 'Shacharis', time: '6:30 AM' },
      { label: 'Shacharis', time: '12:05 PM' },
      { label: 'Shacharis', time: '7:45 AM' },
    ],
    mincha: [], maariv: [],
  });
  const order = jumbled.shacharis.map((r) => r.time);
  must(order.join(' ') === '6:30 AM 7:45 AM 9:00 AM 12:05 PM',
    `sections are not in time order (${order.join(' ')})`);
  console.log(`  sorted chronologically: ${order.join(' · ')}`);
}

// And the file that is actually on the wall must already be clean.
{
  const live = JSON.parse(file('data/minyanim.json'));
  let dirty = 0;
  for (const shuls of Object.values(live.days ?? {})) {
    for (const entry of Object.values(shuls)) {
      for (const g of ['shacharis', 'mincha', 'maariv']) {
        const rows = entry[g] ?? [];
        const seen = new Set();
        for (const r of rows) {
          const k = `${String(r.label).toLowerCase()}|${r.time}`;
          if (seen.has(k)) dirty += 1;
          seen.add(k);
          if (cleanLabel(r.label) !== r.label || cleanTime(r.time) !== r.time) dirty += 1;
        }
      }
    }
  }
  must(dirty === 0, `data/minyanim.json carries ${dirty} row(s) normalisation would change`);
  console.log(dirty ? '' : '  data/minyanim.json is clean');
}

console.log('\n=== A year of daily renders ===');
let bad = 0;
for (let i = 0; i < 365; i += 1) {
  const d = new Date(Date.UTC(2026, 8, 1 + i, 21, 0));
  const w = await boot(d.toISOString());
  const out = [clockOf(w), text(w, 'edge'), text(w, 'hebrewDate')];
  const locked = w.document.body.classList.contains('locked');
  const edgeRequired = locked || !w.document.getElementById('edge').hidden;
  if (!/^\d{1,2}:\d{2}(am|pm)$/.test(out[0]) || !out[2]
      || (edgeRequired && !out[1])
      || /NaN|undefined|Invalid/.test(out.join(''))) {
    bad += 1;
    console.log('  BAD', d.toISOString().slice(0, 10), JSON.stringify(out));
  }
}
console.log(bad ? `  ${bad} bad day(s)` : '  365/365 rendered cleanly');
failures += bad;

if (failures) console.log(`\n${failures} failure(s)`);
else console.log('\nAll checks passed');
process.exit(failures ? 1 : 0);
