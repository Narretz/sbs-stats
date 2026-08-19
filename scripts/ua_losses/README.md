# UA losses scraper — confirmed Ukrainian personnel losses (ualosses.org)

Builds **`ua-losses.db`** from [ualosses.org](https://ualosses.org)'s
`UKR_ualosses_Personnel.xlsx` workbook — a research-based index of confirmed,
individually-named Ukrainian military personnel losses. This ingest takes the
workbook's **pre-aggregated daily time-series sheets** and stores per-day totals
(with a status split), ready for daily/monthly charts.

Requires **`openpyxl`** (the xlsx is a zip of XML; sheets are streamed
`read_only=True`). Already in `scripts/requirements.txt`.

```sh
# Build from a local copy of the workbook (default path is the one under
# sources/ualosses/ if present):
python3 scripts/ua_losses/ingest.py --xlsx sources/ualosses/UKR_ualosses_Personnel.xlsx \
    --out data/ua-losses.db

# Parse + report what would change, without writing:
python3 scripts/ua_losses/ingest.py --dry-run

# Keep the full pre-war tail (default drops everything before 2022-02-24):
python3 scripts/ua_losses/ingest.py --all-dates --out data/ua-losses.db
```

## Source

`UKR_ualosses_Personnel.xlsx` — a single workbook (~30 MB) distributed via
Kaggle / ualosses.org. Eight sheets; this ingest reads the two **daily** ones:

| Sheet | Columns used | Meaning |
|---|---|---|
| `ByDay` | `Date`, `Number`, `ofwhich_Male`, `meanAgeEvent` | Losses recorded on that date (all statuses), of which male, mean age at event. `CumNumber`/`CumMale`/etc. are the cumulative running totals — ignored (derivable). |
| `ByDayStatus` | `Date`, `Dead`, `Missing`, `Prisoner`, `Released` | The status split of that date's `Number`. |

The other sheets (`ByDayRank`, `ByDayRankStatus`, `ByNationality`, `ByTypeUnit`,
and the raw per-person `Database`) are not ingested yet — the first step is
daily/monthly totals + the status breakdown.

**`Number` is already per-day incremental** (not cumulative), so no diffing is
needed. On every date, `Dead + Missing + Prisoner + Released == Number`, so a
single date key carries both the headline total and its breakdown. Blank daily
cells mean a genuine zero for that day; a zero-death day has a NULL `mean_age`.

By default only war-period rows (`--since 2022-02-24`) are kept — the workbook
carries a long pre-war tail (Donbas-era and older records) irrelevant to this
dashboard.

## Schema

```sql
CREATE TABLE daily_losses (
    date       TEXT NOT NULL,   -- YYYY-MM-DD (date of the loss event)
    scraped_at TEXT NOT NULL,   -- UTC ingest timestamp
    number     INTEGER NOT NULL DEFAULT 0,  -- total losses recorded on this date
    dead       INTEGER NOT NULL DEFAULT 0,
    missing    INTEGER NOT NULL DEFAULT 0,
    prisoner   INTEGER NOT NULL DEFAULT 0,
    released   INTEGER NOT NULL DEFAULT 0,  -- released prisoners
    male       INTEGER NOT NULL DEFAULT 0,  -- of `number`, how many male
    mean_age   REAL,            -- mean age at event; NULL on a zero-loss day
    PRIMARY KEY (date, scraped_at)
);
```

Reads resolve the latest version per date (`MAX(scraped_at)` per `date`) —
mirroring the `ru_losses` / `mediazona` pattern.

## Append-only / edit-versioned

A stored row is **never** mutated or deleted. Each row is one *version* of a
date's numbers, tagged with `scraped_at`. ualosses continuously **revises past
days upward** as more deaths get identified — a loss on a date months ago may
only be added to the workbook today, and recent dates are right-censored
(under-counted until research catches up). Each run compares parsed values
against the latest stored version per date and INSERTs a NEW row only where they
differ (or the date is new); the frontend reads the latest snapshot per date.
This preserves the full historical development of the estimate across ingests.

## Guards

Both abort the build **before writing** (so a broken download leaves the DB
untouched):

1. **Floor** — fewer than `MIN_ROWS_FLOOR` (365) day-rows parsed ⇒ truncated
   workbook.
2. **No-shrink** — a fresh parse with fewer distinct dates than already stored
   ⇒ refuse to overwrite a good DB with a partial one.

## CLI

| Flag | Default | Meaning |
|---|---|---|
| `--xlsx PATH` | `sources/ualosses/UKR_ualosses_Personnel.xlsx` (or `$UA_LOSSES_XLSX`) | input workbook |
| `--since YYYY-MM-DD` | `2022-02-24` | drop earlier dates |
| `--all-dates` | off | keep the full pre-war tail |
| `--out PATH` | `scripts/ua_losses/output/ua-losses.db` (or `$UA_LOSSES_DB_PATH`) | output SQLite |
| `--dry-run` | off | parse + report, no write |

## Status / not yet done

This is the **ingest only** — no frontend wiring yet (no site key, hook, or
combined-chart registration). CI (a Kaggle-pull workflow + R2 upload) is also
not set up; the workbook currently has to be supplied locally via `--xlsx`.
See the RU LOSSES pipeline (`scripts/ru_losses/` + `update-ru-losses-db.yml`)
for the pattern to follow when wiring those up.
