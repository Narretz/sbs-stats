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
| RU RUBIKON — MONTHLY RECAP | `rubikon` | Центр «Рубикон» (RU UAV unit) monthly Telegram recap | [`scripts/rubikon/`](scripts/rubikon/README.md) → `rubikon.db` |
| RU DEATHS — MEDIAZONA | `mediazona` | Mediazona + Meduza confirmed named deaths + probate-registry estimate (CSV exports) | [`scripts/mediazona/`](scripts/mediazona/README.md) → `mediazona.db` |

[`DATASETS.md`](DATASETS.md) tracks source research, recency, and candidate
datasets for future views.

## Architecture

- **Frontend** (`src/`): one `useDatabase*` hook per dataset
  (`src/hooks/`), recharts-based chart components (`src/components/`), pages in
  `src/pages/`. Site keys / labels / metric lists live in `src/types/index.ts`.
  Every chart card is deep-linkable: `ChartCardTitle` slugifies its title into
  the card's `id` (`utils/chartAnchor.ts`), so `?site=rubikon&page=monthly#mortars`
  opens scrolled to that chart. The browser can't do this itself — charts only
  exist once the DB has loaded — so `useChartHashScroll` (called from
  `PageScaffold`) polls for the target and scrolls twice, the second time after
  recharts has sized its containers. The hover "#" affordance is CSS generated
  content, deliberately: as a real element it lands in the title's textContent
  and breaks `getByText(title, { exact: true })`.
- **Color**: `src/theme.ts` is the single source of truth — chrome tokens plus
  the chart-series tokens (`series1` blue = the main series of any chart,
  `series2` red = a second series drawn against it). `ThemeProvider` publishes
  the active theme onto `<html>` as CSS variables (`--color-bg-alt`, …), which
  `src/styles/theme.css` — a real stylesheet, imported from `main.tsx` — reads;
  recharts and inline styles take the same values off the `Theme` object via
  `useTheme()`. `src/chartColors.ts` maps chart roles (`damaged`, `barCurrent`,
  `maxReference`, …) onto those tokens, so recoloring a chart is one line there
  rather than a grep across components. The exceptions are the qualitative
  palettes, deliberately theme-independent: `QUALITATIVE_PALETTE` (GSUA
  directions + home-page metric charts), the HUR missile family palette
  (`components/missilePalette.ts`) and the Mediazona role groups
  (`types/index.ts`).
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
- `update-rubikon-db.yml` — Rubikon monthly recap. Daily 08:00 UTC on days
  2–8 of each month (7 runs) — the channel posts on the 3rd–4th, so this is a
  much tighter window than SBU Alfa's, which is why it's its own workflow
  rather than a second job alongside it. `scripts/rubikon/ingest.py` reads the
  public `t.me/s/icpbtrubicon` web preview (no Telegram API account, stdlib
  only) and stores the channel's TWO monthly series — the General-Staff-plan
  recap (3rd–4th, `report_type='monthly'`, the site) and the «Итоги»
  published-episode digest (month end / 1st, `report_type='monthly_digest'`,
  ingested but deliberately **not surfaced** — see scripts/rubikon/README.md).
  The ~200 other posts a month, including the multi-month cumulative totals,
  are rejected by the parsers' gates. Uploads gated on `changed=true`, like
  SBU Alfa. Both series land inside the days-2–8 window.
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
`rumod_lookback_days` (default 2). `update-sbu-alfa-db.yml`: `pages` (default
3 listing pages). `update-rubikon-db.yml`: `pages` (default 3 t.me/s preview
pages). `update-db.yml`: `all_months` (bypass the SBS 10-day / 6-hour
refresh thresholds). The Kaggle / CSV / article-bundle pipelines (RU losses, UA
losses, missile attacks, Mediazona) re-pull the whole source every run, so a
fix takes effect on the next run with no input to widen.

A widened lookback only helps for posts the parser **dropped**. When a fix
changes how already-stored text is *read*, a re-scrape re-ingests identical
text and changes nothing — the stored rows need re-parsing instead, which is
its own manual workflow: `reparse-gsua-db.yml` (inputs `since` =
`YYYY-MM-DD` or `all`, and `dry_run`, on by default). It pulls the DB from
R2, runs `scripts/gsua/reparse.py` over it, and re-uploads the full and app
copies. Kept separate from the scheduled scrape on purpose: different
trigger, different blast radius.

Rubikon has the same split without a workflow of its own: it stores each post's
raw text, so `scripts/rubikon/ingest.py --reparse` (dry-run; `--apply` writes)
re-reads the stored recaps locally after a parser fix, while `--max-pages` /
the workflow's `pages` input widens the scrape for a recap that was dropped
outright.

SBU Alfa has both halves inside its one workflow — one article a month didn't
justify a second workflow. `scripts/sbu_alfa/ingest.py --reparse` (dry-run;
`--apply` writes) re-reads the stored `reports.body_text`, and
`update-sbu-alfa-db.yml` exposes it as the `reparse` + `dry_run` inputs
alongside `pages`. Reparse is the half that matters there: `discover.py`
filters candidates by URL against the DB *before* parsing, so a recap already
stored is never re-read by a re-scan however wide `pages` is.

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
- **Diagnostics go through `scripts/ingest_log.py`.** `get_logger("<dataset>")`
  logs to stderr as usual and, when `$INGEST_LOG` is set (CI only), also
  appends each WARNING to a JSONL sink; the job's last step runs
  `scripts/annotate_log.py`, which dedupes, caps and turns them into GitHub
  annotations plus a job-summary table. So a finding is raised once, at the
  place that found it, and surfaces the same way for every dataset — never
  hand-roll a `print("::warning …")`. Use `ann(title=…)` to group a finding in
  the UI and `ann(level="notice")` for advisory ones. Checks that need the
  whole table rather than one record live in a `check_db.py` next to the
  ingest, not as inline SQL in the workflow.
- All DBs under `data/` are gitignored and pulled from R2 (see
  `scripts/fetch_prod_dbs.sh`, which reads URLs from `.env.production`). In
  dev, `data/*.db` is served by a vite middleware directly from the project
  root; in production the frontend reads from R2 via `VITE_*_DB_URL` env
  vars. Small DBs are fetched whole via sql.js; larger ones (GSUA attacks)
  are range-fetched via sql.js-httpvfs.
- **GSUA and RU MoD publish two objects each**: the authoritative `<name>.db`
  carrying the raw post text, and a stripped `<name>.app.db` (`posts.text` /
  `raw_text` blanked, ~3-5x smaller) that the frontend reads — in production
  *and* in dev, so local range-fetch behaviour matches the deployed site.
  `fetch_prod_dbs.sh` downloads both; CI always uploads them together, built
  from the same source, so they can't drift on R2. They drift **locally**:
  a reparse or ingest rewrites `<name>.db` and leaves the app copy alone, so
  dev keeps serving the old rows while the file they came from looks correct.
  Rebuild it with `scripts/build_app_db.py` — not by re-running the fetch,
  which would overwrite the reparse with R2's copy.
