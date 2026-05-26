# RU MoD air-defense scraper

Builds **`ru-mod-ad.db`** from the Russian Ministry of Defence Telegram channel
(`@mod_russia`) — the **RU AIR DEFENSE — RU MoD** view of the app. The MoD posts
ПВО reports of the form:

> … дежурными средствами ПВО перехвачены и уничтожены **N** украинских
> беспилотных летательных аппаратов … над территориями …

We extract the drone-intercept counts (and, when present, the per-region
breakdown). **These are UNVERIFIED Russian claims**; "intercepted/downed" is a
floor for "launched".

## Sources

Both backends feed the **same parser**:

| Backend | Auth | Use |
|---|---|---|
| `--source web` (default) | none — parses `t.me/s/mod_russia` HTML preview, stdlib only | daily incremental pull in CI |
| `--source telethon` | `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` + a session (reuses the gsua login via `RU_MOD_SESSION`) | full historical backfill (web preview is slow/rate-limited going back far) |

## Date model

Each report covers a time window, all in MSK:
- **night** = "с 20.00 мск [D-1] до 7.00 мск [D]" → window ends on **D**
- **daytime** = "с HH.00 до HH.00 мск" (same day) → window ends on **D**

We attribute a report to `report_date` = the MSK calendar date of its window
**end**, so the overnight report (which starts the previous evening) and that
day's daytime windows aggregate to the same date — tiling 24h at a 20:00 MSK
boundary with no overlap under the normal pattern.

Sometimes the MoD posts an evening update (e.g. "с 20.00 до 23.00 мск") **and** a
separate overnight report that states no start time — we assume 20:00, so the two
windows overlap and the overnight count may re-include the evening's drones. We
don't guess a different start; instead the build flags the later (overnight)
report by writing an `ad_reports.notes` string ("window may overlap preceding
report … possible double-count") and prints a warning. The flag is recomputed
from the latest version of each report on every run (`_flag_overlaps`), so it
never goes stale; clean reports keep `notes = NULL`.

## Schema & edit-versioning

Append-only / edit-versioned, same model as gsua. A post can be edited, so
`scraped_at` (ingest time, microsecond precision) is part of the primary key —
an edit inserts a **new version row**, never overwrites. Reads resolve the latest
`scraped_at` per `post_id`.

- **`ad_reports`** — one drone-intercept report. PK `(post_id, scraped_at)`.
  View **`ad_latest`** = latest version per post; **`daily_ad`** = per-date totals
  (what the frontend reads).
- **`ad_regions`** — itemized per-region counts when the post lists them
  (the MoD's format **changed over time**: 2025 reports were often itemized
  per-region, 2026 reports tend to give a single total). PK
  `(post_id, scraped_at, region)`. View **`region_totals`**.
- **`summaries`** — the daily **Сводка** posts, stored **raw** (header + full
  text) even though we don't parse their body yet. The MoD largely **stopped
  reporting Ukrainian losses** sometime in 2026; capturing the raw text now means
  we can backfill-parse later. PK `(post_id, scraped_at)`.

Change-detection compares the **parsed fields** (drones, window, kind, regions),
**not** raw text — so the web and telethon backends ingesting the same post don't
create a spurious new version just because their source text differs slightly.

See `DATASETS.md` §3 for the full source notes (format change, degraded UA-loss
reporting, raw Сводка capture rationale).

## DB output

Writes **`output/ru-mod-ad.db`** (override with `RU_MOD_DB_NAME` / `RU_MOD_DB_PATH`).
CI downloads/uploads the R2 object of the same name.

## CLI

```sh
# Daily incremental (CI default): resumes from highest stored id
python ingest.py --source web

# Bounded historical backfill window (telethon, newest→oldest):
#   --until starts the fetch at that MSK date; --since stops once past it
TELEGRAM_API_ID=<id> TELEGRAM_API_HASH=<hash> \
RU_MOD_SESSION=../gsua/gs_scraper_session \
python ingest.py --source telethon --since 2026-03-01 --until 2026-03-31 \
  --out ../../data/ru-mod-ad.db

# No-network parser check against built-in samples
python ingest.py --selftest
```

Key flags: `--source {web,telethon}`, `--since` / `--until YYYY-MM-DD`,
`--backfill` (web: ignore stored ids, walk `--max-pages`), `--max-pages`,
`--sleep`, `--channel`, `--out`.

## Tests

```sh
pytest test_ingest.py -q
```

Covers window parsing, the report gate, region breakdown, summary capture,
storage, and edit-versioning.
