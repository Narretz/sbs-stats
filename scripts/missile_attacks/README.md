# RU missile & UAV attacks scraper — UA Air Force Command + General Staff

Builds **`ru-air-attacks-gsua.db`** from
[piterfm's Kaggle dataset](https://www.kaggle.com/datasets/piterfm/massive-missile-attacks-on-ukraine)
*"Massive Missile Attacks on Ukraine"* — the **RU MISSILE & UAV ATTACKS — GSUA**
view of the app. piterfm (Petro Ivaniuk) digitizes the Ukrainian Air Force
Command + General Staff daily reports of Russian missile/UAV strikes into a
long-format CSV (`missile_attacks_daily.csv`).

This is the Ukrainian-side mirror of [`scripts/ru_mod`](../ru_mod/README.md):
`ru-mod-ad` = what UA launched at Russia + RU intercepts; `ru-air-attacks-gsua` =
what RU launched at Ukraine + UA intercepts. Unlike `ru-mod-ad` (intercepts
only), each row here carries both `launched` and `destroyed`.

## Grain — one row per weapon model per attack

The CSV is **not** a daily aggregate despite the filename. Each row is one weapon
model in one strike, with a `time_start`/`time_end` window and `launched` /
`destroyed` counts. A single overnight strike using Shahed-136 + Kh-101 + Kalibr
is **three rows** sharing the same window. We keep that grain as-is and aggregate
in the query layer (see the views below).

## How it works

- **Snapshot-only**: the frontend never calls Kaggle. This script runs in CI (and
  locally), writes a SQLite file, and that file is uploaded to R2. The frontend
  fetches the whole DB via sql.js.
- **Append-only / versioned on edit**, like `ru_mod` and `ru_losses`. piterfm
  re-publishes the dataset roughly **weekly** and **edits historical rows in
  place** (Kaggle versions are whole-file snapshots, not row-addressable). Each
  run re-downloads the latest file and, per natural key, inserts a **new row only
  when a value changed** (or the key is new), tagged with `scraped_at` (UTC, when
  *we* ingested). Nothing is ever overwritten; the frontend reads the latest
  `scraped_at` per key.
  - **Natural key**: `(time_start, time_end, model, launch_place, target,
    source)`. `source` (the originating UA Air Force / regional-command post) is
    what makes a row unique — same-day reports of the same model+target from
    different commands differ only by source.
  - We use `scraped_at`, **not** `snapshot_at` — in the GSUA schema `snapshot_at`
    already means the source's own "as of" timestamp.
- **stdlib only** — Kaggle's API is hit directly over HTTP Basic auth
  (`urllib` + `zipfile` + `csv` + `sqlite3`); no `kaggle` pip package needed.
- **Build guards** abort without writing (so the R2 upload is skipped and R2 is
  left untouched) if the download looks broken: a header-drift guard (essential
  column missing → source shape changed), a row-count floor (`MIN_ROWS_FLOOR`,
  default 1000), a "never fewer keys than already stored" shrink guard, and an
  in-download key-uniqueness guard.
- **Header growth is migrated, not fatal**: if piterfm *adds* a CSV column
  (e.g. `status_data`, Aug 2026), the build `ALTER TABLE ADD COLUMN`s it into
  the stored table — `CREATE TABLE IF NOT EXISTS` alone is a no-op against an
  existing DB, so without this the change-detection query asks for a column
  that isn't there and the run dies. New TEXT columns default to `''` so
  pre-existing rows match the blank cell a fresh CSV carries for them and the
  migration run doesn't re-version the whole dataset; rows upstream actually
  backfills differ for real and get a new version like any other edit.

## `status_data` — attacks reported without figures

Ukraine's Air Force stopped publishing exact ballistic-missile launched /
intercepted figures on 2026-08-13, citing operational security. piterfm added
`status_data` for this: a row flagged `'hidden'` is an attack that *was*
reported (types, launch areas, targets) with the counts withheld. The CSV has
no null for that, so it carries a placeholder `0` in `launched` / `destroyed` —
indistinguishable from a real zero to anything that just sums the column.

The ingest stores the flag verbatim, alongside the placeholder, so the table
keeps mirroring upstream. **Resolving it is a read-side job**: the frontend
(`src/hooks/useDatabaseRuAirAttacks.ts`) rebuilds the aggregate views over its
in-memory copy so hidden rows contribute `NULL` rather than `0`, and carries a
per-group `hidden` count. A withheld day then charts as a gap instead of a drop
to zero, tooltips read "not disclosed", and monthly bars that contain one are
flagged as lower bounds. `e2e/undisclosed-counts.spec.ts` guards the case that
actually matters: a withheld day and a genuinely quiet day staying
distinguishable, since both hold a literal 0 in the DB.

The `daily_*` views in the file resolve it the same way (see **Views** below), so
direct SQL against `ru-air-attacks-gsua.db` gets nulls too — but only from the
first build that ran this code. The frontend keeps installing its own views over
its in-memory copy regardless, so the site stays correct against a DB of any
vintage rather than depending on when the workflow last ran.

## Derived columns

Added by the build (not in the CSV):

- **`attack_date`** — the date portion of `time_start`, so daily aggregation
  doesn't depend on SQLite parsing arbitrary timestamp formats.
- **`category`** — `drone` / `cruise` / `ballistic` / `other`, by tokenizing the
  (possibly `" and "`-bundled) `model` string. Precedence is ballistic > cruise >
  drone, so a cruise+ballistic bundle resolves to ballistic. Genuinely
  new/unknown model tokens emit a warning (known-but-uncategorizable ones like
  guided bombs map to `other` silently).

## Views

- **`missile_attacks_latest`** — the table with only the latest `scraped_at` per
  natural key (what every other view reads from).
- **`daily_totals`** — `date, launched, destroyed, rows, hidden` (sum over all models).
- **`daily_by_model`** — `date, model, launched, destroyed, hidden`.
- **`daily_by_category`** — `date, category, launched, destroyed, hidden`.

All three resolve `status_data='hidden'` (see above): a withheld row contributes
NULL rather than its placeholder 0, so `SUM` skips it and a group with nothing
disclosed reads NULL — unknown — instead of zero. `hidden` counts the withheld
rows behind each group, so a partial sum can be read as the lower bound it is.
In `daily_totals`, `rows` still counts a withheld attack (one *was* reported),
so `rows` can exceed what `launched` accounts for; `hidden` says by how many.

The aggregates are DROPped and recreated on every build, not
`CREATE VIEW IF NOT EXISTS`ed. An existing DB already carries them, so the
IF-NOT-EXISTS form is a no-op there and would pin whatever definition the file
was first built with — a change would never reach R2 and would fail silently.
(Same shape as the `status_data` header break above: the migration that isn't.)

## DB output

Writes **`output/ru-air-attacks-gsua.db`** (override with `MISSILE_DB_NAME` /
`MISSILE_DB_PATH`). CI (`update-missile-attacks-db.yml`) downloads the current DB
first so it appends, then uploads the R2 object of the same name.

## CLI

```sh
# Needs a free Kaggle account's API token (Settings → API → Create New Token):
export KAGGLE_USERNAME=... KAGGLE_KEY=...      # the two fields from kaggle.json

python ingest.py                               # download + append to default output
python ingest.py --out /tmp/test.db            # write elsewhere
python ingest.py --csv local.csv               # ingest a local CSV (no download)
python ingest.py --save-csv /tmp/raw.csv       # save the download for repeated runs

pytest scripts/missile_attacks                 # tests (no network; in-memory CSV)
```
