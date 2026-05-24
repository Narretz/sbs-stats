# GSUA scrapers

Scrapes Ukrainian **General Staff** daily operational reports (combat
engagements, air/missile/KAB/drone strikes, artillery, and per-direction
attack counts) into the SQLite schema in `schema.sql` (tables `posts` +
`directions`, view `daily_combined`) — the same DB the GSUA view of the app
reads.

There are **two source paths** to the same report text, because the General
Staff publishes the identical wording across channels:

| Path | Files | Auth | CI-friendly? |
|---|---|---|---|
| **Telegram** (primary, richest) | `scrape_general_staff.py` | Telegram API id/hash **+ interactive phone login on first run** | No (see Problems) |
| **Nitter → Facebook** (fallback) | `scrape_twitter.py` → `scrape_facebook.py` | none | Yes — designed for headless CI |

Both paths feed the same parser (`parse_summary` / `parse_directions` /
`is_operational_report` live in `scrape_general_staff.py`) and the same
`upsert_report`, so rows are identical regardless of source. `source` is
recorded per row (`telegram` / `facebook`).

## Files

- **`scrape_general_staff.py`** — the core. Telethon client for the
  `@GeneralStaffZSU` Telegram channel **plus** all shared logic: the report
  detector, the regex parsers, the dataclasses (`DailySummary`,
  `DirectionEntry`), the DB layer (`open_db`, `upsert_report`), and a one-shot
  legacy-schema migration. The other scrapers `import scrape_general_staff as
  gs` and reuse it.
  - Resume: with no `--since`/`--until` it auto-continues from the highest
    stored Telegram `source_id` (or a `output/.checkpoint` file), so repeated
    runs are incremental.
  - Window: `--since YYYY-MM-DD` / `--until YYYY-MM-DD` for explicit re-scrapes
    (re-parses via `INSERT OR REPLACE`).
  - Needs `TELEGRAM_API_ID` + `TELEGRAM_API_HASH`; first run prompts for a
    phone login and writes a `gs_scraper_session.session` file.

- **`scrape_twitter.py`** — CI entry point. Reads `@GeneralStaffUA` via
  rotating **Nitter** instances (server-rendered HTML, no login). The X
  cross-posts only contain a header line + a `t.co` link to the Facebook
  share URL, so this resolves the link and hands the FB URL to
  `scrape_facebook`. Subcommands:
  - `list --since YYYY-MM-DD` — print the tweets/FB URLs it would ingest.
  - `ingest --since YYYY-MM-DD [--until …]` — fetch + parse + upsert.
  - Has a fallback instance list and a per-run circuit breaker (skips an
    instance after 2 consecutive failures).

- **`scrape_facebook.py`** — Playwright fetch of a single public
  `facebook.com/share/p/…` post. The page's `innerText` is the full report,
  parsed by the shared `gs` parser. Usable standalone
  (`python scrape_facebook.py <url> …`) or as a library (used by
  `scrape_twitter`).

- **`reparse.py`** — re-parses rows already in the DB **without** hitting any
  source, for after a parser change. Selectors: message ids, `--source`,
  `--null-combat`, `--since/--until`, `--all`, `--dry-run`. Rows that no longer
  pass `is_operational_report` are deleted.

- **`run_local.sh`** — runs the whole update pipeline locally in one go
  (download DB from R2 → compute cutoff → Nitter→FB scrape → upload to R2).
  Use this from a **residential IP**: Facebook login-walls datacenter IPs, so
  the GitHub Actions workflow's FB fetch fails (see Problems). `--no-upload`
  and `--since YYYY-MM-DD` flags available; config via `R2_BUCKET` /
  `GSUA_DB_NAME` / `GSUA_LOOKBACK_DAYS` env vars.

- **`test_scrape_general_staff.py`** — unit tests for the parser/detector.

- **`schema.sql`** — the canonical DB shape, loaded by `open_db` at import
  time. Must sit next to `scrape_general_staff.py`. Idempotent
  (`CREATE … IF NOT EXISTS`), includes the covering indices the app's queries
  rely on.

## DB output

All scrapers write to **`output/ru-attacks-gsua.db`** (relative to the working
directory), hardcoded as `gs.DB_PATH`. The CI workflow downloads/uploads the
R2 object of the same name (`ru-attacks-gsua.db`) at this path.

## Dependencies

Declared in the project-wide `scripts/requirements.txt` (installed by the
devcontainer): `telethon` (hard import, needed even for the Nitter→FB path),
`playwright`, and `python-dotenv`. Playwright also needs its browser:
`python -m playwright install chromium` (the devcontainer does this on
create).

## Problems / caveats

1. **Telegram path can't run in plain CI.** Telethon's first run needs an
   interactive phone-number login. To use it headlessly you'd pre-generate a
   `StringSession` locally and inject it as a secret, plus change the code from
   the file-based `SESSION_NAME` to `StringSession`. The CI workflow therefore
   uses the **Nitter→FB** path instead. Telegram remains the better source for
   manual backfills (it has every report directly; the X→FB path only covers
   reports the GS cross-posts to X with a working FB link).
2. **Nitter instances are flaky.** They rotate and die; a CI run can fail
   purely because every instance in the list was down. The workflow will just
   succeed on the next scheduled run.
3. **Source coverage differs.** The Nitter→FB path depends on the GS posting
   to X with a resolvable FB link. If they skip X for a report, that report
   won't be captured until a Telegram backfill.
