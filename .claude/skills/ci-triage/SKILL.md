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

- **Its message tells a human to run something.** `ru-mod: half-covered days`
  and `days with no AD report` ask for `probe_gap.py` and `--mark-silent`. Those
  mutate a published dataset on judgement you do not have. Never run them. At
  most, keep one tracking issue.
- **It reports an expected state.** `sbs-units: unit has no monthly data`
  (1-cus) is what the source publishing nothing looks like; retirement is
  derived, never listed.
- **It only appears in `Reparse *` runs.** Those are manual backfills over
  years of history, human-initiated. The GSUA `combat_engagements` and
  `unfamiliar report hour` findings are real parser gaps, but they are not this
  routine's work and re-triaging them every time someone runs a reparse is
  noise. Skip unless asked.
- **Deciding needs data you cannot reach.** See below. File an issue that names
  the evidence gap; do not guess at a regex.

### What you cannot see

The environment's network policy allows `github.com`, `api.github.com`, npm and
PyPI. It **denies** R2 (`pub-*.r2.dev`), `t.me`, `sbs-group.army` and the Actions
log blob store. So you cannot download a DB, read a source post, or reproduce an
ingest end to end.

This matters most for findings about what a parser *read*, like
`gsua: missile-field asymmetry` — 7 dates in a fortnight, always
`missile_strikes` set and `missiles_used` empty, never the reverse. That
one-sidedness is suspicious, but confirming it needs the post text. Do not
invent a regex change to satisfy it. Either file an issue with the dates and the
asymmetry direction, or propose making the check carry a text excerpt in its
annotation so the evidence travels with the finding next time.

If a finding would be actionable with R2 access, say so explicitly in your
report — widening the allowed domains is the user's call to make.

## 5. Fix, validate, open one PR per finding class

- **One finding class per branch and PR.** Do not bundle. Do not widen the diff
  beyond what the finding needs.
- **Add a regression test that fails against the old code**, and say in the PR
  body that you checked it does. A test that passes either way documents
  nothing. Put it in the tier `CLAUDE.md` prescribes — a parser or check change
  belongs in `scripts/<dataset>/test_*.py`.
- **Validate before pushing:**
  ```sh
  bash scripts/test_python.sh scripts/<dataset>   # or with no argument, for all
  npm run lint && npm test                        # only if src/ changed
  ```
  If `pytest` or `node_modules` is missing, `bash scripts/setup_env.sh`.
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
