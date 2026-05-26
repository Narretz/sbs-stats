# GSUA scrapers — Ukrainian General Staff operational reports

Scrapes the Ukrainian **General Staff** daily operational reports (combat
engagements, air/missile/KAB/drone strikes, artillery, and per-direction attack
counts) into the SQLite schema in `schema.sql` — the same DB the **RU ATTACKS —
GSUA** view of the app reads.

The General Staff publishes the **identical wording** across several channels, so
there are multiple source paths to the same report text. All feed one shared
parser and one `upsert_report`, so rows are identical regardless of source;
`source` is recorded per row.

| Path | File | Auth | CI? | Status |
|---|---|---|---|---|
| **Telegram web preview** (`t.me/s/GeneralStaffZSU`) | `scrape_general_staff.py --source web` | none (plain HTTP) | yes | **primary CI source** |
| **Telegram API** (`@GeneralStaffZSU`) | `scrape_general_staff.py --source telethon` | API id/hash + interactive phone login on first run | no (see caveats) | best for backfill |
| **Nitter → Facebook** | `scrape_twitter.py` → `scrape_facebook.py` | none | yes | legacy fallback (to be removed) |

## Files

- **`scrape_general_staff.py`** — the core. Holds **all shared logic**: the
  report detector (gate), the regex parsers (`parse_summary` /
  `parse_directions`), dataclasses (`DailySummary`, `DirectionEntry`), the DB
  layer (`open_db`, `upsert_report`), and one-shot schema migrations. The other
  scrapers `import scrape_general_staff as gs` and reuse it. Two source backends:
  - `--source web` (default) — parses the public `t.me/s/<channel>` HTML preview
    via `iter_web_preview` (stdlib only, no login, no browser). The preview
    returns the **full** report text (no truncation). Resumes from the highest
    stored Telegram `source_id` unless `--since`/`--backfill` is given.
  - `--source telethon` — Telethon client for the Telegram API. Needs
    `TELEGRAM_API_ID` + `TELEGRAM_API_HASH`; first run prompts a phone login and
    writes `gs_scraper_session.session`. Richest source for manual backfills.
  - Window: `--since YYYY-MM-DD` / `--until YYYY-MM-DD` for explicit re-scrapes.
- **`scrape_twitter.py`** / **`scrape_facebook.py`** — legacy Nitter→Facebook
  fallback (reads `@GeneralStaffUA` on X, resolves the `t.co`→Facebook share URL,
  Playwright-fetches the FB post body). Kept until the web-preview path is proven
  out; slated for removal.
- **`reparse.py`** — re-parses rows already in the DB **without** hitting any
  source, for after a parser change. Selectors: message ids, `--source`,
  `--null-combat`, `--since/--until`, `--all`, `--dry-run`. Rows that no longer
  pass the gate are deleted.
- **`run_local.sh`** — runs the whole pipeline locally (download DB from R2 →
  scrape → upload to R2). Steps are independently skippable
  (`--no-download` / `--no-scrape` / `--no-upload`).
- **`test_scrape_general_staff.py`** — pytest suite locking in every wording
  variant. Run with `pytest -q`.
- **`schema.sql`** — the canonical target DB shape, loaded by `open_db` at
  import. Idempotent; includes the covering indices the app's queries rely on.

## DB output

Writes **`output/ru-attacks-gsua.db`** (override with `GSUA_DB_NAME`). CI
downloads/uploads the R2 object of the same name.

## Schema & edit-versioning

Tables `posts` + `directions`, view `daily_combined`. The schema is
**append-only / edit-versioned**: a Telegram post can be edited after we first
store it, so `scraped_at` (ingest time) is part of the primary key —
`PRIMARY KEY (source, source_id, scraped_at)`. An edit inserts a **new version
row** rather than overwriting; no version is ever lost. Every read resolves the
latest `scraped_at` per `(source, source_id)` (the `daily_combined` view does
this via `NOT EXISTS`). `scraped_at` was already a populated column pre-versioning,
so historical rows keep their original value — no NULLs, no backfill.

Two distinct timestamps, don't confuse them:
- **`snapshot_at`** — the report's *own* header time (`станом на HH:MM DD.MM.YYYY`,
  Kyiv local, naive). What the report is about.
- **`scraped_at`** — when *we* ingested it. The version key.

The `date` column is the day the report **covers**, not the day it was posted
(the 08:00 morning wrap-up is shifted back one day).

## What the channel publishes

Three slots per day, all Kyiv local time:

| slot | role | day-of-coverage |
| --- | --- | --- |
| 08:00 | morning wrap-up | covers the **previous** day |
| 16:00 | midday update | covers the same day, 00:00→now |
| 22:00 | evening report | covers the same day |

Header is always `Оперативна інформація станом на HH:MM DD.MM.YYYY щодо
російського вторгнення` (older posts use the Ukrainian-month form "9 травня 2026").

**GSUA only reports enemy actions.** "агресор N разів атакував" / "окупанти
атакували N разів" / "ворог N разів атакував" / "N бойових зіткнень" /
"кількість X становить N" are all the **same** metric, just phrased differently —
don't add a separate "attacks" column for midday posts.

