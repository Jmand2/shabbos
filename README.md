# Shabbos Clock

Wall display for the mounted iPad in Teaneck. Big clock, zmanim, the hourly
weather for Shabbos, and minyan times for whichever Teaneck shuls you pick.

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

**Fetched live** — the weather, from open-meteo.com, every twenty minutes. No key
and no account; it is the only request the display makes off its own origin. The
last forecast is kept on the iPad, so a wifi drop shows an hour-old sky rather
than an empty band, and a forecast that never arrives hides the strip instead of
leaving a hole.

## Holidays

Every Yom Tov is calculated, not listed, so there is no year to keep up to date.
Two-day Yom Tov, Chol HaMoed, Hoshana Rabbah, the fasts and Chanukah all name
themselves in the header, and the screen locks for Yom Tov exactly as it does for
Shabbos.

The tile beside the clock carries both ends of the rest period — when it comes
in is half the question, when it goes out is the other half:

| Moment | Tile |
| --- | --- |
| Erev Rosh Hashana | Candles 6:53p, then havdalah |
| Rosh Hashana day 1 | Candles **after** 7:51p, then havdalah |
| Rosh Hashana day 2 | Havdalah 7:49p |
| Yom Tov running into Shabbos | Candles, at the usual time |

Candle lighting is town-wide, but havdalah is a practice, not a fact: a shul that
holds by a fixed number of minutes after its own maariv gets a
`havdalahAfterMaariv` in `data/shuls.json`, and the tile reads that shul's maariv
off the same schedule the cards use. When the shuls on screen disagree — they
usually do, by a few minutes — each is named. A shul with no entry is left out
rather than handed someone else's minhag; if none of the shuls on screen has one,
the tile falls back to computed tzeis, unnamed.

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
| Temperature | Fahrenheit or Celsius |
| Also | seconds, the day horizon, an extra zmanim strip, the weather |

There is no bar across the top. One tile on the left carries the dates — civil
date, Hebrew date, parsha, the next candle lighting or havdalah, then netz,
shkiya and tzeis — and the clock takes everything to its right.

It used to be two tiles, one either side of the numerals. That cost the clock
more than it looked: the numerals are centred, so the WIDER of the two tiles set
the clock's width budget on both sides at once, and the clock paid for the zmanim
tile twice. One tile is paid for once, which is most of where the larger numerals
came from.

The tile is a fixed width, so nothing resizes as the time goes from 9:59 to
10:00. The clock is sized against its own container rather than against the
viewport (`cqi`, not `vw`), so the tile can change width without anybody
re-deriving a cap for it — which is what the old three-line stack of media
queries was doing.

Shkiya and tzeis live there because the horizon is off by default and they had
nowhere else to appear. Each is named in Hebrew and then by what it is for —
`נץ החמה | Earliest Shacharis`, `שקיעה | Sunset`, `צאת הכוכבים | Nightfall` —
because "Netz" on its own assumes you already know. Turning on the zmanim strip
adds sof zman shema, mincha gedola and plag.

Name and time share a line, the time flush right.

What gets centred is the whole clock — numerals, meridiem and dial together —
not the numerals alone. Centring the numerals meant carrying a matching empty
gutter on their left to balance the suffix on their right, and that dead half
was the single thing holding the clock size down.

Those English glosses are the common luach convention, not a psak. Netz is
labelled earliest shacharis in the sense of the amidah at vasikin; if your
practice labels them differently they are one line each in `renderZmanim`.

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

## The weather

A strip under the clock: what it is doing now on the left, and the hours ahead
across the rest. It is keyed to the rest period rather than to the calendar day,
because the question it answers is "do we need coats when we walk back", and the
walking lasts as long as Shabbos does.

- **In or approaching a rest period** the strip is captioned with it by name —
  Shabbos, or the Yom Tov, so a three-day chag says Succos rather than Shabbos —
  and with the havdalah it runs to. The columns are clipped to that end, so the
  strip never shows hours past the time it is captioned with.
- **On an ordinary day** it says "Next 12 hours" and does not invent an occasion.
- **When a period is nearly over** — under six hours left — clipping honestly
  would leave two columns under a heading promising a day. There it opens back up
  to the plain twelve hours and drops the claim in the same breath. Havdalah is
  not lost; it is on the tile, which is where it belongs.

A three-day Yom Tov is 72 hours and will not fit one strip, so the window rolls
forward with the hour instead: always the next twelve, whichever day of the chag
it is. That is also why the code does not special-case long spans — a Tuesday and
the second day of Succos take the same path.

