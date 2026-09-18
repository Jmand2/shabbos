# Shabbos Clock

Wall display for the mounted iPad in Teaneck. Big clock, zmanim, and minyan times
for whichever Teaneck shuls you pick.

## How it gets its numbers

Two separate things, on purpose.

**Calculated on the iPad** — Hebrew date, parsha, Yom Tov, candle lighting,
havdalah, and every zman. `vendor/kosher-zmanim.min.js` does this from Teaneck's
coordinates. It needs no network and never goes out of date, so there is nothing
to update each year.

**Pulled from real schedules** — minyan times. A GitHub Action fetches them from
teaneckminyanim.com and writes `data/minyanim.json`. The iPad only reads that
file. Nothing derives a minyan time from sunset or from last week's schedule. If
a day was not confirmed, the shul shows "Times unavailable" instead of a number.

## Holidays

Every Yom Tov is calculated, not listed, so there is no year to keep up to date.
Two-day Yom Tov, Chol HaMoed, Hoshana Rabbah, the fasts and Chanukah all name
themselves in the header, and the screen locks for Yom Tov exactly as it does for
Shabbos.

The line under the clock knows which transition is coming:

| Moment | Line |
| --- | --- |
| Erev Rosh Hashana | Candle lighting 6:53p |
| Rosh Hashana day 1 | Candle lighting **after** 7:51p |
| Rosh Hashana day 2 | Havdalah 7:49p |
| Yom Tov running into Shabbos | Candle lighting, at the usual time |

Minyan times on Yom Tov come from the same pull as any other day, and the scraper
reaches four days out so a three-day Yom Tov is covered even if a run is missed.
If a Yom Tov schedule was never confirmed, the shul says so rather than falling
back on its ordinary Shabbos times.

## Deploying it

### On your laptop

**1. Look at it before anything else.** A `file://` page cannot load `data/` or
register the service worker, so serve it:

```
cd shabbos-clock
python3 -m http.server 8000      # then open http://localhost:8000
```

**2. Run the scraper against the live site.** This is the step that matters most,
because it answers the one open question and fills `data/minyanim.json` before
you ever push:

```
node scripts/fetch-minyanim.mjs
```

Good result:

```
fetched 8 schedule(s); 4 day(s) on file: 2026-09-01, 2026-09-02, ...
```

If instead it says **"Only today could be verified"**, the date template is
wrong. Open a shul page on teaneckminyanim.com, click the arrow to tomorrow, and
see how the URL changes. Correct this one line in
`scripts/fetch-minyanim.mjs`:

```js
const DATE_URL = 'https://teaneckminyanim.com/org/{slug}?date={date}';
```

Then run it again. Every page is checked against the day it actually printed, so
a wrong template can never write wrong times — it just means Friday night cannot
show Shabbos morning.

**3. Reload localhost.** Real times should now be on the board. Compare a couple
against the shul's own site before trusting it.

**4. Run the checks.**

```
npm i --no-save jsdom
TZ=America/New_York node scripts/check.mjs
```

**5. Push to a new public repo.** Public matters: Pages on a private repo needs a
paid plan, and Actions minutes are unlimited on public ones.

```
git init && git add -A
git commit -m "Shabbos clock"
git branch -M main
git remote add origin git@github.com:YOU/shabbos-clock.git
git push -u origin main
```

**6. Three settings on GitHub, in this order.**

| Where | Set to |
| --- | --- |
| Settings → Actions → General → Workflow permissions | **Read and write** |
| Settings → Pages → Source | Deploy from a branch, `main`, `/ (root)` |
| Actions → Refresh minyan times → Run workflow | run it once |

Read and write has to be set *before* the first run, or the job cannot push.

**7. Open the Pages URL on your laptop.** Usually
`https://YOU.github.io/shabbos-clock/`. Give it a minute after the first push.
The footer should read "Times from teaneckminyanim.com" — if it says "Times last
confirmed", the Action has not landed yet.

### On the iPad

**1. Auto-Lock off first.** Settings → Display & Brightness → Auto-Lock →
**Never**. Do this before mounting it back on the wall.

**2. Open the Pages URL in Safari.** It must be Safari. From any other browser
the icon opens with a URL bar instead of full screen.

**3. Share → Add to Home Screen.** Name it "Shabbos".

**4. Launch it from the icon**, with wifi on. That first launch caches
everything, and from then on it survives the wifi dropping.

**5. Set it up:** tap Settings and choose the shuls, layout, theme, clock size
and how many times per shul. Stand where your parents will actually stand and
check the times are big enough from there.

**6. Drag the icon into the Dock.** The Dock is on every home screen, so it is
one tap from the camera app and one tap back.

**7. Back on the charger.**

Don't use Guided Access. It looks right for a wall iPad, but it would trap them
in the app with no way back to the cameras.

### Checking it took

- Footer reads "Times from teaneckminyanim.com"
- Times match the shuls' own sites
- Screen goes dark-themed after sunset
- On Friday after candle lighting, Settings disappears and taps do nothing

## Your parents' part

Tap the Shabbos icon. Tap the camera app to go back.

Nothing to install, no time to enter, nothing that expires. It turns to night
colours after dark, locks itself when Shabbos or Yom Tov starts so a stray hand
cannot change it, unlocks after havdalah, and reloads itself at 3am to pick up
anything you push.

## Settings

Tap **Settings** on the display (it is hidden on Shabbos and Yom Tov). Choices are
saved on the iPad.

| | |
| --- | --- |
| Shuls | any of the 23 Teaneck shuls |
| Layout | Full board, or Clock only |
| Times shown per shul | next 4, 8 or 12 |
| Theme | night after dark, always night, always day |
| Accent | brass, copper, sage, ice, purple |
| Clock face | sturdy, classic, elegant, clean |
| Clock size | smaller, standard, larger |
| Also | seconds, the day horizon, an extra zmanim strip |

