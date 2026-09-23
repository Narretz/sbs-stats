---
name: ci-triage
description: Triage this repo's CI — failed jobs and ingest annotations from the last 48 hours — and fix what is actionable. Use when running the daily CI review routine, or when asked what CI has found lately, whether last night's scrapes reported anything, or to look into a failing scheduled workflow.
---

# Daily CI triage

The scheduled ingests report data-quality findings as GitHub annotations (see
`scripts/ingest_log.py` and `scripts/annotate_log.py`) and nobody reads them.
This turns that panel into fixes.

Deciding **not** to act is a real outcome here, and the common one. A routine
that opens a PR every morning to keep busy is worse than one that says "nothing
actionable" for a week.

## 1. Dedup before anything else

You have no memory of yesterday's run. **Before reading the digest**, list the
open PRs and the last ~20 issues (open and closed) and collect every
`ci-triage-fingerprint:` marker in their bodies. Any finding class whose
fingerprint is already filed is **done** — do not reopen it, do not open a
second PR, do not comment. Skip it silently.

Skipping this step is how this routine turns into a spam bot: the `sbs-units:
large revision` class fired 36 times in a fortnight for one bug, and
`gsua: missile-field asymmetry` 51 times for 7 dates.

## 2. Read the digest

```sh
python3 scripts/ci_digest.py --hours 48
```

48 hours, not 24: a day of overlap means a skipped run, or a job still in flight
when the routine fired, is picked up next time instead of lost. Duplicates are
handled by step 1, so overlap is free.

If `--check-auth` reports UNAUTHENTICATED, stop and say so — 60 requests/hour
cannot cover the window.

## 3. Triage failures

The digest names the **failing step** for each failed job and its failure rate
within the window. Use the rate:

- **One failure across many runs of the same workflow** — transient. The
  `Upload DB to rolling latest release` step fails a few times per thousand runs
  with assorted `HTTP 404` / `HTTP 500` from the GitHub release API. Leave it
  alone. Do not "harden" a step because it flaked once.
- **The same step failing repeatedly, or a cluster in one morning** — real. Root
  cause it. Read the log via the MCP server's `get_job_logs` with
  `tail_lines: 120` or more; a small tail shows post-job cleanup, because
  `annotate_log` runs last under `if: always()`.
- **An ingest script dying mid-run** — always worth a look, because an
  interrupted run uploads nothing. The sub-units ingest died on an unhandled
  `429` from the SBS API, and per `CLAUDE.md` a sub-unit month that rolls out of
  the API's twelve-slot window is unrecoverable. That class of crash is the
  highest-value thing this routine can catch.

## 4. Triage ingest findings

A finding is **actionable** when you can establish it from the repository alone:

- **It contradicts the code's own stated intent.** The strongest signal there
  is. `check_db.py`'s revision check said "a closed month whose total moved" in
  its comment and had no month filter in its SQL — so it fired on the
  in-progress month only. Read the comment and the predicate against each other.
- **It fires on 100% of one case and 0% of the complement.** A check that never
  once fires the other way is describing its own bug, not the data.
- **A crash, a swallowed exception, or a missing retry** on a path where losing
  the run loses data.

A finding is **not actionable** when:

- **Acting on it would mutate a published dataset.** `ru-mod: half-covered days`
  and `days with no AD report` end in `--mark-silent`, which records a human's
  judgement that the MoD really was silent. Never run it. But do not write the
  whole finding off either: "no row" also covers a gate that wrongly rejected a
  real post, and that half IS yours to fix — see **Getting at the evidence**.
- **It reports an expected state.** `sbs-units: unit has no monthly data`
  (1-cus) is what the source publishing nothing looks like; retirement is
  derived, never listed.
- **It is the runner's own chatter.** The `ubuntu-latest` → Ubuntu 26 migration
  notice was 456 of 650 annotations over a fortnight. Pinning the runner has
  been considered and declined: `ubuntu-latest` auto-migrates, which is what we
  want long-term, and pinning trades that for 15 lines to bump by hand plus an
  all-at-once break when the pinned image retires. Do not re-propose it.
  Untitled annotations are already bucketed as noise by the digest, so this
  costs the panel nothing.
- **It only appears in `Reparse *` runs.** Those are manual backfills over
  years of history, human-initiated. The GSUA `combat_engagements` and
  `unfamiliar report hour` findings are real parser gaps, but they are not this
  routine's work and re-triaging them every time someone runs a reparse is
  noise. Skip unless asked.
- **Deciding needs data you cannot reach.** See below. File an issue that names
  the evidence gap; do not guess at a regex.

### Getting at the evidence

Many findings are about text a parser read, or about a report that should exist
and doesn't. Neither can be judged from the repository alone.

