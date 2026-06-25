# Russian Invasion of Ukraine Statistics

A static dashboard of Russia–Ukraine war statistics. React 18 + Vite + TypeScript,
deployed to GitHub Pages. There is **no application backend**: each dataset is
snapshotted into a SQLite file by a Python ingest script (in GitHub Actions),
uploaded to Cloudflare R2, and read directly in the browser via
[sql.js](https://github.com/sql-js/sql.js) / [sql.js-httpvfs](https://github.com/phiresky/sql.js-httpvfs).

Originally a fork of [foosint/sbs-stats](https://github.com/foosint/sbs-stats); the
SBS view shares its data lineage with that project through April 2026 (we carry
later data points and additional metrics), and the other views below are original
to this fork.

## Datasets

| View | Source | What it is | Cadence / limitations |
|---|---|---|---|
| **SBS STATISTICS** | [sbs-group.army](https://sbs-group.army) public API | Soldiers-by-soldiers crowd-sourced engagement reports | Live API; values can be revised by SBS upstream |
| **RU ATTACKS — GSUA** *(original)* | Ukrainian General Staff operational reports, scraped from the public `t.me/s` Telegram preview | Daily per-direction combat-clash counts | 3×/day scrape (Kyiv 08:00 / 16:00 / 22:00); 2-day idempotent lookback covers scheduler lag |
| **RU LOSSES — GSUA** | [PetroIvaniuk/2022-Ukraine-Russia-War-Dataset](https://github.com/PetroIvaniuk/2022-Ukraine-Russia-War-Dataset) (MIT) | National cumulative GSUA loss totals, differenced to per-day increments | Daily; GSUA's own caveats apply (claims, not OSINT-verified). Includes UGS (ground robotic systems) from 2026-05-03 |
| **RU AIR DEFENSE — RU MoD** *(original)* | Russian MoD Telegram (`@mod_russia`) via `t.me/s` web preview | Air-defense intercept reports — overnight/daytime UAV-downed counts, with per-region breakdowns when available | 3×/day. Claims unverified and widely considered inflated; window overlaps occasionally double-count adjacent reports (flagged in `ad_reports.notes`); 2026 per-region data is sparse |
| **RU MISSILE & UAV ATTACKS — GSUA** | [piterfm "Massive Missile Attacks on Ukraine"](https://www.kaggle.com/datasets/piterfm/massive-missile-attacks-on-ukraine) (Kaggle) | UA Air Force per-attack launched/destroyed by weapon model | Daily via Kaggle API. Some rows bundle multiple types in one `model` string — a true per-type breakdown would have to split bundles |

Append-only / edit-versioned storage everywhere: a row is never overwritten — an
edit or correction inserts a new row keyed by `scraped_at`, and reads resolve the
latest version per natural key. See each `scripts/<name>/README.md` for the per-pipeline
storage model and date reconciliation (Kyiv for GSUA/SBS, MSK for RU MoD).

[`DATASETS.md`](DATASETS.md) tracks source research, recency, and candidate datasets
for views we haven't built yet (territory control, OSINT equipment losses, Russian
budget-derived casualties, frontline weather, etc.).

## What's original and not based on existing datasets

- The two **Telegram scrapers** (GSUA per-direction attacks, RU MoD air-defense
  intercepts) — `scripts/gsua/` and `scripts/ru_mod/`, both API-account-free, parsing
  the public web preview directly.

## Architecture

- **Frontend** (`src/`): one `useDatabase*` hook per dataset (`src/hooks/`),
  recharts-based components (`src/components/`), pages in `src/pages/`. Site keys
  and metric lists live in `src/types/index.ts`.
- **Data flow**: ingest script (Python, mostly stdlib) → SQLite → R2 bucket
  `russia-ukraine-war` (public `pub-de9836bbd1a14affa2ecd7e998df13a2.r2.dev`).
  Small DBs are fetched whole via sql.js; the large GSUA attacks DB is range-fetched
  via sql.js-httpvfs.
- **CI**: workflows in `.github/workflows/` schedule each ingest and `deploy.yml`
  builds and publishes to GitHub Pages.
- **Tests** (`e2e/`): e2e tests for the frontend application. Uses fixtures in place of live data.

## Common commands

```sh
npm run dev          # local dev server
npm run build        # production build → dist/
npm run lint         # eslint, zero-warnings
npm run test:e2e     # Playwright e2e (synthetic fixture DBs)

pip install -r scripts/requirements.txt   # Python ingest deps (devcontainer auto-runs this)
```

See [`CLAUDE.md`](CLAUDE.md) for the conventions used by AI assistants working in
this repo (storage model, date handling, stdlib preference for ingest scripts).
