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

/* Normalisation -----------------------------------------------------------
   The parsers are deliberately permissive: faced with an odd line they would
   rather capture it than drop a real minyan. This is where that is paid back,
   in one place that can be read and tested on its own rather than as more
   special cases smuggled into the regexes above.

   It only ever removes or tidies. It never invents a minyan. */

const TIME_RE = /^(\d{1,2}):(\d{2})\s*([AP])\.?\s*M\.?$/i;

// A service has a name; these are sentences that happen to contain a time.
// "Preceded by Tehillim, Tefillah and Togetherness at 8:30PM" is a note about
// a minyan, not a minyan, and it was reaching the wall as one.
const PROSE = /\b(preceded|followed|please|note|beginning|begins|starting|starts|approximately|immediately|thereafter|as above|see |contact)\b/i;
// Six words is already generous for "Mincha/Maariv Early Sefard".
const MAX_WORDS = 6;

// Spelling only. Deliberately not synonyms: Arvit is not a misspelling of
// Maariv, and rewriting it would be editing a shul's own words.
const SPELLING = [
  [/\bshach?a?ris\b/gi, 'Shacharis'],
  [/\bshach?a?rit\b/gi, 'Shacharis'],
  [/\bminchah\b/gi, 'Mincha'],
  [/\bma'?ariv\b/gi, 'Maariv'],
];

// "8:30PM" and "8:30 p.m." both become "8:30 PM". timeToDate in the display
// accepts the first of those by luck rather than design, and the second not at
// all, so the shape is settled here instead.
export function cleanTime(text) {
  const m = TIME_RE.exec(String(text ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 1 || h > 12 || min > 59) return null;
  return `${h}:${m[2]} ${m[3].toUpperCase()}M`;
}

export function cleanLabel(text) {
  let out = String(text ?? '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s|\-–—·,]+|[\s|\-–—·,:;.]+$/g, '')
    .trim();
  if (!out) return null;
  if (PROSE.test(out)) return null;
  if (out.split(' ').length > MAX_WORDS) return null;
  // A label that is only a time, or only a number, names nothing.
  if (cleanTime(out) || /^[\d\s:.]+$/.test(out)) return null;
  for (const [re, to] of SPELLING) out = out.replace(re, to);
  return out;
}

// Minutes past midnight, for ordering only.
const minutesOf = (t) => {
  const m = /^(\d{1,2}):(\d{2}) ([AP])M$/.exec(t);
  if (!m) return 0;
  return ((Number(m[1]) % 12) + (m[3] === 'P' ? 12 : 0)) * 60 + Number(m[2]);
};

// Deduplicates on label+time+note within a section, then puts the section in
// the order the day actually happens. The scrape genuinely repeats rows —
// Shaare Tefillah listed the same 8:45 AM Shacharis twice, and the board
// printed it twice — and it does not always list them in time order.
export function normaliseSections(entry) {
  if (!entry) return entry;
  const out = { ...entry };
  for (const group of SECTIONS.map((g) => g.toLowerCase())) {
    const rows = entry[group];
    if (!Array.isArray(rows)) continue;
    const seen = new Set();
    out[group] = rows.flatMap((row) => {
      const label = cleanLabel(row.label);
      const time = cleanTime(row.time);
      if (!label || !time) return [];
      const note = typeof row.note === 'string' ? row.note.replace(/\s+/g, ' ').trim() : '';
      const k = `${label.toLowerCase()}|${time}|${note.toLowerCase()}`;
      if (seen.has(k)) return [];
      seen.add(k);
      const clean = { ...row, label, time, note: note || undefined };
      // Kept only when this stage actually changed the label, so a surprising
      // row on the wall can be traced back to what the shul really published
      // without having to re-scrape to find out.
      if (label !== row.label) clean.raw = row.label;
      return [clean];
    // Chronological. The display sorts what it shows anyway, but the file is
    // read by people too, and a diff between two scrapes is unreadable when the
    // rows can move around for no reason.
    }).sort((a, b) => minutesOf(a.time) - minutesOf(b.time));
  }
  return out;
}

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

// ---- A shul's own site (ShulCloud) --------------------------------------
//
// Preferred over the aggregator wherever a shul has one: it is the shul's own
// publication, and it carries what teaneckminyanim leaves out — Kol Nidrei,
// Neila, and the shul's own candle lighting and fast-end times.
//
// Access: the platform's WAF answers 406 to a blank or tokenless user-agent
// (curl and a headless browser are both refused), and 200 to one that names
// itself and gives a contact URL. Nothing is spoofed here. robots.txt allows
// "/" and disallows /calendar*, /cal.php* and /zmanim.php*, so we read only the
// home page, and it asks for Crawl-delay: 10, which SITE_DELAY honours.
const SHUL_UA = 'shabbos-clock/1.0 (+https://github.com/Jmand2/shabbos)';
const SITE_DELAY = 10000;

// The widget mixes services with zmanim, the fast's edges, and shul events —
// a children's lunch sat in it at noon on Yom Kippur. Naming the things to
// exclude cannot keep up with whatever a shul schedules next, so this names the
// things to include instead: a row reaches the board only if it reads as a
// service. "minyan" is in the list so an unusual one (youth, teen, Sephardic)
// still counts.
const IS_A_SERVICE = /shacharis|shachris|shacharit|mincha|maariv|arvit|selichos|selichot|selicot|slichos|kol ?nidre|neila|ne'?ilah?|musaf|mussaf|vasikin|vosikin|hashkama|minyan|davening/i;

// The widget prints no date, so the two sections are read as today and tomorrow
// in the shul's own timezone — the same zone TODAY is computed in.
function parseShulSite(html) {
  const heads = [...html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi)]
    .map((m) => ({ at: m.index, end: m.index + m[0].length,
      text: m[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() }));
  const want = { "Today's Calendar": 'today', "Tomorrow's Calendar": 'tomorrow' };
  const out = {};
  for (let i = 0; i < heads.length; i += 1) {
    const key = want[heads[i].text];
    if (!key) continue;
    // A section runs to the next heading of any kind: "Tomorrow's Calendar" is
    // followed by "Friday Night", whose rows are a different day entirely.
    const seg = html.slice(heads[i].end, heads[i + 1] ? heads[i + 1].at : html.length);
    const sections = { shacharis: [], mincha: [], maariv: [] };
    const edge = {};
    // The label is sometimes wrapped in a link to the event page.
    const ROW = /<bdi>([\s\S]*?)<\/bdi>\s*(?:<\/a>\s*)?<div class="right_calendar_widget_time">\s*:?\s*([^<]+)<\/div>/g;
    for (const m of seg.matchAll(ROW)) {
      const label = m[1].replace(/<[^>]*>/g, '').replace(/&amp;/g, '&')
        .replace(/&#39;|&apos;/g, "'").replace(/\s+/g, ' ').trim();
      const t = /^(\d{1,2}):(\d{2})\s*([ap])m$/i.exec(m[2].trim());
      if (!label || !t) continue;
      const time = `${Number(t[1])}:${t[2]} ${t[3].toUpperCase()}M`;
      // The fast's edges are the shul's own, and worth keeping even though they
      // are not services; everything else unrecognised is dropped.
      if (/^candle ?lighting/i.test(label)) edge.candles ??= time;
      if (/^(havdalah|fast ends)/i.test(label)) edge.havdalah ??= time;
      if (!IS_A_SERVICE.test(label)) continue;
      let h = Number(t[1]) % 12;
      if (t[3].toLowerCase() === 'p') h += 12;
      sections[serviceGroup(label, h * 60 + Number(t[2]))].push({ label, time });
    }
    out[key] = { ...sections, source: 'shul', ...(Object.keys(edge).length ? { edge } : {}) };
  }
  // Both sections or nothing: half a widget means the page is not what we think
  // it is, and a wrong day is worse than no day.
  return out.today && out.tomorrow ? out : null;
}

export function serviceGroup(label, minutes) {
  if (/shacharis|shachris|shacharit|vasikin|vosikin|hashkama|netz minyan/i.test(label)) return 'shacharis';
  if (/mincha/i.test(label)) return 'mincha';
  if (/maariv|arvit|kol ?nidre|neila|ne'?ilah?/i.test(label)) return 'maariv';
  // Otherwise place it by the clock, cutting the day at 3am rather than
  // midnight so that night selichos at 12:45am sits with the evening.
  if (minutes >= 180 && minutes < 720) return 'shacharis';
  if (minutes >= 720 && minutes < 1080) return 'mincha';
  return 'maariv';
}

async function grabShulSite(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': SHUL_UA },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) return null;
  return parseShulSite(await res.text());
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

  // A shul that publishes its own schedule is the authority on it for the days
  // that schedule covers, and it carries the services the aggregator omits.
  //
  // But its site reaches only today and tomorrow, and this used to mark the
  // whole SHUL as handled — so the aggregator loop skipped it for every date,
  // and an own-site shul got two days of coverage where every other shul got
  // four. Both shuls on the wall are own-site shuls, so on a three-day Yom Tov
  // the last day was not merely unread, it was never fetched.
  //
  // Now it records the DAYS it filled, not the shuls, and the aggregator fills
  // the rest. Own site still wins wherever it spoke.
  const filled = new Set();
  const key = (slug, date) => `${slug}|${date}`;
  const tomorrow = isoDate(1);
  for (const shul of SHULS.filter((x) => x.site)) {
    const parsed = await grabShulSite(shul.site).catch(() => null);
    await new Promise((r) => setTimeout(r, SITE_DELAY));
    if (!parsed) {
      console.warn(`${shul.slug}: own site unreadable, falling back to ${new URL(ORG_URL.replace('{slug}', shul.slug)).host}`);
      continue;
    }
    fetched += 1;
    for (const [date, entry] of [[today, parsed.today], [tomorrow, parsed.tomorrow]]) {
      // A day the parser did not produce is left for the aggregator rather than
      // written as undefined and counted as covered.
      if (!entry) continue;
      const clean = normaliseSections(entry);
      days[date] ??= {};
      days[date][shul.slug] = { ...clean, fetched_at: new Date().toISOString() };

      // A PARSE IS NOT COVERAGE.
      //
      // These widgets are the shul's calendar, not its minyan board: on a given
      // day one may list a sukkah party, a shiur and candle lighting, and not a
      // single service. That parsed fine — both sections present, so not null —
      // and the day was marked covered, which stopped the aggregator filling
      // it. Beth Aaron ran for weeks with no shacharis and no mincha on the
      // wall while teaneckminyanim had the lot.
      //
      // So a day counts as covered only if the shul's own site actually gave up
      // a service. Anything else and the aggregator gets its turn, keeping the
      // edge times below, which are the shul's own and better than a
      // calculation.
      const services = SECTIONS.reduce(
        (n, g) => n + (clean[g.toLowerCase()]?.length ?? 0), 0);
      if (services) filled.add(key(shul.slug, date));
    }
  }

  for (const date of wanted) {
    const useDateParam = date !== today;
    for (const shul of SHULS) {
      if (filled.has(key(shul.slug, date))) continue;
      const parsed = await grab(shul.slug, date, useDateParam).catch(() => null);
      await new Promise((r) => setTimeout(r, 250));
      if (!parsed) continue;
      if (useDateParam) dateParamWorks = true;
      fetched += 1;
      days[date] ??= {};
      // The shul's own candle lighting and havdalah survive the aggregator
      // writing over the day. They are the times its members actually keep, and
      // the aggregator does not carry them — dropping them here would mean
      // falling back to a computed tzeis for a shul that publishes its own.
      const ownEdge = days[date][shul.slug]?.edge;
      // Stamped per shul-day. generated_at goes fresh if ANY fetch in the run
      // succeeded, so a shul still showing an entry retained from a previous
      // run looked exactly as current as one just confirmed.
      days[date][shul.slug] = {
        ...normaliseSections(parsed),
        ...(ownEdge ? { edge: ownEdge } : {}),
        fetched_at: new Date().toISOString(),
      };
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
