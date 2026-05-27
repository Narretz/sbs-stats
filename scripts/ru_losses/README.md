# RU losses scraper — Ukrainian General Staff national totals

Builds **`ru-losses-gsua-petroivaniuk.db`** from
[PetroIvaniuk/2022-Ukraine-Russia-War-Dataset](https://github.com/PetroIvaniuk/2022-Ukraine-Russia-War-Dataset) —
the **RU LOSSES — GSUA** view of the app. That repo is the de-facto
machine-readable mirror of the Ukrainian General Staff's daily national loss
totals (personnel, tanks, aircraft, UAVs, …) — the figures behind the GS's daily
infographic.

**stdlib only** (`urllib` + `sqlite3` + `json`), no extra dependencies. There is
no REST API: we fetch two raw JSON files —
`data/russia_losses_equipment.json` + `data/russia_losses_personnel.json`.

## Why we switched from russian-casualties.in.ua

- **It carries the new category.** The General Staff started reporting **unmanned
  ground systems**; PetroIvaniuk exposes it as `ground robotic systems` (our
  `ugs` column, cumulative from 2026-05-03). The old source never added it.
- **Durability.** A named, MIT-licensed, daily-pushed repo with four years of git
  history that CSIS/ISW build on — vs an anonymous site with no contact and no
  CDN caching. It's also a strict superset of the columns we tracked.

## Cumulative → daily

Unlike russian-casualties.in.ua (already per-day), PetroIvaniuk is **cumulative
war-to-date totals**, one record per day, so a per-day figure is the **diff of
consecutive days**. Two things fall out of that:

- **Corrections are already baked into the cumulative series** (the totals
  physically *decrease* on the GS's correction dates), so we just diff and let
  them pass through as that day's value. The repo's
  `russia_losses_equipment_correction.json` is **documentary only — we never
  apply it** (doing so would double-count).
- A category **backfilled mid-war** (UGS arrived with a war-to-date value, as did
  the consolidated `vehicles and fuel tanks` on 2022-05-01) gets `daily = NULL`
  on its first day — a backfill can't be attributed to a single day.

## Date model

PetroIvaniuk labels each record by the GS **report** day; the increment is losses
from the day before. We store two dates:

- **`date`** = the loss day (report day − 1) — "the date the data is for", which
  also matches how the previous source keyed it (verified: PetroIvaniuk
  report-day `D` equals the old source's loss-day `D−1` on 1517/1552 days).
- **`reported_at`** = the GS report/publication day (PetroIvaniuk's native date).

## How it works

- **Snapshot-only**: the frontend never calls the source. This script runs in CI
  (and locally), writes a tiny SQLite file, and that file is uploaded to R2. The
  frontend fetches the whole DB via sql.js (`useDatabaseRuLosses`).
- **Append-only / versioned**, like the gsua `posts` table. `daily_losses` is
  keyed by `(date, scraped_at)`. Each run compares fetched values to the latest
  stored version per date and inserts a **new row only when they differ** (or the
  date is new). Nothing is ever overwritten, so a later correction is captured as
  a fresh row that wins by having a newer `scraped_at`; a bad value can't clobber
  good stored data. The frontend reads the latest snapshot per date.
- **Source-drift guard** (`check_drift`): warns (and emits a GitHub Actions
  annotation in CI) if the source exposes a key we don't map or explicitly
  ignore — so the next new category can't slip in silently and quietly change the
  meaning of an existing column. This is how the GS would re-introduce, say, a
  separate naval-drone line.
- **Build guards** abort without writing (so the R2 upload is skipped and R2 is
  left untouched) if the fetch looks broken:
  1. fewer than 365 days parsed (absolute floor — the war started 2022-02-24);
  2. fewer distinct dates than already stored (refuse a shrinking dataset).

## DB output

Writes **`output/ru-losses-gsua-petroivaniuk.db`** (override with
`RU_LOSSES_DB_NAME` / `RU_LOSSES_DB_PATH`). CI (`update-ru-losses-db.yml`)
downloads the current DB first so it appends, then uploads the R2 object of the
same name.

## CLI

```sh
python ingest.py                       # fetch + append to default output path
python ingest.py --out /tmp/test.db    # write elsewhere
```

## Tracked metrics

`personnel, tanks, apv, artillery, mlrs, aaws, aircraft, helicopters, uav,
vehicles, boats, se, missiles, ugs, captive`. Mirrors `RU_LOSSES_METRIC_KEYS` in
`src/types/index.ts`; the source→column mapping lives in `EQUIP_MAP` /
`PERSONNEL_MAP`.

- **`ugs`** (unmanned ground systems) starts 2026-05-03; null before.
- **`captive`** (POW) only has data through 2022-04-27 — correct: the General
  Staff stopped reporting POWs (the old source's `captive` was null on *every*
  date), so it's a dead-but-harmless early-war column.
- **Ignored source keys**: `submarines` (flat-zero); `greatest losses direction`
  (text annotation); and the early-war `military auto` / `fuel tank` (folded into
  `vehicles and fuel tanks` on 2022-05-01) and `mobile SRBM system` (discontinued).

> **Every column is a single-day count, not a running cumulative total.** We diff
> the source's cumulative totals so the stored value is the losses the GS reported
> for *that day*. To get a monthly/period figure, **sum across dates** — e.g.
> `SELECT substr(date,1,7) m, SUM(uav) FROM …`.
