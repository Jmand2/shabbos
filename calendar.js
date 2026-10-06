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

// A TIME DOES NOT VANISH THE MOMENT IT ARRIVES.
//
// Somebody who walks in at 7:05 wants to know whether they have missed the
// seven o'clock, and for a while after it has passed havdalah is the most
// useful thing on the wall — it is the answer to "is it out yet". Pulling
// either off the board the instant the clock reaches it takes away the fact
// that is being asked about at exactly the moment it is asked.
//
// Twenty minutes, and then it goes. Long enough to cover walking in late and
// the gap between a published havdalah and when people actually make it; short
// enough that the board is never a list of things that already happened.
const JUST_GONE_MS = 20 * 60000;
const stillUp = (at, now) => !!at && at.getTime() > now.getTime() - JUST_GONE_MS;

/* Is work forbidden right now? Drives the no-touch lock.
 *
 * FROM SHKIYA, not from candle lighting. Melacha is forbidden from sunset;
 * the eighteen minutes before it are the published lighting time, which is a
 * margin, and they are also exactly when somebody is still finishing up — the
 * hotplate, the lights, and the display itself. Locking at candle lighting
 * took the settings away during the one stretch of the week when they are most
 * likely to be wanted. It still unlocks at tzeis. */
function isLocked(now, info) {
  if (info.civil.jc.isAssurBemelacha() && now < info.tzeis) return true;
  return info.civil.jc.isTomorrowShabbosOrYomTov() && now >= info.sunset;
}

// Walks forward to the end of the current rest period, so Friday night shows
// havdalah and a three-day Yom Tov shows the day it actually ends. Returns the
// day as well: a shul's havdalah is read off that day's maariv, not off tzeis.
function restEnd(now, grace = 0) {
  for (let i = 0; i < 4; i += 1) {
    const day = addDays(now, i);
    const jc = new JewishDay(day).jc;
    if (!jc.isAssurBemelacha() || jc.isTomorrowShabbosOrYomTov()) continue;
    const tzeis = toDate(zmanim(day).getTzais());
    // `grace` keeps a period that has only just ended, for callers that want
    // to go on naming its havdalah for a few minutes. Nothing that decides
    // whether work is forbidden passes one.
    if (tzeis.getTime() > now.getTime() - grace) return { day, tzeis };
  }
  return null;
}
const restEndsAt = (now) => restEnd(now)?.tzeis ?? now;

// Which day of a multi-day Yom Tov a given day is, as a numeral — or '' when
// the festival only lasts one day and numbering it would say nothing.
//
// Counted rather than looked up, because the run is what actually matters: two
// days sharing a name are Succos I and Succos II, while Shemini Atzeres and
// Simchas Torah are consecutive Yom Tov days with DIFFERENT names and are not
// numbered at all — naming them is already the distinction.
function yomTovDay(day) {
  const jc = new JewishDay(day).jc;
  const name = fmtEng.formatYomTov(jc);
  if (!name || !jc.isAssurBemelacha()) return '';
  const sameFestival = (d) => {
    const other = new JewishDay(d).jc;
    return other.isAssurBemelacha() && fmtEng.formatYomTov(other) === name;
  };
  let index = 1;
  for (let i = 1; i < 4 && sameFestival(addDays(day, -i)); i += 1) index += 1;
  let total = index;
  for (let i = 1; i < 4 && sameFestival(addDays(day, i)); i += 1) total += 1;
  return total > 1 ? (['', 'I', 'II', 'III'][index] ?? '') : '';
}

// What to call a day on a card.
//
// Today and Tomorrow by their relation to now; anything further out by name,
// and Saturday is Shabbos because that is what it is called by everyone who
// will read this. A Yom Tov day carries the festival with it, numbered when the
// festival runs more than one day — the point of reaching three days ahead is
// lost if all three say only "Succos".
function dayName(now, at) {
  const a = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const b = new Date(at.getFullYear(), at.getMonth(), at.getDate());
  const diff = Math.round((b - a) / 86400000);
  const base = diff <= 0 ? 'Today'
    : diff === 1 ? 'Tomorrow'
      : at.getDay() === 6 ? 'Shabbos'
        : at.toLocaleDateString('en-US', { weekday: 'long' });

  // Only on days melacha is actually forbidden. formatYomTov also names Erev
  // Succos, Hoshana Rabbah, Isru Chag and every day of Chol Hamoed, and
  // hanging all of those off a heading buys length rather than meaning — the
  // tile already says what today is. What this is FOR is telling consecutive
  // days of rest apart, which is exactly the set it now covers.
  const jc = new JewishDay(at).jc;
  const festival = jc.isAssurBemelacha() ? fmtEng.formatYomTov(jc) : '';
  const numeral = festival ? yomTovDay(at) : '';
  const named = festival ? `${festival}${numeral ? ` ${numeral}` : ''}` : '';
  // "Shabbos · Shabbos" helps nobody.
  const label = named && named !== base ? `${base} · ${named}` : base;
  return { label, cls: diff <= 0 ? 'today' : 'tomorrow' };
}
