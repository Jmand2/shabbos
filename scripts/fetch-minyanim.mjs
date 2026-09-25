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
// Hand-entered times for days no source publishes. See data/overrides.json.
const OVERRIDES = JSON.parse(await readFile(new URL('../data/overrides.json', import.meta.url), 'utf8'));

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

/* Hand-entered fallbacks --------------------------------------------------

   Fills a section that no source published. Never replaces one.

   That asymmetry is the whole safety property. A line in overrides.json can go
   stale — the shul moves Mincha and nobody edits the file — and the worst it
   can do is sit unused, because the moment teaneckminyanim or the shul's own
   site carries that service the live copy wins. It cannot put an old time on
   the wall in front of a current one.

   The gap it exists for is Yom Tov: the aggregator has Beth Aaron's weekday
   Mincha and Maariv but not its festival schedule, and the shul's own widget
   lists events rather than services on those days. */
// Last run's hand-entered rows, taken back out before this run begins.
//
// applyOverrides only ever fills what no source published, and it decides that
// by looking at what is already on file. Left in place, yesterday's override
// IS what is already on file — so the merge saw its own work, concluded a live
// source had spoken, and recorded nothing. The times stayed right and the
// provenance quietly rotted: an edge typed off a PDF in September read as
// scraped by the second run onwards.
//
// Every run now re-derives it from scratch. Anything still in overrides.json
// and still inside its covers is put back a moment later; anything that has
// been removed from that file correctly disappears rather than living on as a
// fossil nothing can account for.
export function stripHand(entry) {
  const out = {};
  for (const [slug, e] of Object.entries(entry)) {
    if (!e?.hand) { out[slug] = e; continue; }
    const clean = { ...e };
    for (const g of e.hand.sections ?? []) delete clean[g];
    if (e.hand.edge?.length && clean.edge) {
      clean.edge = { ...clean.edge };
      for (const k of e.hand.edge) delete clean.edge[k];
      if (!Object.keys(clean.edge).length) delete clean.edge;
    }
    if (clean.sources) {
      clean.sources = { ...clean.sources };
      for (const g of e.hand.sections ?? []) delete clean.sources[g];
      if (e.hand.edge?.length) delete clean.sources.edge;
      if (!Object.keys(clean.sources).length) delete clean.sources;
    }
    delete clean.hand;
    out[slug] = clean;
  }
  return out;
}

// "2026-09-25/2026-09-27" — inclusive, and the only dates an entry may touch.
function coversRange(entry) {
  const m = /^(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})$/.exec(String(entry?.covers ?? ''));
  return m ? { from: m[1], to: m[2] } : null;
}

export { coversRange };

export function applyOverrides(days, overrides) {
  let filled = 0;
  const hands = [];
  for (const entry of overrides?.entries ?? []) {
    // COVERS IS ENFORCED, NOT DECORATION.
    //
    // data/overrides.json said in its own header that every entry needs one and
    // that the checks would act on it. Nothing read the field. An entry could
    // name any date it liked, including one a later edit never meant to touch,
    // and the file documented a safeguard it did not have — which is worse than
    // not claiming one, because it is the thing somebody would rely on.
    const range = coversRange(entry);
    if (!range) {
      console.warn(`overrides: ${entry.shul} has no usable "covers" — skipped entirely`);
      continue;
    }
    for (const [date, sections] of Object.entries(entry.days ?? {})) {
      if (date < range.from || date > range.to) {
        console.warn(`overrides: ${entry.shul} ${date} is outside covers `
          + `${entry.covers} — not applied`);
        continue;
      }
      // Only for days the run actually covers. Writing a day outside the
      // window would resurrect a date the scraper had just aged out.
      if (!days[date]) continue;
      const existing = days[date][entry.shul];
      const merged = { ...existing };
      let touched = 0;
      const handed = [];
      for (const group of SECTIONS.map((g) => g.toLowerCase())) {
        if (!sections[group]?.length) continue;
        if (existing?.[group]?.length) continue;   // a live source spoke; it wins
        merged[group] = sections[group];
        handed.push(group);
        touched += 1;
      }
      // The shul's own edges, same rule, KEY BY KEY. This spread the override
      // last, so a hand-entered candle time replaced a scraped one rather than
      // filling for it — the exact opposite of the rule this file is built on —
      // and it only ever looked at havdalah, so an entry carrying candles was
      // judged by whether a different key was present.
      const handedEdge = [];
      if (sections.edge) {
        const have = existing?.edge ?? {};
        const add = Object.fromEntries(
          Object.entries(sections.edge).filter(([k]) => !have[k]));
        if (Object.keys(add).length) {
          merged.edge = { ...have, ...add };
          handedEdge.push(...Object.keys(add));
          touched += 1;
        }
      }
      if (!touched) continue;
      filled += touched;
      hands.push(...handed);
      // WHICH PARTS are hand-entered, not merely that some part is.
      //
      // This used to stamp the whole shul-day, so a day whose Shacharis came
      // from teaneckminyanim twenty minutes ago and whose Mincha was typed in
      // from a PDF in September read as entirely hand-entered — and it kept the
      // scrape's fetched_at, so the typed rows also looked twenty minutes old.
      // Provenance is the thing somebody reads to decide whether to trust a
      // time, so it has to say which time.
      const sources = { ...(existing?.sources ?? {}) };
      for (const g of handed) sources[g] = 'manual';
      if (handedEdge.length) sources.edge = 'manual';
      days[date][entry.shul] = {
        ...normaliseSections(merged),
        ...(merged.edge ? { edge: merged.edge } : {}),
        ...(Object.keys(sources).length ? { sources } : {}),
        fetched_at: existing?.fetched_at,
        hand: {
          source: entry.source,
          entered_at: entry.entered_at,
          sections: handed,
          ...(handedEdge.length ? { edge: handedEdge } : {}),
        },
      };
    }
  }
  if (filled) {
    console.log(`overrides filled ${filled} empty section(s): ${[...new Set(hands)].join(', ')}`);
  }
  return filled;
}