Each column carries the hour, a sky glyph, and the temperature. A chance of rain
is printed only above 25% — a 10% under every column trains the eye to skip the
row on the day it matters.

The glyphs are drawn here rather than pulled from an icon set: overlapping discs
and a rounded bar for the cloud, two circles differenced for the moon. All ten
are built in the same 24×24 grid and centred in it, so a row of twelve sits on a
common line rather than the sun riding high over the clouds. The cloud's
transparency is on the group, not on each disc — fade them individually and every
overlap becomes a darker patch, which reads as three humps rather than one cloud.
After dark a clear sky is a moon, not a sun; `is_day` comes back per hour, so
every column knows which it is.

Open-Meteo is free under CC-BY, which asks for attribution — that is the
"weather from open-meteo.com" in the footer, and why it is there.

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

### Adding a face later

```
node scripts/encrypt-faces.mjs --add "the same passphrase" trump.jpg
```

Use `--add`, not a second plain run. A plain run mints a **new random salt**, so
the same passphrase derives a **different key**: every existing `.bin` is
rewritten and the key sitting in the iPad's IndexedDB quietly stops working, and
somebody has to walk over and enter the passphrase again. `--add` reuses the
stored salt and iteration count, touches none of the files already committed, and
carries on round the ring so the new face does not land on the colour of the one
before it.

It probes an existing file with the derived key before it writes anything. A
wrong passphrase there would otherwise append a face that decrypts to nothing on
a display that looks like it is working fine — and the only symptom would be a
face that never appears.

Crops are 240px square, head centred, padded so hair and chin survive the
circular mask — a square whose inscribed circle still contains the whole head,
since the mask throws the corners away.

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
| Something crosses | Off / every 2–5, 5–10, 10–20, 20–40 or 45–90 min |

Each setting is a **range**, and the gap is drawn uniformly inside it and
redrawn after every flight, so the next one is never predictable from the last.
Ranges rather than single numbers because that is what actually happens: once
the gap became random, a label saying "every 10 minutes" was describing
something the display had never done.

Two things make it possible to tell whether it is working without waiting:
the settings sheet says either "20 photos ready on this iPad" or "Locked",
and **Send one** launches a flight immediately. One also flies the moment a
passphrase is accepted.

Each vehicle carries its own size on top of that. A flat scale left the long
ones — plane, train — 2.3x the width of a parachute or a car, so the compact
ones read as afterthoughts; lifting the small ones brings the spread down to
about 1.5x.

Faces are drawn at about three times their seat, deliberately spilling over the
vehicle around them — the face is the point and the vehicle is the frame. The
only thing that still bounds a face is the next face along: it never grows past
about six tenths of the gap to the neighbouring seat, or a full train would be
one smear.

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

## Why the cards got smaller

They were as tall as the screen allowed rather than as tall as they had anything
to say, so a shul with two minyanim left got the same slab as one with twelve.
The cards now stop at a height their contents can justify, the weather takes a
band off what is left, and the slack settles around the clock instead of being
spent on empty panel.

Past that cap the fit loop shrinks the type rather than clipping it, which is the
right thing to give up on a busy Friday.

One ordering note, because it is easy to undo: whatever claims a band has to be
painted BEFORE the cards. `renderShuls` ends by measuring the cell it was given,
so anything inserted after it has already been measured around — with the strip
painted last, the first frame sized the type against a board that was about to
lose a band to the weather.

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

There is a second suite for the behaviour a single frozen frame cannot show —
the board repainting twice a minute, the horizon rolling over at nightfall, and
the weather strip's choice of window:

```
TZ=America/New_York node scripts/check-ui.mjs
```

It seeds a synthetic forecast rather than calling out to the network, and reads
minyan times from `scripts/fixtures/minyanim.json` rather than from
`data/minyanim.json`. Both for the same reason: assertions should be about the
code, not about the sky over Teaneck or the schedule the scraper happened to
pull this morning. `data/minyanim.json` is rewritten three times a day and
trimmed to a few days either side of today, so tests pointed at it rot on their
own — the dates stay in range while the times under them change.

To refresh the fixture deliberately, copy the live file over it and then
re-check every asserted time, because that is the moment they can legitimately
change. `data/shuls.json` is deliberately NOT frozen: it is configuration, and a
change to it should be caught by these tests rather than hidden from them.

`check.mjs` covers four things: what the screen shows across thirteen Shabbos and Yom Tov moments
including whether the lock is on; that the clock still renders with the data
files unreachable, the wake lock unsupported, no shuls chosen, or stored settings
corrupt; that the scraper reads a page correctly and refuses to treat a sunset
line as a minyan; and that all 365 days of the coming year render without a throw
or a NaN.
