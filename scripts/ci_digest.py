#!/usr/bin/env python3
"""One compact digest of everything CI reported in a recent window.

Written for the daily triage routine (see `.claude/skills/ci-triage/SKILL.md`),
which has to answer "what did CI find, and is any of it actionable" without
reading 150 run pages. Run it, read the output, act on it:

    python3 scripts/ci_digest.py                 # last 48 hours, text
    python3 scripts/ci_digest.py --hours 24
    python3 scripts/ci_digest.py --json          # same data, machine-readable

Why a script and not "ask the GitHub MCP server". Three things it can't do:

  - There is no annotations tool. Annotations live at
    `/repos/{o}/{r}/check-runs/{id}/annotations`, where the check-run id IS the
    job id. Without them the only way to see an ingest finding is to read the
    job log, which is exactly what scripts/annotate_log.py exists to avoid.
  - `list_workflow_runs` has no time filter (actor / branch / event / status
    only). The REST API takes `created=>=<ISO8601>`, which matters here because
    the hourly SBS job is ~85% of all runs.
  - A single `list_workflow_runs` page of 40 runs is ~79k characters, over the
    tool-result limit. This script's whole output is a few hundred lines.

What it deliberately does NOT do: fetch job logs. It prints each failed job's id
instead, because the failing STEP NAME it already extracts settles most failures
without a log at all. When you do want one:

    curl -sL "https://api.github.com/repos/<repo>/actions/jobs/<job_id>/logs" -o /tmp/job.log
    grep -n '##\[error\]' /tmp/job.log

That needs `*.blob.core.windows.net` in the environment's allowed domains, since
the REST endpoint 302s to a signed URL there which expires in ~10 minutes — hence
`-L` in the same command. And grep rather than tail: `annotate_log.py` runs last
under `if: always()`, so the end of the file is post-job cleanup, not the error.

Auth: `GITHUB_TOKEN` / `GH_TOKEN` if set. Unset is fine wherever the
environment's proxy injects credentials (check with `--check-auth`); an
unauthenticated 60/hr is not enough for a 48-hour window.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

API = "https://api.github.com"
DEFAULT_REPO = "Narretz/sbs-stats"

# See list_runs for why this is not "every branch".
DEFAULT_BRANCH = "main"

# Annotation levels GitHub uses, most severe first.
LEVELS = ("failure", "warning", "notice")

# Parallel API calls. The window holds a few hundred jobs and each needs its own
# annotations request; 12 keeps it under a minute without tripping abuse limits.
WORKERS = 12

# Every finding routed through scripts/ingest_log.py carries a `title` (it
# defaults to the logger name), and nothing GitHub itself emits does. That one
# bit separates our data-quality findings from runner chatter — the
# `ubuntu-latest` migration notice alone was 456 of 650 annotations over a
# fortnight, and enumerating it every morning is how a panel gets ignored.
def is_ingest_finding(ann: dict) -> bool:
    return bool(ann.get("title"))


def _request(path: str, token: str | None) -> dict | list:
    req = urllib.request.Request(
        path if path.startswith("http") else API + path,
        headers={
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "sbs-stats-ci-digest",
            **({"Authorization": f"Bearer {token}"} if token else {}),
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def api(path: str, token: str | None) -> dict | list:
    """GET with the errors a triage run should survive rather than die on.

    A 404 on one job's annotations (logs expired, job never produced a check
    run) must not lose the other 200 findings, so callers get an empty result
    and the digest carries on.
    """
    try:
        return _request(path, token)
    except urllib.error.HTTPError as exc:
        if exc.code in (403, 429):
            print(
                f"ci_digest: {exc.code} from {path} — rate limited or forbidden. "
                "Set GITHUB_TOKEN.",
                file=sys.stderr,
            )
            raise
        return {}
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
        return {}


def list_runs(
    repo: str, since: datetime, token: str | None, branch: str | None = DEFAULT_BRANCH
) -> list[dict]:
    """Every run created at or after `since`, following pagination.

    Scoped to one branch by default, and `main` is the right default because the
    subject of this digest is the scheduled data pipeline: every ingest workflow
    runs on `schedule` or `workflow_dispatch`, and deploy on push to main, so
    main carries 100% of that signal.

    Sweeping every branch instead drags in the test workflows on everyone's
    feature branches — including this routine's own. Worse than noise: a failure
    on a branch whose head has since gone green still reads as a live failure.
    Measured over one 48-hour window, 2 of 9 failures were exactly that, both
    already fixed. A feature branch's red is its author's business; the routine's
    own PR checks reach it through the PR.
    """
    stamp = since.strftime("%Y-%m-%dT%H:%M:%SZ")
    scope = f"&branch={urllib.parse.quote(branch)}" if branch else ""
    runs: list[dict] = []
    page = 1
    while True:
        d = api(
            f"/repos/{repo}/actions/runs?per_page=100&page={page}"
            f"&created=%3E%3D{urllib.parse.quote(stamp)}{scope}",
            token,
        )
        batch = d.get("workflow_runs", []) if isinstance(d, dict) else []
        runs += batch
        if len(batch) < 100:
            return runs
        page += 1
        if page > 20:  # ~2000 runs; a window this wide isn't a daily digest
            print(
                "ci_digest: stopped paginating at 2000 runs; narrow --hours.",
                file=sys.stderr,
            )
            return runs


def shape(message: str) -> str:
    """Collapse a message to its shape, so N dated instances read as one kind."""
    return re.sub(r"\d", "#", message or "").strip()


def fingerprint(level: str, title: str, path: str) -> str:
    """Stable id for a finding class, for deduping against already-filed work.

    Keyed on the annotation's level, title and file — NOT its line number or
    message. The title is what `ann(title=…)` exists to set, so it is already
    the author's own grouping; the line moves whenever the file is edited, and
    the message carries the dates and counts that differ per occurrence. One
    fingerprint should mean one PR or issue.
    """
    return hashlib.sha1(f"{level}|{title}|{path}".encode()).hexdigest()[:8]


def collect(repo: str, runs: list[dict], token: str | None) -> tuple[list, list]:
    """Fetch jobs for every run, and annotations for every job.

    Annotations are fetched for successful runs too: a green ingest is the
    normal way a data-quality finding surfaces — the whole point of
    annotate_log.py is that a finding never fails the run.
    """
    def jobs_of(run: dict) -> tuple[dict, list[dict]]:
        d = api(f"/repos/{repo}/actions/runs/{run['id']}/jobs?per_page=50", token)
        return run, d.get("jobs", []) if isinstance(d, dict) else []

    with ThreadPoolExecutor(WORKERS) as pool:
        run_jobs = list(pool.map(jobs_of, runs))

    pairs = [(run, job) for run, jobs in run_jobs for job in jobs]

    def anns_of(pair: tuple[dict, dict]) -> tuple[dict, dict, list[dict]]:
        run, job = pair
        # The check-run id and the job id are the same number.
        d = api(f"/repos/{repo}/check-runs/{job['id']}/annotations?per_page=100", token)
        return run, job, d if isinstance(d, list) else []

    with ThreadPoolExecutor(WORKERS) as pool:
        annotated = list(pool.map(anns_of, pairs))

    failures = []
    for run, job in pairs:
        if job.get("conclusion") in (None, "success", "skipped"):
            continue
        failures.append(
            {
                "workflow": run["name"],
                "job": job["name"],
                "job_id": job["id"],
                "conclusion": job["conclusion"],
                "started_at": job.get("started_at"),
                "branch": run.get("head_branch"),
                "event": run.get("event"),
                "run_url": run["html_url"],
                "failed_steps": [
                    s["name"]
                    for s in job.get("steps") or []
                    if s.get("conclusion") == "failure"
                ],
            }
        )

    annotations = []
    for run, job, anns in annotated:
        for a in anns:
            annotations.append(
                {
                    "workflow": run["name"],
                    "job": job["name"],
                    "job_id": job["id"],
                    "run_url": run["html_url"],
                    "event": run.get("event"),
                    "level": a.get("annotation_level") or "warning",
                    "title": a.get("title") or "",
                    "message": a.get("message") or "",
                    "path": a.get("path") or "",
                    "line": a.get("start_line"),
                }
            )
    return failures, annotations


def group_findings(annotations: list[dict]) -> list[dict]:
    """One entry per finding class, most severe and most frequent first."""
    buckets: dict[tuple, dict] = {}
    for a in annotations:
        if not is_ingest_finding(a):
            continue
        key = (a["level"], a["title"], a["path"])
        b = buckets.setdefault(
            key,
            {
                "fingerprint": fingerprint(*key),
                "level": a["level"],
                "title": a["title"],
                "path": a["path"],
                "lines": set(),
                "workflows": set(),
                "events": set(),
                "occurrences": 0,
                "shapes": Counter(),
                "examples": [],
                "run_urls": set(),
            },
        )
        b["occurrences"] += 1
        b["lines"].add(a["line"])
        b["workflows"].add(a["workflow"])
        b["events"].add(a["event"])
        b["shapes"][shape(a["message"])] += 1
        b["run_urls"].add(a["run_url"])
        if a["message"] not in b["examples"] and len(b["examples"]) < 3:
            b["examples"].append(a["message"])

    out = []
    for b in buckets.values():
        out.append(
            {
                **b,
                "lines": sorted(x for x in b["lines"] if x),
                "workflows": sorted(b["workflows"]),
                "events": sorted(e for e in b["events"] if e),
                "distinct_shapes": len(b["shapes"]),
                "shapes": None,
                "run_urls": sorted(b["run_urls"])[:3],
            }
        )
    out.sort(key=lambda b: (LEVELS.index(b["level"]) if b["level"] in LEVELS else 9,
                            -b["occurrences"]))
    return out


def untitled_summary(annotations: list[dict]) -> list[dict]:
    """Runner chatter, counted but never enumerated."""
    c = Counter(
        (a["level"], shape(a["message"])[:80])
        for a in annotations
        if not is_ingest_finding(a)
    )
    return [
        {"level": lvl, "message": msg, "occurrences": n}
        for (lvl, msg), n in c.most_common()
    ]


def build(
    repo: str, hours: int, token: str | None, branch: str | None = DEFAULT_BRANCH
) -> dict:
    since = datetime.now(timezone.utc) - timedelta(hours=hours)
    runs = list_runs(repo, since, token, branch)
    failures, annotations = collect(repo, runs, token)

    by_workflow = Counter(r["name"] for r in runs)
    concl = Counter(r["conclusion"] or "in_progress" for r in runs)

    # Same step failing repeatedly inside one window is the difference between
    # a bug and flake — the cheapest version of that signal, with no history.
    step_rate: dict[str, dict] = defaultdict(lambda: {"failed": 0, "runs": 0})
    for f in failures:
        for step in f["failed_steps"] or ["(no step attributed)"]:
            step_rate[f"{f['workflow']} › {step}"]["failed"] += 1
    for key in step_rate:
        wf = key.split(" › ")[0]
        step_rate[key]["runs"] = by_workflow.get(wf, 0)

    return {
        "repo": repo,
        "window_hours": hours,
        "branch": branch or "(all branches)",
        "since": since.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "runs_total": len(runs),
        "runs_by_workflow": dict(by_workflow.most_common()),
        "runs_by_conclusion": dict(concl.most_common()),
        "failures": failures,
        "failed_step_rate": {
            k: v for k, v in sorted(step_rate.items(), key=lambda kv: -kv[1]["failed"])
        },
        "findings": group_findings(annotations),
        "runner_noise": untitled_summary(annotations),
    }


def render(d: dict) -> str:
    L = [
        f"CI digest — {d['repo']} [{d['branch']}], last {d['window_hours']}h "
        f"(since {d['since']}, generated {d['generated_at']})",
        f"{d['runs_total']} runs: "
        + ", ".join(f"{n} {k}" for k, n in d["runs_by_conclusion"].items()),
        "",
    ]

    L.append(f"## Failures ({len(d['failures'])})")
    if not d["failures"]:
        L.append("None.")
    for f in d["failures"]:
        steps = ", ".join(f["failed_steps"]) or "(none attributed)"
        L.append(
            f"- {f['started_at']}  {f['workflow']} › {f['job']}  [{f['event']}"
            f"{'/' + f['branch'] if f['branch'] else ''}]"
        )
        L.append(f"    failed step: {steps}")
        L.append(f"    {f['run_url']}   job_id={f['job_id']} (see module docstring for the log)")
    if d["failed_step_rate"]:
        L += ["", "Failure rate within this window (same step, same workflow):"]
        for key, v in d["failed_step_rate"].items():
            L.append(f"  {v['failed']}/{v['runs']} runs  {key}")
        L.append(
            "  A step failing once in many runs of the same workflow is usually"
        )
        L.append(
            "  transient; repeated failures of the same step are the code's."
        )

    L += ["", f"## Ingest findings ({len(d['findings'])} classes)"]
    if not d["findings"]:
        L.append("None.")
    for b in d["findings"]:
        anchor = b["path"] or "(no file)"
        if b["lines"]:
            anchor += ":" + ",".join(str(x) for x in b["lines"])
        L.append(
            f"- [{b['fingerprint']}] {b['level'].upper()}  {b['title'] or '(untitled)'}"
        )
        L.append(
            f"    {b['occurrences']} occurrence(s), {b['distinct_shapes']} distinct "
            f"message shape(s) — {anchor}"
        )
        L.append(f"    from: {', '.join(b['workflows'])} ({', '.join(b['events'])})")
        for ex in b["examples"]:
            L.append(f"    · {ex}")
        L.append(f"    {b['run_urls'][0] if b['run_urls'] else ''}")
        # A bare dataset name means the call site never passed ann(title=…), so
        # unrelated findings in one file share a fingerprint. Worth fixing at
        # the source rather than working around here.
        if ":" not in b["title"] and b["distinct_shapes"] > 1:
            L.append(
                f"    NOTE: untitled call site — {b['distinct_shapes']} unrelated "
                "findings share this fingerprint. Consider ann(title=…) there."
            )

    if d["runner_noise"]:
        total = sum(x["occurrences"] for x in d["runner_noise"])
        L += ["", f"## Runner noise ({total} annotations, not ours)"]
        for x in d["runner_noise"][:6]:
            L.append(f"  {x['occurrences']:5d}  {x['level']}: {x['message']}")

    return "\n".join(L)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--repo", default=os.environ.get("GITHUB_REPOSITORY", DEFAULT_REPO),
                   help=f"owner/name (default {DEFAULT_REPO}).")
    p.add_argument("--hours", type=int, default=48,
                   help="Window size in hours (default 48 — one day's overlap, so "
                        "a skipped run or a job still in flight is seen next time).")
    p.add_argument("--branch", default=DEFAULT_BRANCH,
                   help=f"Branch to report on (default {DEFAULT_BRANCH}) — see "
                        "list_runs for why that is not every branch.")
    p.add_argument("--all-branches", action="store_true",
                   help="Report on every branch. Includes feature branches whose "
                        "head may since have gone green, so read the branch on "
                        "each failure before acting.")
    p.add_argument("--json", action="store_true", help="Emit JSON instead of text.")
    p.add_argument("--check-auth", action="store_true",
                   help="Report the API rate limit and exit.")
    args = p.parse_args(argv)

    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")

    if args.check_auth:
        d = api("/rate_limit", token)
        core = (d.get("resources", {}) or {}).get("core", {})
        limit = core.get("limit", 0)
        print(f"rate limit: {core.get('remaining')}/{limit}"
              f" ({'authenticated' if limit > 60 else 'UNAUTHENTICATED'},"
              f" token {'set' if token else 'unset'})")
        return 0 if limit > 60 else 1

    d = build(args.repo, args.hours, token, None if args.all_branches else args.branch)
    print(json.dumps(d, indent=1) if args.json else render(d))
    return 0


if __name__ == "__main__":
    sys.exit(main())