async function main() {
  const today = isoDate(0);
  const wanted = Array.from({ length: DAYS_AHEAD }, (_, i) => isoDate(i));
  const previous = await readFile(OUT, 'utf8').then(JSON.parse).catch(() => ({ days: {} }));
  const days = {};
  const cutoff = isoDate(-KEEP_DAYS);
  for (const [date, entry] of Object.entries(previous.days ?? {})) {
    if (date >= cutoff) days[date] = stripHand(entry);
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
  // Keyed per SERVICE, not per day.
  //
  // A shul's own widget can carry Shacharis and say nothing at all about
  // Mincha — Beth Aaron's does exactly that on Yom Tov. Keyed by the day, one
  // Shacharis marked the whole day handled and the aggregator was never asked
  // about the rest, so a Mincha teaneckminyanim had all along never reached the
  // board. This is the same mistake as "a parse is not coverage", one level
  // down: a SECTION is not coverage of the other sections.
  const filled = new Set();
  const key = (slug, date, group = '') => `${slug}|${date}|${group}`;
  const groups = SECTIONS.map((g) => g.toLowerCase());
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
      const sources = {};
      for (const g of groups) {
        if (!clean[g]?.length) continue;
        filled.add(key(shul.slug, date, g));
        sources[g] = 'shul';
      }
      if (clean.edge?.candles || clean.edge?.havdalah) sources.edge = 'shul';
      if (Object.keys(sources).length) days[date][shul.slug].sources = sources;
    }
  }

  for (const date of wanted) {
    const useDateParam = date !== today;
    for (const shul of SHULS) {
      // Only skip a shul-day the own site answered COMPLETELY.
      if (groups.every((g) => filled.has(key(shul.slug, date, g)))) continue;
      const parsed = await grab(shul.slug, date, useDateParam).catch(() => null);
      await new Promise((r) => setTimeout(r, 250));
      if (!parsed) continue;
      if (useDateParam) dateParamWorks = true;

      // A PAGE THAT LISTS NOTHING IS NOT A CONFIRMATION THAT THERE IS NOTHING.
      //
      // grab() returns the parse, and a parse with every section empty is still
      // an object — so a page that rendered the right date but no services
      // overwrote whatever was already on file and stamped it with the current
      // time. A good schedule from an hour ago was replaced by an empty one
      // that looked newer, and the board went from a full card to "Done for
      // today". The aggregator does serve pages like that: it renders "There
      // are no Mincha minyanim scheduled" as a normal page with a 200.
      //
      // So an empty parse may CREATE an entry where there was none — that is
      // real information, and the board says "nothing further listed" honestly
      // — but it may never replace one that has times in it.
      const rows = SECTIONS.reduce(
        (n, g) => n + (parsed[g.toLowerCase()]?.length ?? 0), 0);
      const had = SECTIONS.reduce(
        (n, g) => n + (days[date]?.[shul.slug]?.[g.toLowerCase()]?.length ?? 0), 0);
      if (!rows && had) {
        console.warn(`${shul.slug} ${date}: empty page, keeping the ${had} time(s) on file`);
        continue;
      }
      fetched += 1;
      days[date] ??= {};
      // The shul's own candle lighting and havdalah survive the aggregator
      // writing over the day. They are the times its members actually keep, and
      // the aggregator does not carry them — dropping them here would mean
      // falling back to a computed tzeis for a shul that publishes its own.
      const own = days[date][shul.slug];
      const ownEdge = own?.edge;
      // Stamped per shul-day. generated_at goes fresh if ANY fetch in the run
      // succeeded, so a shul still showing an entry retained from a previous
      // run looked exactly as current as one just confirmed.
      // Section by section: whatever the shul's own site gave stands, and the
      // aggregator answers for the rest. Writing the aggregator's whole reply
      // here would throw away the sections the shul had already spoken for.
      const fresh = normaliseSections(parsed);
      const keep = {};
      for (const g of groups) {
        keep[g] = filled.has(key(shul.slug, date, g)) ? (own?.[g] ?? []) : (fresh[g] ?? []);
      }
      // [17] WHICH SOURCE SUPPLIED WHICH SERVICE, section by section.
      //
      // Provenance was a property of the DAY, and the day is now assembled from
      // two or three places at once: a Shacharis off the shul's own site, a
      // Mincha off the aggregator, a Maariv typed in from a PDF. One label for
      // all of it could only ever be wrong about most of it, and provenance is
      // exactly what somebody reads when they are deciding whether to believe a
      // time.
      const sources = { ...(own?.sources ?? {}) };
      for (const g of groups) {
        if (!filled.has(key(shul.slug, date, g)) && fresh[g]?.length) {
          sources[g] = 'aggregator';
        }
      }
      days[date][shul.slug] = {
        ...fresh,
        ...keep,
        ...(ownEdge ? { edge: ownEdge } : {}),
        ...(Object.keys(sources).length ? { sources } : {}),
        fetched_at: new Date().toISOString(),
      };
    }
  }

  applyOverrides(days, OVERRIDES);

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
