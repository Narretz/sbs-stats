# Front-line weather report (`scripts/weather/`)

A CLI, not a dataset (yet): it prints the weather at each active General Staff
direction and what it implies for drone and ground operations. It's the trial
run for a possible weather view: it settles which numbers are worth keeping
before anything is stored.

```sh
python3 scripts/weather/report.py                        # today + tomorrow, all sectors
python3 scripts/weather/report.py --days 4
python3 scripts/weather/report.py --date 2025-11-20 --days 3   # any day since 2022
python3 scripts/weather/report.py --sector Pokrovsk --hourly
python3 scripts/weather/report.py --json
python3 scripts/weather/report.py --save raw.json        # keep the response…
python3 scripts/weather/report.py --input raw.json       # …re-render it offline
```

Stdlib only. One HTTP request covers every sector, because Open-Meteo takes
comma-separated coordinates. Its free tier is non-commercial and allows 10,000
calls a day.

## Where the numbers come from

**Model output, never station observations.** Stations near the front are
destroyed or occupied, and Ukraine withholds its own under martial law.
Open-Meteo's best-match mix covers Ukraine with ECMWF IFS, ICON-EU (~7 km) and
GFS.

| Range | Endpoint | What "past" means |
|---|---|---|
| last ~90 days → +15 days | `api.open-meteo.com/v1/forecast` | hours before now are a **hindcast** from the latest short-range runs; the rest is forecast |
| 2022 → ~3 months ago | `historical-forecast-api.open-meteo.com` | the same models' runs, stitched into an archive |

Each day's header states the split (`00–14h hindcast · 14–24h forecast`).
Fog and visibility are what the models get **worst**, followed by where summer
showers fall. Wind, temperature and frontal rain are the most reliable.

## What the columns mean

The thresholds are constants at the top of `assess.py`, with the reasoning for
each. They are rules of thumb and deliberately easy to change.

- **DRONES**: small multirotor, FPV and light fixed-wing UAVs, judged hour by
  hour.
  - Each hour is graded `ok`, `degraded` or `severe` on wind and gusts, rain,
    snow, fog or mist, thunderstorms, icing and deep cold.
  - The day is **POOR** with ≥6 severe hours, **MARGINAL** with ≥6 hours that
    are degraded or worse, and **GOOD** otherwise.
  - Larger fixed-wing UAVs (Orlan, Lancet, long-range one-way drones) tolerate
    more of all of this.
- **GROUND**: off-road going plus troop exposure, judged per day.
  - Going is `firm`, `soft`, `mud`, `frozen` or `deep snow`. It is read from
    model soil moisture (3–9 cm), with **WET72** (rain over the 72 h ending
    with the day) as a fallback and an escalator.
  - Exposure (`cold`, `extreme cold`, `heat`) is read from apparent
    temperature.
- **Drone-denied windows**: runs of severe hours (≥2 h, bridging 1-h lulls).
  This is the interaction that matters at today's front: weather that grounds
  drones is weather in which infantry can move with less observation. A
  bad-weather day may therefore be a *busier* one on the ground.
- **`*` (bad-weather day)**: drones POOR, or mud, or extreme cold. Each day's
  header counts these days across the front.

## Sectors

`sectors.py` has one point per direction that still carried attacks in the
reports of 2026-09/10. Each point sits on the contact line, not on the town
the direction is named after. `Kursk` and `N-Slobozhanshchyna` share a point,
because the General Staff reports them as one line (see `DIRECTION_AXIS` in
`src/types/index.ts`).

When the front moves, re-place the points, and re-check the list against
`gsua_direction_monthly` in `ru-attacks-gsua.app.db`. At model resolution a
point that is 10 km off still samples the same weather.

## Tests

`bash scripts/test_python.sh scripts/weather`. The tests use synthetic
payloads in Open-Meteo's column-wise shape and make no network calls.
