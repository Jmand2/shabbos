// Pulls real minyan times from teaneckminyanim.com into data/minyanim.json.
// Runs on GitHub Actions, never in the browser (no CORS, no client dependency).
// Rule: a day is only written if the page we parsed actually rendered that day.
// Anything unverified is left out so the display can say "unavailable" instead of guessing.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const ORG_URL = 'https://teaneckminyanim.com/org/{slug}';
const DATE_URL = 'https://teaneckminyanim.com/org/{slug}/next?after={date}';
const OUT = new URL('../data/minyanim.json', import.meta.url);
const DAYS_AHEAD = 4;   // covers a three-day Yom Tov
const KEEP_DAYS = 3;
const ZONE = 'America/New_York';
const SECTIONS = ['Shacharis', 'Mincha', 'Maariv'];
const NUSACH = /\s+(Ashkenaz|Sefard|Sephard|Sephardic|Nusach Ari|Chabad|Edot Hamizrach)$/i;
const NUSACH_ONLY = /^(Ashkenaz|Sefard|Sephard|Sephardic|Nusach Ari|Chabad|Edot Hamizrach)$/i;
// Sunset markers, notes and the site's own summary line are not minyanim.
const NOT_A_MINYAN = /:$|^(Shkiya|Shekiya|Sunset|Netz|Candle|Havdalah|Tzeis|Tzes|Next Minyan|Zman)\b/i;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const SHULS = JSON.parse(await readFile(new URL('../data/shuls.json', import.meta.url), 'utf8'));

export function toText(html) {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|td|th|h\d|section)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

// The page prints its own day, e.g. "Friday, August 28". That is our proof of which
// date we actually received.
export function renderedDate(lines, year) {
  for (const line of lines) {
    const m = /^[A-Z][a-z]{2,},\s+([A-Z][a-z]{2,})\.?\s+(\d{1,2})(?:,\s*(\d{4}))?$/.exec(line);
    if (!m) continue;
    const stem = m[1].slice(0, 3).toLowerCase();
    const month = MONTHS.findIndex((name) => name.toLowerCase().startsWith(stem));
    if (month < 0) continue;
    return `${m[3] ?? year}-${String(month + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  return null;
}

export function parseSections(lines) {
  const out = {};
  let current = null;
  let pending = null;
  for (const line of lines) {
    // Headings appear once; a later identical line is a row label, not a new section.
    const heading = SECTIONS.find((s) => line.toLowerCase() === s.toLowerCase());
    if (heading && !(heading.toLowerCase() in out)) {
      current = heading.toLowerCase(); out[current] = []; pending = null; continue;
    }
    if (!current) continue;
    const m = /^(.*?)(\d{1,2}:\d{2}\s*[AP]M)\b(.*)$/i.exec(line);
    if (!m) {
      if (!NUSACH_ONLY.test(line)) pending = line.replace(NUSACH, '').trim();
      continue;
    }
    const label = (m[1].trim() ? m[1].replace(NUSACH, '').trim() : pending) ?? '';
    if (!label || NOT_A_MINYAN.test(label)) continue;
    out[current].push({
      label,
      time: m[2].toUpperCase().replace(/\s+/, ' '),
      note: m[3].replace(/^[\s|-]+/, '').trim() || undefined,
    });
  }
  return SECTIONS.every((s) => s.toLowerCase() in out) ? out : null;
}

// en-CA already formats as YYYY-MM-DD, so nothing here depends on how the
// runner's ICU punctuates a locale string.
const TODAY = new Intl.DateTimeFormat('en-CA',
  { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

function isoDate(offsetDays) {
  const d = new Date(`${TODAY}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

// Format date for the /next endpoint: "Mon Sep 14 15:00:00 EDT 2026"
// Note: /next returns the day AFTER the date we pass, so we subtract 1 day
function formatDateForNext(isoDateStr) {
  const d = new Date(isoDateStr + 'T15:00:00');
  d.setDate(d.getDate() - 1); // Subtract one day because /next returns the next day after this
  const opts = { timeZone: ZONE, hour12: false };
  const weekday = d.toLocaleString('en-US', { ...opts, weekday: 'short' });
  const month = d.toLocaleString('en-US', { ...opts, month: 'short' });
  const day = d.toLocaleString('en-US', { ...opts, day: 'numeric' });
  const time = d.toLocaleString('en-US', { ...opts, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const year = d.toLocaleString('en-US', { ...opts, year: 'numeric' });
  const tz = d.toLocaleString('en-US', { ...opts, timeZoneName: 'short' }).split(' ').pop();
  return `${weekday} ${month} ${day} ${time} ${tz} ${year}`;
}

async function grab(slug, date, useDateParam) {
  const url = (useDateParam ? DATE_URL : ORG_URL)
    .replace('{slug}', slug).replace('{date}', useDateParam ? encodeURIComponent(formatDateForNext(date)) : date);
  const res = await fetch(url, {
    headers: { 'user-agent': 'shabbos-clock/1.0' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return null;
  const lines = toText(await res.text());
  if (renderedDate(lines, date.slice(0, 4)) !== date) return null;
  return parseSections(lines);
}

async function main() {
  const today = isoDate(0);
  const wanted = Array.from({ length: DAYS_AHEAD }, (_, i) => isoDate(i));
  const previous = await readFile(OUT, 'utf8').then(JSON.parse).catch(() => ({ days: {} }));
  const days = {};
  const cutoff = isoDate(-KEEP_DAYS);
  for (const [date, entry] of Object.entries(previous.days ?? {})) {
    if (date >= cutoff) days[date] = entry;
  }

  let dateParamWorks = false;
  let fetched = 0;
  for (const date of wanted) {
    const useDateParam = date !== today;
    for (const shul of SHULS) {
      const parsed = await grab(shul.slug, date, useDateParam).catch(() => null);
      await new Promise((r) => setTimeout(r, 250));
      if (!parsed) continue;
      if (useDateParam) dateParamWorks = true;
      fetched += 1;
      days[date] ??= {};
      days[date][shul.slug] = parsed;
    }
  }

  await mkdir(new URL('../data/', import.meta.url), { recursive: true });
  await writeFile(OUT, `${JSON.stringify({
    generated_at: fetched ? new Date().toISOString() : previous.generated_at,
    source: 'teaneckminyanim.com',
    days,
  }, null, 2)}\n`);

  const got = Object.keys(days).filter((d) => d >= today);
  console.log(`fetched ${fetched} schedule(s); ${got.length} day(s) on file: ${got.join(', ')}`);
  if (!dateParamWorks) {
    console.warn('Only today could be verified. Future days need the correct DATE_URL template.');
  }
  if (!fetched) {
    // Fail loudly: a silent green run that pulled nothing is how a wall display
    // quietly goes stale for a week.
    console.error('No schedules could be fetched.');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
