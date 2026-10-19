# SBS grouping total — sbs-group.army

Builds **`sbs.db`** — the **SBS STATISTICS** view (site `sbs`) — from the
public `sbs-group.army` API for the Unmanned Systems Forces grouping
(Угруповання СБС, subdivision `68b0c855…`). `requests` plus the stdlib.

The per-unit breakdown is **not** here: [`scripts/sbs_units/`](../sbs_units/README.md)
snapshots each sub-unit into `sbs-units.db`. The split is deliberate —
`sbs.db` is fetched whole by every SBS page including the hourly one, and unit
data is only read by the monthly / compare / combined views. The two share
this script's HTTP and parsing helpers, imported as `sbs.ingest`.

```sh
python3 scripts/sbs/ingest.py                 # the usual run
python3 scripts/sbs/ingest.py --all-months    # every month, no refresh thresholds
DB_PATH=/tmp/sbs.db python3 scripts/sbs/ingest.py
```

In CI it is `update-db.yml`, every :10/:25/:40/:55 UTC — when it runs and what
it uploads is in [CI.md](../../CI.md).

## What a run does

1. **Daily (today)** — one row per Kyiv hour in `daily_stats`, keyed
   `(date, hour)`. `hour` comes from `dataCollectedAt`, not from the period:
   it is the intraday bucket the end-of-day projection reads a curve from.
   Around Kyiv midnight the collection stamp and the period's own `startDate`
   can disagree; the run warns and keeps the stamp, because moving `date` back
   while `hour` stays 0 would file the reading on the previous day's curve.
2. **Daily (previous day)** — the source revises yesterday after midnight.
   The correction is stored as another `daily_stats` row under **hour
   `24 + <Kyiv hour of the fetch>`** (fetched at 19:00 → hour 43), so it sorts
   after the day's real hours and a re-fetch in the same hour overwrites
   itself. Written only when the values differ from the last correction, and
   filed under the day the endpoint states, not under wall-clock yesterday.
3. **Monthly** — one row per month in `monthly_stats`, keyed
   `(date, data_collected_at)`: append-on-change, so a month's history across
   revisions survives. Unless `--all-months`, a month is skipped once it is
   more than 10 days closed, or if it was collected less than 6 hours ago.

## Period ids are not month names

The API serves twelve `monthly_N` period slots and **re-points them every
year**, so an id that meant "2025-06" now serves June 2026. There is therefore
no hardcoded month → URL map: `discover_monthly_urls()` reads `/periods`
(`?limit=500` — it paginates at 50 and serves every subdivision's periods, not
just ours), and each payload's stated `startDate` is checked against the month
it is about to be filed under. A mismatch is skipped and raised, never stored.
A run that can't reach `/periods` skips the monthly section entirely rather
than guessing; the next run picks it up.

## Guards

The API answers HTTP 200 for things that are not data, so the payload guards
are the interesting part — and what `test_ingest.py` covers:

- `_payload_is_usable` rejects a `not_collected` / empty payload rather than
  storing zeros over a good row.
- `_payload_period_start` reads the day or month the payload states, for the
  three checks above.
- `ensure_columns` adds a `hit_<id>` / `destroyed_<id>` column when the source
  publishes a target class we have never stored, and shouts about it: a new
  category needs a label in `src/types/index.ts`.

Findings go through [`scripts/ingest_log.py`](../ingest_log.py) and surface as
GitHub annotations.

## The foosint helpers

[foosint/sbs-stats](https://github.com/foosint/sbs-stats) polls the same API,
so its `sbs.db` can fill hours a run of ours never happened for (an expired
token, a workflow outage). Same API, no flight counts.

| Script | |
|---|---|
| `foosint_download.py` | fetches their `sbs.db` to `data/sbs-foosint.db` |
| `foosint_backfill.py` | generates `INSERT … ON CONFLICT DO NOTHING` for `(date, hour)` rows missing here — it cannot touch an hour we already have |
| `foosint_refresh.py` | generates `UPDATE`s for hours where their row has a strictly higher cumulative metric, i.e. was scraped later in the hour |

Neither generator touches a database: they write a `.sql` file to be reviewed
and then applied (the two under `data/` are past runs). `backfill_from_foosint`
on `update-db.yml` runs the download + backfill pair.

## Tests

`bash scripts/test_python.sh scripts/sbs` — the payload guards, period
discovery (keyed by the stated start, foreign subdivisions ignored, a
truncated page warned about) and the retry loop, on hand-built payloads and a
fake session. Offline.
