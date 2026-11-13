# Front-line weather (`scripts/weather/`)

The weather at each active General Staff direction, and what it implies for
drone and ground operations. It exists in two forms:

- **The ingest** (`ingest.py`): runs hourly in CI and builds `weather.db`,
  from which comes `weather.app.db` for the **weather strips** on the hourly
  and daily pages (opt-in, under Show more).
- **The CLI report** (`report.py`): prints the same data as a table, fetched
  live, for any day since 2022.

```sh
# Ingest (CI runs the first; the second seeds or repairs history)
python3 scripts/weather/ingest.py                          # → data/weather.db
python3 scripts/weather/ingest.py --backfill-from 2025-10-26
python3 scripts/build_app_db.py --in data/weather.db --out data/weather.app.db \
  --sql scripts/weather/app_db.sql                         # what the app reads

# CLI report
python3 scripts/weather/report.py                          # today + tomorrow, all sectors
python3 scripts/weather/report.py --days 4
python3 scripts/weather/report.py --date yesterday --days 1   # or --date -2, or YYYY-MM-DD
python3 scripts/weather/report.py --past 3                 # last 3 days + today + tomorrow
python3 scripts/weather/report.py --date 2025-11-20 --days 3  # any day since 2022
python3 scripts/weather/report.py --sector Pokrovsk --hourly
python3 scripts/weather/report.py --json
python3 scripts/weather/report.py --save raw.json          # keep the response…
python3 scripts/weather/report.py --input raw.json         # …re-render it offline
```

Stdlib only, no key. One HTTP request covers every sector, because Open-Meteo
takes comma-separated coordinates. Its free tier is non-commercial, allows
10,000 calls a day and requires attribution, which the strips carry. A run
costs about 15 of those calls.

## Where the numbers come from

**Model output, never station observations.** Stations near the front are
destroyed or occupied, and Ukraine withholds its own under martial law.
Open-Meteo's best-match mix covers Ukraine with ECMWF IFS, ICON-EU (~7 km) and
GFS.

| Range | Endpoint | What "past" means |
|---|---|---|
| last ~90 days → +15 days | `api.open-meteo.com/v1/forecast` | hours before now are a **hindcast** from the latest short-range runs; the rest is forecast |
| 2022 → ~3 months ago | `historical-forecast-api.open-meteo.com` | the same models' runs, stitched into an archive |

An hour's value is first a forecast, then a hindcast that later runs refine.
The Oct 11 fog's end moved from 10:00 to 11:00 between two runs. After a day
or two it stops changing. Fog and visibility are what the models get
**worst**, followed by where summer showers fall. Wind, temperature and frontal
rain are the most reliable.

A **429** ("Daily API request limit exceeded") from a shared IP, such as a
cloud session or a CI runner, has so far always been a short-term limit: a
retry about 30 s later has worked every time. `openmeteo.py` retries after
30, 60 and 120 s, and also retries 5xx responses and dropped connections.

## What is stored (`schema.sql`)

Only the weather is stored. The ratings are derived in code (below), so a
change to a rule never needs a migration. Times are Kyiv local, the clock the
SBS hours run on.

| Table | Holds | Written |
|---|---|---|
| `hourly` | one row per sector and past hour | overwritten by every run until the hour is **48 h old**, then `settled` and never written again |
| `forecast` | the hours still ahead | replaced whole by every run |
| `forecast_snapshot` | what was forecast **in advance**: the first run at or after 06:00 Kyiv each day, for that day and the next | once a day, kept for good |
| `sectors`, `runs` | the points as placed; one row per run | every run |

`hourly` is a deliberate exception to the repo's append-only rule. Keeping
every run's version of every hour would add about 25,000 rows a day of
superseded estimates. What is worth keeping from the forecasts is what they
said beforehand, and `forecast_snapshot` keeps exactly that. It is what lets
"fog was forecast: did SBS still drop?" be asked later. It **can't be
backfilled**: Open-Meteo's archive of past runs has no visibility, so the
record starts the day the ingest went live.

**A live run** reads from three days back to the end of tomorrow. Each hour
therefore gets its last writes before it settles. When a missed run has left
a gap, it reads back as far as the last stored hour, within the live
endpoint's ~90 days. A longer gap needs a `backfill_from` dispatch, and the
run says so in its annotations.

**The backfill** (`--backfill-from`) reads the archive in month-sized
requests, up to three days ago, and every row it writes is already settled.
History starts at **2025-10-26**, the first day of the SBS hourly data. That
year took about 2 minutes and 110k rows. Going further back means placing the
sectors **by date**, because today's points sat far from the 2022 front (see
Sectors).

**The app copy** (`app_db.sql`, built by `build_app_db.py` in the same job)
keeps one compact table:
- only the seven fields the drone rating reads,
- the values as scaled integers,
- past hours and the current forecast together, with the forecast hours
  flagged.

It is **3.6 MB for the first year**, against 13.8 MB for the authoritative DB.
The snapshots stay out of it.

## The ratings