There is no bar across the top. The clock owns the upper band, with two tiles
in the space either side of the numerals: the Hebrew date, the parsha and the
next candle lighting or havdalah on the left; the civil date and netz, shkiya
and tzeis on the right. The tiles are a fixed width and the clock is capped to
guarantee they fit, so nothing resizes as the time goes from 9:59 to 10:00.

Shkiya and tzeis live there because the horizon is off by default and they had
nowhere else to appear.

Cards fill the board, and the type inside them is **fitted to the box in both
directions**. The line count is only a first guess; the display then measures
and binary-searches for the largest size at which the fullest card still fits.
On a quiet evening that means very large times, on a busy Friday smaller ones,
and the card is always full either way.

That is the rule the whole layout follows: spare room is spent on type size,
not on gaps. On a wall read from across a room, empty panel is wasted
legibility. Nothing is allowed to hoard leftover space — the clock band is
sized by its contents and everything else goes to the board.

Purple is more than an accent: it tints the ground and the panels too.

**Full board** is the clock and the shul cards, plus the horizon if you switch
it on. **Clock only** drops
everything but the time and the next candle lighting or havdalah, and makes the
clock roughly three times larger — for reading across a room.

**The horizon** is off out of the box; switch it on under Settings. It is the
solar day: alos on the left, tzeis on the right, the sun at now, and five
zmanim marked with their times — netz and shkiya above the line, alos, chatzos
and tzeis below it. It carries no minyan times. It used to,
as unlabelled ticks, but two shuls davening at the same minute landed on the
same pixel and the one tick that did get a label was clipped off the edge
whenever it fell near dawn. The cards say it better.

Past tzeis the strip moves on to tomorrow's day, drops the sun and empties the
bar, and its left end reads "Tomorrow · Alos".

Only minyanim that are still ahead are listed, so the screen thins out as the day
goes on rather than filling with times that have passed. The next one at each shul
is in the accent colour. A tefillah listed more than once in a day — Night
Selichos at 5:00am and again at 9:45pm — gets a row at each end rather than one
row spanning both, so a card always reads top to bottom in the order things
happen. Everything is sized so that even the largest setting fits a 768px-tall
iPad without scrolling.

Pick more than three shuls and the display pages through them every 45 seconds.

## Family flights

Every few minutes a vehicle crosses the screen carrying family faces — a train
with four, a plane with three, a balloon, a parachute, a rocket. It runs during
Shabbos, which is the point: that is when the grandchildren are there.

The photos live in this repo **encrypted**. `faces-src/` holds the plaintext
crops and is gitignored; it must stay that way, because git history is
permanent and one careless `git add -A` undoes the whole point.

To set it up, choose a passphrase and run it yourself:

```
node scripts/encrypt-faces.mjs "four or more random words"
```

That writes `faces/<random-id>.bin` (AES-GCM-256, key from PBKDF2-SHA256 at
600,000 iterations) and `faces/manifest.json`, which carries the salt, the
random ids and the ring colours and **no names**. Commit `faces/`. Then on the
iPad: Settings → Family flights → passphrase → Unlock. Only the derived key is
kept, non-extractable, in IndexedDB; the passphrase itself is never stored.

The script refuses anything under 16 characters, and it should: **this repo is
public, so the ciphertext is public too.** Its whole security is the strength of
that passphrase, and there is no way to unpublish bytes that have already been
pushed. If the passphrase is lost the photos are gone with it.

`robots.txt` is in the repo, but note that it does nothing here: robots.txt is
only honoured at the origin root, and this is served under `/shabbos/`. It would
take effect on a custom domain, or from a `jmand2.github.io` user-site repo.

With no `faces/` committed or no passphrase entered, nothing flies and nothing
breaks — the module does nothing at all.

| | |
| --- | --- |
| Something crosses | Off / twice every 5 min / 5 / 10 / 20 min / hour |

The gap between flights is jittered — drawn between half and one and a half
times the setting — so two flights in five minutes still arrive at
unpredictable moments rather than on a metronome.

Two things make it possible to tell whether it is working without waiting:
the settings sheet says either "20 photos ready on this iPad" or "Locked",
and **Send one** launches a flight immediately. One also flies the moment a
passphrase is accepted.

The clock is never covered: the flight layer takes no taps, affects no layout,
and the outer lanes pick a side.

## Cost

Nothing recurring. GitHub Pages and Actions are free on a **public** repo, the
times come from a free site, and the calendar library is committed here rather
than called as a service. Keep the repo public: Pages on a private repo needs a
paid plan.

One thing to know. GitHub silently switches off scheduled workflows in a public
repo after 60 days with no activity. The refresh commits new times most days,
which keeps the clock alive on its own. If it ever does stop, the display tells
you: the footer changes to "Times last confirmed [date]" and the shuls fall back
to "Times unavailable". One click on Run workflow starts it again.

## Shabbos behaviour

From candle lighting (or Yom Tov onset) until tzeis, the screen locks: Settings is
hidden and taps do nothing, so nobody changes anything by leaning on it. It comes
back on its own after havdalah. The lock uses the same calculation as the display,
so it also covers two-day Yom Tov and a Yom Tov that runs into Shabbos.

## Checking a change

```
npm i --no-save jsdom
TZ=America/New_York node scripts/check.mjs
```

Four things: what the screen shows across thirteen Shabbos and Yom Tov moments
including whether the lock is on; that the clock still renders with the data
files unreachable, the wake lock unsupported, no shuls chosen, or stored settings
corrupt; that the scraper reads a page correctly and refuses to treat a sunset
line as a minyan; and that all 365 days of the coming year render without a throw
or a NaN.
