# sbs-stats

A static dashboard of Russia–Ukraine war statistics. React 19 + Vite 8 +
TypeScript frontend, deployed to GitHub Pages. There is **no application
backend**: each dataset is snapshotted into a SQLite file by a Python ingest
script (run in CI), uploaded to Cloudflare R2, and read directly in the browser
via sql.js / sql.js-httpvfs.

## Datasets (views)

| View | Site key | Source | Pipeline |
|---|---|---|---|
| SBS STATISTICS | `sbs` | sbs-group.army public API | `scripts/fetch_and_update.py` → `sbs.db` |
| SBS SUB-UNITS | (SBS monthly filter · compare column · `sbs-unit.*` metrics) | sbs-group.army public API, per subdivision | [`scripts/sbs_units/`](scripts/sbs_units/README.md) → `sbs-units.db` |
| RU ATTACKS — GSUA | `ru-attacks-gsua` | Ukrainian General Staff operational reports (Telegram) | [`scripts/gsua/`](scripts/gsua/README.md) → `ru-attacks-gsua.db` |
| RU LOSSES — GSUA | `ru-losses-gsua` | Ukrainian General Staff national totals (PetroIvaniuk dataset) | [`scripts/ru_losses/`](scripts/ru_losses/README.md) → `ru-losses-gsua-petroivaniuk.db` |
| UA LOSSES — RU MoD (**not in production**) | `ua-losses-ru-mod-john-felix` | RU MoD claimed Ukrainian losses, John Felix's hand-compiled Google Sheet | [`scripts/ua_losses_ru_mod/`](scripts/ua_losses_ru_mod/README.md) → `ua-losses-ru-mod-john-felix.db` |
| RU AIR DEFENSE — RU MoD | `ru-airdef-mod` | Russian MoD air-defense claims (Telegram) | [`scripts/ru_mod/`](scripts/ru_mod/README.md) → `ru-mod-ad.db` |
| RU MISSILE & UAV ATTACKS — GSUA | `ru-air-attacks-gsua` | UA Air Force Command + General Staff strike reports (piterfm / Kaggle) | [`scripts/missile_attacks/`](scripts/missile_attacks/README.md) → `ru-air-attacks-gsua.db` |
| UA SBU ALFA — MONTHLY RECAP | `sbu-alfa` | SBU press releases (Centre of Special Operations «А» monthly TOP-1 recap) | [`scripts/sbu_alfa/`](scripts/sbu_alfa/README.md) → `sbu-alfa.db` |
| RU RUBIKON — MONTHLY RECAP | `rubikon` | Центр «Рубикон» (RU UAV unit) monthly Telegram recap | [`scripts/rubikon/`](scripts/rubikon/README.md) → `rubikon.db` |
| RU DEATHS — MEDIAZONA | `mediazona` | Mediazona + Meduza confirmed named deaths + probate-registry estimate (CSV exports) | [`scripts/mediazona/`](scripts/mediazona/README.md) → `mediazona.db` |
| UA+RU CIVILIAN CASUALTIES — CIT | `cit-civilians` | Conflict Intelligence Team daily 20:00–20:00 MSK casualty summaries (Telegram) | [`scripts/cit_civilians/`](scripts/cit_civilians/README.md) → `cit-civilians.db` |
| RU WEEKLY STRIKES — PRESIDENT UA | `zelensky-weekly` | President of Ukraine's weekly strike tally (Telegram): drones / guided bombs (KAB) / missiles | [`scripts/zelensky_weekly/`](scripts/zelensky_weekly/README.md) → `zelensky-weekly.db` |