## Parser structure (`combat_engagements`)

Branches tried in order, first match wins:

| # | branch | example |
| - | --- | --- |
| 1a | digit, separated form | "138 бойових зіткнень" |
| 1b | digit, compound form, line-anchored | "Загалом… зафіксовано 201 боєзіткнення" |
| 1c | word form, line-anchored | "відбулося сто бойових зіткнень" |
| 2 | midday "(агресор\|ворог) N разів атакував" | "ворог 95 разів атакував позиції Сил оборони" |
| 3 | midday "окупанти атакували N разів" | "окупанти атакували 75 разів" |
| 4 | midday "кількість X (становить\|складає) N" | "кількість атак агресора вже становить 64" |

Branches 1b/1c/2 are **anchored** to disambiguate from per-direction text that
reuses similar phrasing. **Directions** are detected via the `direction_pattern`
regex (any "На X[ому/ій/их/ім] [та/і/й Y] напрямк…" phrase; paired headers emit
both) and normalised through the hardcoded `DIRECTION_NAMES` table; unmatched
ones fall to a Title-case fallback and get a `_sanity_check` warning.

## Recurring channel quirks

- **Wording drifts** every few months — each variant is locked in by a test.
- **Header typos at month/year boundaries** (e.g. `11.12.2025` written on Dec 1).
  Auto-detected by comparing header date to the message's Kyiv-local date with a
  **12-hour** distance threshold (not a calendar-day check — late posts cross
  midnight); corrected `snapshot_at` + a `notes` marker record what happened.
- **Per-direction "mini-aggregates"** reuse global aggregate wording inside
  direction sections; the real global is distinguished by **line position**
  (always at paragraph start, never mid-sentence after "На X напрямках").
- **Apostrophe variants** (U+02BC ʼ, U+2019 ', ASCII ') and **en-dash in
  direction names** (U+2013) are normalised before lookup.

## Working loop: scrape backwards a month at a time

```sh
python scrape_general_staff.py --source web --since 2025-09-01 --until 2025-09-30
```

Read the WARN lines — they surface NULL `combat_engagements` (usually a new
wording variant), impossible values (`combat_engagements < max(direction.attacks)`),
auto-corrected header typos, unmapped directions, and "unusual direction count"
(<~5 directions; usually a legitimate short midday update, sometimes a real
parser miss). For each new variant: add a regex branch / stop-word /
`DIRECTION_NAMES` entry, add a **regression test** keyed to the msg_id, commit,
then re-parse in place (no re-scrape):

```sh
python reparse.py --null-combat   # or: python reparse.py 28902 28942
pytest -q
```

When triaging many "unusual direction count" warnings, dispatch an `Explore`
subagent — the per-msg work is read-only (compare bold headers against the
`directions` table) and parallelises well. Tell it to bucket each as
(a) legitimate short report, (b) real parser miss (name the new wording), or
(c) other, and to **verify against the `directions` table**, not the prose alone.

### Don't repeat these mistakes

- Don't add a word-form aggregate fallback without anchoring it to a day-marker
  at line start — per-direction "відбили п'ять боєзіткнень" lines will eat it.
- Don't add `ворог` to the midday "N разів атакував" pattern without the
  `позиц… Сил оборони` suffix anchor — per-direction lines get picked up instead.
- Don't loosen the gate to "≥2 of 4 patterns" — press statements / commander
  quotes match patterns 2+3 in narrative prose. Pattern 1
  (`Оперативна інформація`) must be required.

## Charting / consuming the data

For aggregate time series, query the **`daily_combined` view** — one row per
`(source, date, snapshot_at)` over the latest version of each post, with
continuation parts merged via `MAX()`:

```sql
SELECT date, snapshot_at, combat_engagements
FROM daily_combined
WHERE combat_engagements IS NOT NULL
ORDER BY date, snapshot_at;
```

For per-direction data, join `directions` to the latest post version directly
(`daily_combined` doesn't include directions — they're 1-to-many). The
`posts.part` column flags the rare late-2024 multipart splits: `NULL` for normal
posts, `"1/2"`/`"2/2"`/… for length-limit splits (part-1 carries the global
aggregates, part-2 the directions). A handful of older 2024 midday posts have no
global aggregate at all and show as NULL combat — `IS NOT NULL` handles them.

## Dependencies & caveats

Declared in `scripts/requirements.txt` (installed by the devcontainer):
`telethon` (only the API path; imported lazily so web/Nitter paths run without
it), `playwright` (Nitter→FB path only; needs `python -m playwright install
chromium`), `python-dotenv`. The **web preview path is stdlib-only**.

- **Telethon can't run in plain CI** — its first run needs an interactive phone
  login. CI uses the web-preview path instead; Telethon is for manual backfills.
- **Web preview / Nitter can be flaky** — t.me rate-limits and Nitter instances
  die. A failed run just succeeds on the next scheduled one (idempotent upsert
  with a 2-day lookback).