The thresholds live in **`src/data/weatherRules.json`**, shared by `assess.py`
(the CLI) and `src/utils/weatherRating.ts` (the app). The reasoning behind each
number is in `assess.py`. `src/data/weatherRatingCases.json` pins the hourly
drone rule exactly, reasons and their order included, and both pytest and
vitest run it. A rule changed on one side only fails a test. They are rules of
thumb and deliberately easy to change.

- **Drones** (CLI `DRONES`, the strip's cells): small multirotor, FPV and
  light fixed-wing UAVs, judged hour by hour.
  - **One scale for hours and days: `ok` / `limited` / `severe`.** Each hour
    is graded on wind and gusts, rain, snow, fog or mist, thunderstorms, icing
    and deep cold.
  - Icing needs liquid water: near-freezing drizzle, rain or fog, not dry
    snow.
  - A day takes the same three words from counting its hours: **severe**
    with ≥6 severe hours, **limited** with ≥6 hours limited or worse, **ok**
    otherwise. The CLI prints them as OK / LIMITED / SEVERE.
  - Larger fixed-wing UAVs (Orlan, Lancet, long-range one-way drones) tolerate
    more of all of this.
- **Ground** (CLI only): off-road going plus troop exposure, judged per day.
  - Going is `firm`, `soft`, `mud`, `frozen` or `deep snow`. It is read from
    model soil moisture (3–9 cm), with **WET72** (rain over the 72 h ending
    with the day) as a fallback and an escalator.
  - Exposure (`cold`, `extreme cold`, `heat`) is read from apparent
    temperature.
- **Drone-denied windows**: runs of severe hours (≥2 h, bridging 1-h lulls).
  This is the interaction that matters at today's front: weather that grounds
  drones is weather in which infantry can move with less observation. A
  bad-weather day may therefore be a *busier* one on the ground.
- **`*` (CLI bad-weather day)**: a severe drone day, or mud, or extreme cold.

## The strips

The **hourly** page (SBS) and **every daily page** can show a card above the
charts. It's off by default, behind **Show more → Front-line weather**, and
remembered per reader (`useWeatherStripPref`, localStorage). While it's off the
strip isn't mounted, so `weather.app.db` (~4 MB) is never fetched.

- **Hourly** (`WeatherStripHourly`): the viewed day, which is the picked end
  date or today. One row per direction, 24 hour cells coloured by how limited
  small drones were (ok / limited / severe). Forecast hours are faded. The
  last column is each direction's rating for the day as a whole.
- **Daily** (`WeatherStripDaily`): the page's window, one column per day.
  Each cell is that direction's day rating on the same scale, and a day with
  forecast hours in it is faded. The last column is the direction's severe
  days out of the window's days, e.g. `4/30`.
- **The count row** above the grid (`Σ severe` on both) says, per column, how
  many directions were severe for drones in that hour, or had a severe day. It's the line to read against the charts below: "how much of the
  front could fly".
- **Tooltip and sheet:** the charts' own. Hovering a cell (mouse or pen)
  shows the floating card for that one direction, measured and placed where
  it fits rather than squeezed against the viewport's edge. Clicking pins the column
  and opens the sheet with every direction, and the sheet's stepper walks the
  hours or the days. On a daily page whose site has an hourly view, the sheet
  links to that day "By hour".

Code: `components/WeatherStrip.tsx` (one grid, two wrappers), the models in
`utils/weatherStrip.ts`, the tooltip and sheet wording in
`utils/weatherDescriptors.ts`. Both utils are unit-tested.
`e2e/weather-strip.spec.ts` checks the toggle (including no download while
off), both strips, the hover card, the sheet and the daily → hourly link.

## Sectors

`sectors.py` has one point per direction that still carried attacks in the
reports of 2026-09/10. Each point sits on the contact line, not on the town
the direction is named after. `Kursk` and `N-Slobozhanshchyna` share a point,
because the General Staff reports them as one line (see `DIRECTION_AXIS` in
`src/types/index.ts`).

When the front moves, re-place the points, and re-check the list against
`gsua_direction_monthly` in `ru-attacks-gsua.app.db`. At model resolution a
point that is 10 km off still samples the same weather. A re-placed point
updates its `sectors` row in place, and its history stays as fetched for the
old point. That is fine for a few kilometres. A direction that **moves** to a
different place, or a backfill into 2022–24, needs points with dates instead.

## Tests

`bash scripts/test_python.sh scripts/weather`. No network calls.
- **`test_ingest.py`:** settling, the forecast/hourly split, the snapshot,
  gap closing, the backfill chunks and the client's retries, against a fake
  fetch.
- **`test_report.py`:** the shared rating cases, the ground rules and the
  CLI, with synthetic payloads in Open-Meteo's column-wise shape. One case
  replays `fixtures/live-2026-10-10.json`, a real `--save` taken at 19:05 Kyiv
  on 2026-10-10, covering that day and the next day's forecast. Every
  requested field came back filled there, and from the historical archive too
  (checked against 2025-01-20). The fixture pins that, plus the response
  shape.

The app side: `npm test` (`src/utils/weatherRating.test.ts`,
`weatherStrip.test.ts`) and `e2e/weather-strip.spec.ts`. The e2e fixture is
built like CI builds the app copy: `schema.sql`, then `app_db.sql`.
