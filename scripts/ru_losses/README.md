# RU losses scraper — Ukrainian General Staff national totals

Builds **`ru-losses-gsua.db`** from
[russian-casualties.in.ua](https://russian-casualties.in.ua) — the **RU LOSSES —
GSUA** view of the app. That site re-publishes the Ukrainian General Staff's
daily national loss totals (personnel, tanks, aircraft, UAVs, …) as a clean
JSON/CSV API.

We use the **daily** endpoint, which already returns per-day **increments** (not
cumulative), keyed by date — so no diffing needed. **stdlib only**
(`urllib` + `sqlite3` + `json`), no extra dependencies.

## How it works

- **Snapshot-only**: the frontend never calls the upstream API. This script runs
  in CI (and locally), writes a tiny SQLite file, and that file is uploaded to
  R2. The frontend fetches the whole DB via sql.js (`useDatabaseRuLosses`).
- **Append-only / versioned**, like the gsua `posts` table. `daily_losses` is
  keyed by `(date, scraped_at)`. Each run compares fetched values to the latest
  stored version per date and inserts a **new row only when they differ** (or the
  date is new). Nothing is ever overwritten, so the General Staff's occasional
  same-day corrections are captured as a fresh row that wins by having a newer
  `scraped_at`; a bad value can't clobber good stored data. The frontend reads
  the latest snapshot per date.

  > Note: the version-key column was historically `snapshot_at`; it was renamed
  > to **`scraped_at`** for consistency with the gsua / ru_mod scrapers (where
  > `snapshot_at` means a report's *own* time, and `scraped_at` means ingest
  > time). `build()` carries a one-shot `ALTER TABLE … RENAME COLUMN` migration.

- **Build guards** abort without writing (so the R2 upload is skipped and R2 is
  left untouched) if the fetch looks broken:
  1. fewer than 365 days returned (absolute floor — the war started 2022-02-24);
  2. fewer distinct dates than already stored (refuse a shrinking dataset).

## DB output

Writes **`output/ru-losses-gsua.db`** (override with `RU_LOSSES_DB_NAME` /
`RU_LOSSES_DB_PATH`). CI (`update-ru-losses-db.yml`) downloads the current DB
first so it appends, then uploads the R2 object of the same name.

## CLI

```sh
python ingest.py                       # fetch + append to default output path
python ingest.py --out /tmp/test.db    # write elsewhere
```

## Tracked metrics

`personnel, captive, tanks, apv, artillery, mlrs, aaws, aircraft, helicopters,
uav, vehicles, boats, se, missiles` (the source's own legend keys; `submarines`
is omitted — absent from the legend and flat-zero). Mirrors
`RU_LOSSES_METRIC_KEYS` in `src/types/index.ts`.
