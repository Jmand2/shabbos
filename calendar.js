/* Shabbos Clock — dates, zmanim, and the shape of the day.

   Everything here is computed on the iPad from Teaneck's coordinates. It needs
   no network and never goes out of date.

   Loaded as ordinary scripts, in the order index.html lists them, sharing one
   script scope. Not ES modules: jsdom cannot load <script type="module"> at
   all, and both behavioural suites work by loading the real index.html and
   running the real app inside it. Splitting the file was worth doing; giving up
   that harness to get import statements was not. */

const KZ = window.KosherZmanim;
const PLACE = { name: 'Teaneck', lat: 40.9068, lon: -74.0104, elev: 30, tz: 'America/New_York' };
const GEO = new KZ.GeoLocation(PLACE.name, PLACE.lat, PLACE.lon, PLACE.elev, PLACE.tz);

/* Dates and zmanim ------------------------------------------------------ */

const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, 12);
const toDate = (dt) => (dt ? dt.toJSDate() : null);

function zmanim(day) {
  const cal = new KZ.ComplexZmanimCalendar(GEO);
  cal.setDate(KZ.Luxon.DateTime.fromJSDate(day).setZone(PLACE.tz));
  return cal;
}

function dayInfo(now) {
  const cal = zmanim(now);
  const sunset = toDate(cal.getSunset());
  const tzeis = toDate(cal.getTzais());
  const civil = new JewishDay(now);
  // The Hebrew date turns at sunset.
  const hebrewFor = now >= sunset ? addDays(now, 1) : now;
  return { cal, sunset, tzeis, civil, hebrewFor, hebrew: new JewishDay(hebrewFor) };
}

function JewishDay(d) {
  this.jc = new KZ.JewishCalendar(new Date(d.getFullYear(), d.getMonth(), d.getDate()));
}

const fmtHeb = new KZ.HebrewDateFormatter();
fmtHeb.setHebrewFormat(true);
const fmtEng = new KZ.HebrewDateFormatter();

function occasionOf(jc, from) {
  const name = fmtEng.formatYomTov(jc);   // already includes the Chanukah day number
  const parsha = fmtEng.formatParsha(jc);
  if (name && parsha) return `${name} · ${parsha}`;
  return name || parsha || fmtEng.formatParsha(new KZ.JewishCalendar(nextShabbos(from)));
}

// Counted from the day being displayed, so once Shabbos is out this moves on to
// next week's parsha instead of repeating the one just read.
function nextShabbos(from) {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7));
  return d;
}

/* Is work forbidden right now? Drives the no-touch lock. */
function isLocked(now, info) {
  const candles = toDate(info.cal.getCandleLighting());
  if (info.civil.jc.isAssurBemelacha() && now < info.tzeis) return true;
  return info.civil.jc.isTomorrowShabbosOrYomTov() && now >= candles;
}

// Walks forward to the end of the current rest period, so Friday night shows
// havdalah and a three-day Yom Tov shows the day it actually ends. Returns the
// day as well: a shul's havdalah is read off that day's maariv, not off tzeis.
function restEnd(now) {
  for (let i = 0; i < 4; i += 1) {
    const day = addDays(now, i);
    const jc = new JewishDay(day).jc;
    if (!jc.isAssurBemelacha() || jc.isTomorrowShabbosOrYomTov()) continue;
    const tzeis = toDate(zmanim(day).getTzais());
    if (tzeis > now) return { day, tzeis };
  }
  return null;
}
const restEndsAt = (now) => restEnd(now)?.tzeis ?? now;