**Download only what the task in front of you needs.** Never run
`scripts/fetch_prod_dbs.sh` — it pulls every DB in `.env.production`, both
variants, including the full GSUA attacks DB that production range-fetches
precisely because of its size. On a routine whose usual answer is "nothing
actionable" that is a lot of bytes for nothing. Take the single URL for the one
dataset you are investigating, and only once you have a finding worth chasing.

**Text a parser misread** — the authoritative `<name>.db` on R2 carries the raw
text; the `.app.db` the frontend reads has it blanked. Pull the full one, find
the wording no branch reads, fix it, run that dataset's suite, then verify with
the dataset's reparse in DRY-RUN — `scripts/gsua/reparse.py`, or
`scripts/rubikon/ingest.py --reparse`, or `scripts/sbu_alfa/ingest.py
--reparse`, never `--apply`. The per-counter diff it prints belongs in the PR
body. Many checks now quote the offending text in the annotation itself (see
`ingest_log.excerpt`), so read the digest before downloading anything — the
evidence may already be in front of you.

**A report that should exist and doesn't** — `ru-mod: days with no AD report`
and `half-covered days`. "No row" means either the MoD posted nothing or a gate
rejected what it posted, and only the source tells those apart:

```sh
python3 scripts/ru_mod/probe_gap.py --dates 2026-09-21 --full
```

That is `--source web` by default — the same t.me/s preview the scheduled ingest
reads, stdlib only, no Telegram account — and `--full` prints each post with the
reason `parse_report` dropped it. Read the exit code: **2 means the walk ran out
of pages before reaching your dates**, so the window was not covered and absence
proves nothing. Raise `--max-pages`, or accept that an older window needs
`--source telethon` (`TELEGRAM_API_ID` / `TELEGRAM_API_HASH`, which this
environment does not carry — say so and stop). `--ids` is telethon-only.

A post the probe shows as `-- MISSED` while its text is plainly an AD report is
a gate bug, and fixing it is squarely yours.

Finding a gate that wrongly rejected a real post is a fix worth making. Finding
that the MoD was genuinely silent is NOT yours to record: `--mark-silent` writes
to a published dataset. Report it and let a human mark it.

**A post the scrape dropped entirely** is not fixable from here either. A
reparse cannot recover it — it was never stored — and the only remedy is a
widened-lookback re-scrape, which is a `workflow_dispatch` that writes to R2.
Say what you found and leave the run to a human.

If a finding would be actionable with access this environment lacks, say which
host or credential, explicitly, in your report.

## 5. Fix, validate, open one PR per finding class

- **One finding class per branch and PR.** Do not bundle. Do not widen the diff
  beyond what the finding needs.
- **Add a regression test that fails against the old code**, and say in the PR
  body that you checked it does. A test that passes either way documents
  nothing. Put it in the tier `CLAUDE.md` prescribes — a parser or check change
  belongs in `scripts/<dataset>/test_*.py`.
- **Validate before pushing.** This Routine's environment runs no setup script:
  the usual outcome is "nothing actionable", so paying for a full bootstrap on
  every firing would be waste. Install only what the fix you are making needs.

  For a Python or ingest change — `pytest` and `requests` are the complete set,
  verified by running all ten suites with openpyxl, telethon, playwright and
  python-dotenv blocked at import:
  ```sh
  pip install "pytest>=8.0.0" "requests>=2.31.0"
  bash scripts/test_python.sh scripts/<dataset>   # or with no argument, for all
  ```
  For a change under `src/`:
  ```sh
  npm ci && npm run lint && npm test
  ```
  `bash scripts/setup_env.sh` does both plus telethon and playwright — minutes
  of downloading a browser that no tier you can run here uses. Reach for it only
  if something actually turns out to need it.
- **Put the fingerprint in the PR body** so tomorrow's run skips it:
  ```
  <!-- ci-triage-fingerprint: 642698a9 -->
  ```
  Include one line per fingerprint if a single fix genuinely closes several.
- Quote the finding's own annotation text and its occurrence count in the PR
  body. The reviewer should not have to go and find it.

### Never

- Skip, disable, or `xfail` a test to make something pass.
- Run an ingest, a reparse, or any `workflow_dispatch` that writes to R2 or to a
  published DB. Widening a lookback and re-scraping is a human decision.
- Mutate a dataset — no `--mark-silent`, no `--apply`, no `reparse --apply`.
- Commit anything under `data/`.
- Open a PR for a finding class that already has one.

## 6. Report back

End with a short summary, in this shape:

- how many runs, failures and finding classes were in the window;
- what you skipped as already-filed, in one line;
- what you judged transient or expected, in one line each — with the reason;
- PRs opened, with links;
- anything blocked on data you cannot reach, or on a decision that is the user's.

If nothing was actionable, say exactly that and stop. It is the expected
outcome most days.
