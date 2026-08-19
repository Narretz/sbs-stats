# UA losses scraper — confirmed Ukrainian personnel losses (ualosses.org)

Builds **`ua-losses.db`** from [ualosses.org](https://ualosses.org)'s
`UKR_ualosses_Personnel.xlsx` workbook — a research-based index of confirmed,
individually-named Ukrainian military personnel losses, distributed on Kaggle
(`ol4ubert/confirmed-ukrainian-military-personnel-losses`) with a numbered
version history.

Requires **`openpyxl`** (already in `scripts/requirements.txt`). Kaggle
`--version` downloads need `KAGGLE_USERNAME` / `KAGGLE_KEY`.

```sh
# Build from a local copy of the workbook:
python3 scripts/ua_losses/ingest.py --xlsx sources/ualosses/UKR_ualosses_Personnel.xlsx \
    --out data/ua-losses.db

# Build from a specific Kaggle version (downloads it):
set -a; . ./.env.kaggle; set +a
python3 scripts/ua_losses/ingest.py --version 19 --out data/ua-losses.db

# Parse + report without writing:
python3 scripts/ua_losses/ingest.py --dry-run
```

## What it stores

One row per date, with the day's total and its status split:

```sql
CREATE TABLE daily_losses (
    date       TEXT NOT NULL,   -- YYYY-MM-DD (date of the loss event)
    scraped_at TEXT NOT NULL,   -- ingest/version vintage (see below)
    number     INTEGER NOT NULL DEFAULT 0,  -- total losses recorded on this date
    dead       INTEGER NOT NULL DEFAULT 0,
    missing    INTEGER NOT NULL DEFAULT 0,
    prisoner   INTEGER NOT NULL DEFAULT 0,
    released   INTEGER NOT NULL DEFAULT 0,  -- POW since freed (dated at capture)
    PRIMARY KEY (date, scraped_at)
);
```

Read the latest version per date via `MAX(scraped_at)` per `date`. Demographic
fields (sex, age) that the workbook also carries are **not** stored — their
column names/positions churn across versions and they aren't charted.

## Parsing: positional, not by header name

The daily total comes from the **`ByDay`** sheet (column 1) and the split from
**`ByDayStatus`** (Dead / Missing / Prisoner / [Released]). We read these **by
position**, because ualosses has renamed columns repeatedly across versions:

| | v1–v10 (≈2024) | v12 (≈2025-06) | v14–v19 (≈2025-09+) |
|---|---|---|---|
| `ByDay` col 1 | `NumberDay` | `NumberHelp` | `Number` |
| `ByDayStatus` | *absent* | Dead/Missing/Prisoner | + `Released` |
| `Database` date col | `DateDeath` | `DateEvent` | `DateEvent` + `Status` |

Positions have stayed put; names haven't. When `ByDayStatus` is absent (the
early deaths-only era), every loss is a death, so `dead = number`.

Dates are `DateEvent` — the date of the loss (killed / went missing / captured),
**not** when the record was added. Undated persons and the pre-war tail
(`--since 2022-02-24` by default) are excluded.

## Append-only / edit-versioned — and why it matters here

A stored row is never mutated. Each is one *version* of a date's numbers tagged
with `scraped_at`. ualosses continually revises past days two ways: **newly
identified people** appended to old dates, and **reclassification** of existing
people (missing → dead / POW), which reshapes a date's split. The source keeps
only the *current* status, so the transition history isn't in any single
download — but it's latent in the sequence of Kaggle versions.

### Backfilling the version history

`backfill.sh` replays every Kaggle version oldest→newest into a fresh DB,
stamping each with its own data vintage as `scraped_at` (via `--as-of`, which
defaults to the data's max date under `--version`):

```sh
set -a; . ./.env.kaggle; set +a
bash scripts/ua_losses/backfill.sh data/ua-losses.db
```

Diffing the resulting snapshots reconstructs the reclassification history. E.g.
event-date **2022-03-15** across four versions:

| as-of | number | dead | missing | POW | released |
|---|---|---|---|---|---|
| 2024-10 (deaths-only) | 134 | 134 | 0 | 0 | 0 |
| 2025-05 | 103 | 52 | 38 | 13 | 0 |
| 2025-09 | 180 | 96 | 67 | 17 | 0 |
| 2026-06 | 204 | 100 | 56 | 20 | 28 |

(A full backfill is ~19 downloads of 5–30 MB each — a few minutes.)

## Guards

Both abort the build **before writing** (a broken download leaves the DB
untouched): a **floor** (< `MIN_ROWS_FLOOR` = 365 day-rows ⇒ truncated) and a
**no-shrink** check (fewer distinct dates than already stored ⇒ refuse).

## CLI

| Flag | Default | Meaning |
|---|---|---|
| `--xlsx PATH` | `sources/ualosses/…xlsx` (`$UA_LOSSES_XLSX`) | local input workbook |
| `--version N` | — | download & ingest Kaggle version N (needs creds) |
| `--kaggle-ref REF` | ualosses dataset (`$UA_LOSSES_KAGGLE_REF`) | Kaggle dataset for `--version` |
| `--since YYYY-MM-DD` | `2022-02-24` | drop earlier dates |
| `--all-dates` | off | keep the full pre-war tail |
| `--as-of YYYY-MM-DD` | vintage under `--version`, else now | `scraped_at` stamp |
| `--out PATH` | `scripts/ua_losses/output/ua-losses.db` (`$UA_LOSSES_DB_PATH`) | output SQLite |
| `--dry-run` | off | parse + report, no write |

## Status / not yet done

The frontend combined-charts wiring (site key `ua-losses`) surfaces `number` +
the status split. CI (a Kaggle-pull workflow + R2 upload) is **not** set up yet;
the workbook is supplied locally via `--xlsx` or `--version`. See
`scripts/ru_losses/` + `update-ru-losses-db.yml` for the pattern to follow.
