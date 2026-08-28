# sbs-stats

A static dashboard of Russia–Ukraine war statistics. React 18 + Vite 5 +
TypeScript frontend, deployed to GitHub Pages. There is **no application
backend**: each dataset is snapshotted into a SQLite file by a Python ingest
script (run in CI), uploaded to Cloudflare R2, and read directly in the browser
via sql.js / sql.js-httpvfs.

## Datasets (views)

| View | Site key | Source | Pipeline |
|---|---|---|---|
| SBS STATISTICS | `sbs` | sbs-group.army public API | `scripts/fetch_and_update.py` → `sbs.db` |
| RU ATTACKS — GSUA | `ru-attacks-gsua` | Ukrainian General Staff operational reports (Telegram) | [`scripts/gsua/`](scripts/gsua/README.md) → `ru-attacks-gsua.db` |
| RU LOSSES — GSUA | `ru-losses-gsua` | Ukrainian General Staff national totals (PetroIvaniuk dataset) | [`scripts/ru_losses/`](scripts/ru_losses/README.md) → `ru-losses-gsua-petroivaniuk.db` |
| RU AIR DEFENSE — RU MoD | `ru-airdef-mod` | Russian MoD air-defense claims (Telegram) | [`scripts/ru_mod/`](scripts/ru_mod/README.md) → `ru-mod-ad.db` |
| RU MISSILE & UAV ATTACKS — GSUA | `ru-air-attacks-gsua` | UA Air Force Command + General Staff strike reports (piterfm / Kaggle) | [`scripts/missile_attacks/`](scripts/missile_attacks/README.md) → `ru-air-attacks-gsua.db` |
| UA SBU ALFA — MONTHLY RECAP | `sbu-alfa` | SBU press releases (Centre of Special Operations «А» monthly TOP-1 recap) | [`scripts/sbu_alfa/`](scripts/sbu_alfa/README.md) → `sbu-alfa.db` |
| RU DEATHS — MEDIAZONA | `mediazona` | Mediazona + Meduza confirmed named deaths + probate-registry estimate (CSV exports) | [`scripts/mediazona/`](scripts/mediazona/README.md) → `mediazona.db` |

[`DATASETS.md`](DATASETS.md) tracks source research, recency, and candidate
datasets for future views.

## Architecture

- **Frontend** (`src/`): one `useDatabase*` hook per dataset
  (`src/hooks/`), recharts-based chart components (`src/components/`), pages in
  `src/pages/`. Site keys / labels / metric lists live in `src/types/index.ts`.
- **Data flow**: ingest script (Python, mostly stdlib) → SQLite → R2 (bucket
  `russia-ukraine-war`, public `pub-de9836bbd1a14affa2ecd7e998df13a2.r2.dev`).
  Production DB URLs are in `.env.production`. Small DBs are fetched whole via
  sql.js; the large GSUA attacks DB is range-fetched via sql.js-httpvfs.
- **Storage model**: the scraped datasets are **append-only / edit-versioned** —
  a row is never overwritten; an edit/correction inserts a new row keyed by an
  ingest timestamp (`scraped_at`), and reads resolve the latest version. See the
  per-script READMEs for details.
- **Tests** (`e2e/`): e2e tests for the frontend application. Uses fixtures in place of live data.
  Add and run tests on your own discretion after features/fixes have been completed.
  (`scripts/*/test_ingest.py`): ingest tests for scripts that parse data from unstructered sources.
  Must always be run and updated when the parser is changed.


## CI / deploy

GitHub Actions in `.github/workflows/`:
- `update-db.yml` — SBS.
- `update-ru-losses-db.yml` — RU losses.
- `update-telegram-web-dbs.yml` — GSUA + RU MoD (two jobs, both scrape the
  public `t.me/s` web preview, no API account). Scheduled at 08:00 / 16:00 /
  22:00 **Europe/Kyiv** (IANA `timezone:` cron field) to land just after the GS
  reports; a 2-day idempotent lookback covers GitHub's scheduler lag.
