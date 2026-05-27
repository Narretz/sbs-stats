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
| UA SBU ALFA — MONTHLY RECAP | `sbu-alfa` | SBU press releases (Centre of Special Operations «А» monthly TOP-1 recap) | [`scripts/sbu_alfa/`](scripts/sbu_alfa/README.md) → `sbu-alfa.db` (manual ingest) |
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
- `deploy.yml` — builds and publishes to GitHub Pages.

## Common commands

```sh
npm run dev          # local dev server (Vite, port from vite.config.ts)
npm run build        # production build → dist/
npm run lint         # eslint, zero-warnings
npm run test:e2e     # Playwright e2e (uses .env.e2e fixture DBs)

# Python ingest scripts: see each scripts/<x>/README.md
pip install -r scripts/requirements.txt   # the devcontainer does this on create
```

## Conventions

- Python ingest scripts prefer the **stdlib** (the Telegram-web and API-free
  paths have no pip deps); `telethon` / `playwright` are imported lazily so the
  default paths run without them.
- All dates are reconciled to **Kyiv** (GSUA/SBS) or **MSK** (RU MoD) local time —
  see the per-script date models. `scraped_at` is always UTC.
- All DBs under `data/` are gitignored and pulled from R2 (see
  `scripts/fetch_prod_dbs.sh`, which reads URLs from `.env.production`).
  `scripts/setup-dev.cjs` copies `sbs.db` and `sbu-alfa.db` from `data/` into
  `public/data/` so vite serves them in dev and bundles them in production;
  the rest are range-fetched from R2 at runtime via sql.js-httpvfs.
