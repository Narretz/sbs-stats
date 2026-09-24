# The daily Routine prompt

This is the message the scheduled Routine sends. It fires a **fresh session**
each day, so it has to stand alone — no memory of yesterday, which is exactly
why step 1 of the skill is deduplication.

Kept here so it is version-controlled and editable alongside the rules it points
at. To change the schedule or the text, update the Routine in the Claude Code
web UI (or via `update_trigger`) *and* update this file, or they drift.

Live as `trig_01CVbrB1ujC536cLgUkeyWK9` — Routine "RU UA Stats Daily CI triage",
`30 7 * * *` UTC, environment `SBS CI Check Read`
(`env_01NobDKJmfFABF8Y1eVzW6Cs`), fresh session per firing, model
`claude-opus-5-5`, email notifications. Change the prompt with
`update_trigger` and edit this file in the same breath.

Schedule: `30 7 * * *` UTC — after the 08:00 Europe/Kyiv Telegram-web
scrape and the 06:00–08:00 UTC daily ingests have landed, so the window covers a
full set of overnight runs.

---

```
Run the daily CI triage for this repository.

Use the `ci-triage` skill and follow it exactly. If it is not listed, read
`.claude/skills/ci-triage/SKILL.md` and follow that. If neither exists on this
checkout say exactly that and stop, do not improvise a triage.

The shape of it: dedup against `ci-triage-fingerprint` markers already in open
PRs and recent issues BEFORE anything else, then `python3 scripts/ci_digest.py
--hours 48`, then triage the failed steps and the ingest finding classes. Open
one PR per actionable finding class, on a branch named
`claude/ci-triage-<YYYY-MM-DD>`, each with a regression test you have confirmed
fails against the old code.

This environment runs no setup script, so install only what a fix you are
actually making needs — the skill says which.

Most days nothing is actionable: a transient flake, a notice describing expected
state, a finding whose evidence you cannot reach. When that is the case, report
it in a few lines and stop. Do not open a PR in order to have something to show,
and do not re-file anything already filed.

Never push to main, never run an ingest workflow or a reparse workflow, never
mutate a published dataset (no `--mark-silent`, no `--apply`), never commit
anything under `data/`.
```
