# CI

GitHub Actions in `.github/workflows/`. This file is what cuts across the
workflows — when each runs, how a parser fix reaches the data, what gets
uploaded, how findings surface. What is particular to one dataset (its source,
its parser, its quirks, why it runs when it does in detail) is in that
dataset's README, linked from the table.

## Ingest workflows

| Workflow | Dataset | Trigger | Widen on a manual run | Uploads |
|---|---|---|---|---|
| `update-db.yml` | SBS grouping total ([below](#sbs-update-dbyml)) | cron Worker, every :10/:25/:40/:55 UTC | `all_months`, `backfill_from_foosint` | every run |
| `update-sbs-units-db.yml` | SBS sub-units — [README](scripts/sbs_units/README.md) | 09:00 / 21:00 Kyiv | `all` | every run |
| `update-telegram-web-dbs.yml` | GSUA — [README](scripts/gsua/README.md); RU MoD — [README](scripts/ru_mod/README.md) | cron Worker, 09:10 / 23:10 Kyiv (GS reports ~08:00 / 22:00) | `gsua_lookback_days`, `rumod_lookback_days` (default 2) | GSUA: what changed; RU MoD: every run |
| `update-ru-losses-db.yml` | RU losses — [README](scripts/ru_losses/README.md) | cron Worker, 09:10 Kyiv | — (re-pulls everything) | every run |
| `update-missile-attacks-db.yml` | RU missile & UAV attacks — [README](scripts/missile_attacks/README.md) | 06:00 / 16:00 UTC | — (re-pulls everything) | every run (append-on-change) |
| `update-mediazona-db.yml` | Mediazona — [README](scripts/mediazona/README.md) | 07:00 UTC every 3rd day | — (re-pulls everything) | every run (append-on-change) |
| `update-sbu-alfa-db.yml` | SBU Alfa — [README](scripts/sbu_alfa/README.md) | 08:00 UTC, days 5–20 | `pages` (default 3) | `changed=true` |
| `update-rubikon-db.yml` | Rubikon — [README](scripts/rubikon/README.md) | 08:00 UTC, days 2–8 (posts the 3rd–4th) | `pages` (default 3) | `changed=true` |
| `update-ua-losses-db.yml` | UA losses — [README](scripts/ua_losses/README.md) | 07:00 UTC, 1st & 15th (re-released ~every 2 months) | — (re-pulls everything) | every run (append-on-change) |
| `update-cit-civilians-db.yml` | CIT — [README](scripts/cit_civilians/README.md) | 19:00 UTC (after the ~20:00 MSK post) and 07:00 UTC (late post / edit) | `pages` (default 4) | `changed=true` |
| `update-ua-losses-ru-mod-db.yml` | UA losses, RU MoD — [README](scripts/ua_losses_ru_mod/README.md) | 08:15 / 20:15 UTC | — | `changed=true` |
| `update-zelensky-weekly-db.yml` | President's weekly tally — [README](scripts/zelensky_weekly/README.md) | 20:00 Kyiv, Sat / Sun / Mon | `pages` | `changed=true` |
| `reparse-gsua-db.yml` | GSUA, manual | `since` (date or `all`), `dry_run` (on) | — | unless dry run |
| `reparse-sbu-alfa-db.yml` | SBU Alfa, manual | `dry_run` (on) | — | `changed=true` |

Every scheduled one can also be run by hand (`workflow_dispatch`). Kyiv times
are GitHub's IANA `timezone:` cron field, or matched in Kyiv time by the
Worker, so they follow DST.

### The cron Worker

`cloudflare/` is the `sbs-stats-cron` Worker: one cron trigger
(`wrangler.toml`, every :10/:25/:40/:55 UTC) whose `dispatchesFor()` in
`worker.ts` decides from the tick's Kyiv time what to dispatch — `update-db.yml`
every tick, the Telegram-web and RU-losses runs at the times above. It replaces
GitHub's scheduler for those workflows, which runs late and sometimes not at
all. Cloudflare crons are UTC-only, hence the matching in code.

Deployed by `deploy-cron-worker.yml` on a push to main touching `cloudflare/`,
or by hand; a PR only bundles it (`--dry-run`). It needs the
`CLOUDFLARE_WORKERS_API_TOKEN` secret (Workers Scripts: Edit), kept apart from
the R2-only `CLOUDFLARE_API_TOKEN`. The Worker's own `GH_TOKEN` is a Worker
secret that survives deploys — set it with `wrangler secret put`.

### SBS (`update-db.yml`)

The SBS grouping total has no README of its own (`scripts/fetch_and_update.py`).
One run at a time (`concurrency: sbs-db`): each run uploads the whole DB, so
overlapping runs would drop each other's hours. `all_months` bypasses the
10-day / 6-hour refresh thresholds. Hours a run never happened for (an expired
Cloudflare token, say) come back with `backfill_from_foosint`, which inserts
only the (date, hour) rows missing here from foosint/sbs-stats — same API, no
flight counts.

## A parser fix: re-scrape or reparse

Which one depends on what the bug did to the post:

- **Dropped it** — the parser rejected it, so it was never stored. Only a
  re-scrape recovers it: run the workflow by hand with its window widened
  (the "Widen" column above). Reparsing reads only stored rows, so it can't.
- **Misread it** — stored, but a field parsed wrong. A re-scrape re-ingests
  the identical text and changes nothing; the stored rows need re-parsing:
  `reparse-gsua-db.yml`, `reparse-sbu-alfa-db.yml`, or locally
  `ingest.py --reparse` (dry run; `--apply` writes) for Rubikon and CIT.
  SBU Alfa only ever reparses: its discovery skips URLs already stored, so a
  re-scan re-reads nothing, however wide.

The pipelines that re-pull their whole source every run (RU losses, UA losses,
missile attacks, Mediazona) need neither: a fix takes effect on the next run.

The reparse workflows are separate from the scheduled scrapes on purpose:
different trigger, different blast radius, and `dry_run` on by default.

The SBS sub-units' `all` is the one that can be urgent: the API keeps only
twelve monthly period slots per unit and re-points them yearly, so a month
nobody captured before it rolls out is gone for good —
`scripts/sbs_units/check_db.py` reports exactly that.

## Uploads

Every DB lives in R2 (bucket `russia-ukraine-war`); a run downloads it, adds to
it, and uploads it back — never rebuilt from what the source still shows.

- **Only when changed**, where the ingest can tell: the ones marked
  `changed=true` above write it to `$GITHUB_OUTPUT` and the upload is gated on
  it — most of their runs find nothing, and an upload overwrites a live object
  the frontend reads. GSUA gates each of its two objects on its own change
  (see its README). The append-on-change ones store nothing new for an
  unchanged source, but still upload.
- **App copies.** GSUA, RU MoD and CIT publish two objects: the authoritative
  `<name>.db` with the raw post text, and a stripped `<name>.app.db` the
  frontend reads, built in the same job by `scripts/build_app_db.py` from the
  same source, so they can't drift on R2. GSUA's also carries derived tables
  (`scripts/gsua/app_db.sql`).

## Findings and the triage routine

Ingests raise findings through `scripts/ingest_log.py` (see CLAUDE.md
Conventions); each job's last step, `scripts/annotate_log.py`, turns them into
GitHub annotations and a job-summary table, `if: always()` so a run that dies
still reports. Whole-table checks live in a `check_db.py` beside the ingest,
run as their own step.

Nothing in CI reads those annotations, so a daily Claude Code web Routine
does: `.claude/skills/ci-triage/SKILL.md` is its operating manual and
`routine-prompt.md` beside it is the scheduled message. It reads
`scripts/ci_digest.py --hours 48`, fixes what it can establish from the repo
alone, and files nothing it has already filed — fingerprints in PR bodies are
its only memory between runs. What it must NOT do is the important half: no
ingest, no reparse, no dataset mutation, no PR for a step that flaked once.

## Tests and deploy

- `python-tests.yml` — the ingest test suites (`scripts/test_python.sh`), when
  a `.py` under `scripts/` changed. On push to any branch AND on
  `pull_request`: a push matches its paths against that push alone, so a PR
  whose last commit is docs-only would show no checks at all, while a
  pull_request event matches the whole PR diff and runs against the merge
  commit. Installs pytest and `requests` and nothing else — `fetch_and_update.py`
  imports requests at module level and several suites reach it transitively,
  so leaving it out fails collection; the rest of `scripts/requirements.txt`
  is imported lazily. The scheduled ingests are not a substitute: they
  exercise whatever the source published today and stay green while a fixture
  case breaks.
- `node-tests.yml` — eslint plus the vitest tier, on push and `pull_request`
  (same reasoning) when `src/` or the build config changed. Not the Playwright
  tier, which is minutes per run for the tier least likely to catch a helper
  or parser regression; `.githooks/pre-push` runs that.
- `deploy.yml` — builds and publishes to GitHub Pages on a push to main
  touching the app.