- `update-missile-attacks-db.yml` — RU missile & UAV attacks. Daily (06:00 UTC);
  pulls piterfm's Kaggle dataset (needs `KAGGLE_USERNAME` / `KAGGLE_KEY`
  secrets), append-on-change so an unchanged ~weekly re-publish inserts nothing.
- `update-mediazona-db.yml` — Mediazona named-deaths + probate estimate. Every
  3 days (07:00 UTC); pulls directly from the live article's JS bundle
  (`--from-article` mode), append-on-change. Article URL is a workflow env var
  (`MEDIAZONA_ARTICLE_URL`) — bump it when Mediazona publishes at a new path.
- `update-sbu-alfa-db.yml` — SBU Alfa monthly recap. Daily 08:00 UTC on days
  5–20 of each month (~16 runs). `scripts/sbu_alfa/discover.py` scans the SBU
  news listing, slug-filters candidate URLs, and ingests any not already in
  the DB. Slug-drift-safe: matches only insert if the parser recognises
  `report_type='monthly_top1'` with a valid `period`.
- `update-ua-losses-db.yml` — UA personnel losses (ualosses.org via Kaggle).
  Twice a month (07:00 UTC on the 1st & 15th) — the source re-uploads only every
  ~2 months, so this catches a release within ~2 weeks without a daily 30 MB
  no-op download. `ingest.py --latest` pulls the current Kaggle version (needs
  `KAGGLE_USERNAME` / `KAGGLE_KEY` secrets), append-on-change. The ingest needs
  `openpyxl` (the source is xlsx), so the job pip-installs it — the only ingest
  workflow that isn't stdlib-only. Not yet a dedicated site; feeds the combined
  charts only.
- `deploy.yml` — builds and publishes to GitHub Pages.

The scrapers that only re-read a recent window expose that window as a
`workflow_dispatch` input, so a manual run can widen it after a parser fix — a
post the parser dropped was never stored, so `reparse.py` can't recover it and
only a re-scrape can. `update-telegram-web-dbs.yml`: `gsua_lookback_days` /
`rumod_lookback_days` (default 2). `update-sbu-alfa-db.yml`: `pages` (default 3
listing pages). `update-db.yml`: `all_months` (bypass the SBS 10-day / 6-hour
refresh thresholds). The Kaggle / CSV / article-bundle pipelines (RU losses, UA
losses, missile attacks, Mediazona) re-pull the whole source every run, so a
fix takes effect on the next run with no input to widen.

## Common commands

```sh
npm run dev          # local dev server (Vite, port from vite.config.ts)
npm run build        # production build → dist/
npm run lint         # eslint, zero-warnings
npm run test:e2e     # Playwright e2e (uses .env.e2e fixture DBs)

# Python ingest scripts: see each scripts/<x>/README.md
pip install -r scripts/requirements.txt   # the devcontainer does this on create
bash scripts/setup_env.sh                 # npm + pip bootstrap for a fresh container
```

## Conventions

- Python ingest scripts prefer the **stdlib** (the Telegram-web and API-free
  paths have no pip deps); `telethon` / `playwright` are imported lazily so the
  default paths run without them.
- All dates are reconciled to **Kyiv** (GSUA/SBS) or **MSK** (RU MoD) local time —
  see the per-script date models. `scraped_at` is always UTC.
- All DBs under `data/` are gitignored and pulled from R2 (see
  `scripts/fetch_prod_dbs.sh`, which reads URLs from `.env.production`). In
  dev, `data/*.db` is served by a vite middleware directly from the project
  root; in production the frontend reads from R2 via `VITE_*_DB_URL` env
  vars. Small DBs are fetched whole via sql.js; larger ones (GSUA attacks)
  are range-fetched via sql.js-httpvfs.