The sheet behind UA LOSSES — RU MoD has no licence. CI backs it up to R2, but
displaying it is a build-time switch, `SHOW_UA_LOSSES_RU_MOD` (on in
`.env.development`, off in production and e2e): without it the dataset's one
import, `@/sites/uaLossesRuMod`, resolves to an empty stub and its code is not
in the bundle. Import its code only through there, or it leaks back in. See
[`scripts/ua_losses_ru_mod/`](scripts/ua_losses_ru_mod/README.md).

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
- **SBS sub-units are a refinement of the `sbs` source, not a source of their
  own.** A unit publishes exactly the grouping's counters, so its rows ARE
  `MonthlyRow` and every chart, target label and compare row mapping applies
  unchanged — the cost of adding them was plumbing, not modelling. The
  consequence to keep in mind: an `sbs` column/metric no longer determines its
  own data, the unit does. On the compare page that means `snapshotFor(column)`
  rather than `snapshots[entity]` at EVERY read (two were missed the first
  time, and a sub-unit silently showed the whole grouping's figure). In the
  combined charts it means one query per unit, not per source. The homepage
  picker renders the units as one `<select>` plus the shared SBS metric list
  rather than 15 × 89 flattened rows — that list is in the DOM once per chart
  on the page, so the difference is ~90 rows versus 1,335. `sbs-units.db` is
  loaded lazily everywhere: on first picker open, and only on the SBS monthly
  page.
- **Combined charts have three grains**: daily, weekly, monthly (`charts=`
  spec `d`/`w`/`m`). Weekly has no query of its own for the daily sources —
  `fetchCombinedWeekly` asks each for the window's days and sums them into
  Monday–Sunday weeks (`utils/weekRange.ts aggregateWeekly`), which is how all
  of them except SBS build their monthly figure too (SBS's month is the API's
  own period total, so an SBS week need not reconcile with it). A week with no
  figure on any day is a gap, a week summed from fewer days than it has had
  carries a "may be undercounted" note, and the week in progress is marked
  partial. The President's tally (`zelensky.*`) is the one weekly-only source —
  it is why the grain exists.
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
- **Tests**, three tiers, split by what a case actually needs:
  - `src/**/*.test.ts` (vitest, `npm test`): the app's pure logic — the
    homepage's `charts=` codec (`src/home/charts.ts`), the compare registry's
    value arithmetic, the date/window helpers, the EoD projection. Plain Node,
    no DOM, sub-second, so edge cases (delimiters in a name, a malformed spec,
    a settled day) cost a line each. A new pure helper belongs here.
  - `e2e/` (Playwright, `npm run test:e2e`): everything that needs the real
    thing — a DB loading, recharts sizing itself, an IntersectionObserver, the
    history stack. Uses synthetic fixtures, never `data/*.db`. Runs against
    an `e2e`-mode **build** served by `vite preview` (fixture DBs via a preview
    middleware in `vite.config.ts`), not the dev server — every test opens a
    fresh browser context, and re-fetching ~136 unbundled modules per page load
    took the suite 413 s against 243 s on the build. A dataset with no fixture fails to load there
    rather than quietly reading `data/`. Reach for it
    when the question is "does this reach the screen", not "is this the right
    number".
  - `scripts/*/test_ingest.py`: ingest tests for scripts that parse data from
    unstructered sources. Must always be run and updated when the parser is
    changed. Run them with `bash scripts/test_python.sh`, which runs
    **one pytest process per dataset directory**.

  The first two are also the rule for where logic lives: if an e2e test is
  asserting arithmetic, the arithmetic wants lifting out of the component.


## CI / deploy

The workflows, when each runs, how a parser fix reaches the data, what gets
uploaded and how findings surface: **[CI.md](CI.md)**. What is particular to
one ingest — its window, its inputs, its quirks — is in its README. The rules
that bite when changing code:

- **A parser fix: re-scrape or reparse.** A post the parser *dropped* was never
  stored, so only a re-scrape (the workflow's widen input) recovers it; one it
  *misread* is stored, and a re-scrape re-ingests identical text — only a
  reparse fixes it. Know which before dispatching anything.
- **Uploads are gated on `changed=`** where the ingest can tell — a new ingest
  should write it to `$GITHUB_OUTPUT` too, rather than overwrite a live R2
  object on every run.
- `python-tests.yml` and `node-tests.yml` run the Python suites and
  lint + vitest on push and PR; Playwright runs only in the pre-push hook.
- A daily Claude Code routine triages CI annotations
  (`.claude/skills/ci-triage/`): it fixes from the repo alone and must not
  ingest, reparse or mutate a dataset.

## Common commands

```sh
npm run dev          # local dev server (Vite, port from vite.config.ts)
npm run build        # production build → dist/
npm run lint         # eslint, zero-warnings
npm test             # vitest unit tests (src/**/*.test.ts) — fast, no browser
npm run test:watch   # the same, in watch mode
npm run test:e2e     # Playwright e2e (uses .env.e2e fixture DBs).
# Only run e2e tests that directly cover the area you are working in —
# `.githooks/pre-push` runs the whole suite (plus `npm test`) on every push,
# which is where the full sweep belongs. `git push --no-verify`, or
# SKIP_TESTS=1, skips it. `npm install` points core.hooksPath at .githooks;
# a hooksPath somebody has deliberately set elsewhere is left alone.

# Screenshot the compare page on the PRODUCTION DBs in data/ (starts its own
# dev server; --zoom/--theme/--scope/--full, see the file's header comment):
node scripts/screenshot_compare.mjs sbu-alfa:2026-07 sbu-alfa:2026-08

# What CI reported lately — failed steps plus every ingest annotation, grouped
# and deduped into one screenful. The daily triage routine's input; also the
# fastest way to answer "did last night's scrapes find anything". main only,
# since that is where every scheduled ingest runs; --all-branches to widen.
python3 scripts/ci_digest.py --hours 48

bash scripts/test_python.sh          # every ingest test suite (one pytest per dir)
bash scripts/test_python.sh scripts/rubikon   # …or just one

bash scripts/fetch_prod_dbs.sh sbs rubikon   # just these DBs (exact names)

# Python ingest scripts: see each scripts/<x>/README.md
pip install -r scripts/requirements.txt   # the devcontainer does this on create
bash scripts/setup_env.sh                 # npm + pip bootstrap for a fresh container

# npm's postinstall: copies sql.js + sql.js-httpvfs into public/vendor/ and
# points core.hooksPath at .githooks. Run it by hand wherever postinstall
# didn't — a new worktree or clone under `ignore-scripts=true` — and after
# upgrading either package. Without it every DB load fails ("Failed to load
# sql.js script"), and the whole e2e suite times out rather than failing fast.
node scripts/setup-dev.cjs
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
  the UI and `ann(level="notice")` for advisory ones. A finding **about source
  text** quotes it with `excerpt(text)` — so that it is potentially actionable
  even if you don't have the raw text that only exists in the authoritative
  `<name>.db` on R2. Checks that need the whole table rather than one record,
  are in a `check_db.py` next to the ingest.
- All DBs under `data/` are gitignored and pulled from R2 (see
  `scripts/fetch_prod_dbs.sh`, which reads URLs from `.env.production`). In
  dev, `data/*.db` is served by a vite middleware directly from the project
  root; in production the frontend reads from R2 via `VITE_*_DB_URL` env
  vars. Small DBs are fetched whole via sql.js; larger ones (GSUA attacks)
  are range-fetched via sql.js-httpvfs.
- **GSUA, RU MoD and CIT publish two objects each**: the authoritative
  `<name>.db` carrying the raw post text, and a stripped `<name>.app.db` that
  the frontend reads in production, built in CI by `scripts/build_app_db.py`
  (details in [CI.md](CI.md) and each README). `fetch_prod_dbs.sh` downloads
  both. **GSUA and RU MoD read the app copy in dev too**, so local range-fetch
  behaviour matches the deployed site — and there they drift **locally**: a
  reparse or ingest rewrites `<name>.db` and leaves the app copy alone, so dev
  keeps serving the old rows while the file they came from looks correct.
  Rebuild it with `scripts/build_app_db.py` (the command is in
  `fetch_prod_dbs.sh`) — not by re-running the fetch, which would overwrite the
  reparse with R2's copy. GSUA's app copy carries derived tables
  (`scripts/gsua/app_db.sql`) whose monthly ones must match their live SQL in
  `src/utils/gsuaSql.ts` — `gsuaSql.test.ts` holds them to it; change one,
  change both. **CIT reads the full DB in dev**, deliberately: it is a whole
  fetch, not a range fetch, so the app copy changes only the download size and
  using it locally would buy that same staleness trap for nothing.
