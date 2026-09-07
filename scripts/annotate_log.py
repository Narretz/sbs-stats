#!/usr/bin/env python3
"""Turn an ingest run's JSONL diagnostics sink into GitHub annotations.

Reads the file `scripts/ingest_log.py` wrote during the run (see that module
for why the findings take a detour through a file instead of being printed as
workflow commands directly) and emits one annotation per distinct finding, plus
a rollup table in the job summary.

Run it as the last step of an ingest job, with `if: always()` so a failed
scrape still reports what it found before dying:

    - name: Annotate ingest diagnostics
      if: always()
      run: python3 scripts/annotate_log.py

Exits 0 even when the sink is missing, empty, or malformed. Diagnostics about
the data must never be the reason a data update fails — that would take the
site stale over a report the ingest handled correctly.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from collections import Counter, OrderedDict
from pathlib import Path

# GitHub renders only the first handful of annotations per level per step, then
# silently drops the rest. Cap deliberately and say so, rather than emitting
# 500 and letting the UI decide which 490 nobody sees.
DEFAULT_MAX_PER_LEVEL = 10

LEVELS = ("error", "warning", "notice")


def esc(text: str, prop: bool = False) -> str:
    """Percent-encode per GitHub's workflow-command rules.

    A workflow command is parsed as a single line, so an unescaped newline
    truncates the annotation at the break. Property values additionally
    delimit on ':' and ','.
    """
    text = text.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
    return text.replace(":", "%3A").replace(",", "%2C") if prop else text


def read_entries(path: Path) -> list[dict]:
    """Parse the sink. Malformed lines are skipped, not fatal — a half-written
    line from an interrupted run shouldn't cost us the findings around it."""
    entries = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(entry, dict) and entry.get("message"):
                entries.append(entry)
    return entries


def dedupe(entries: list[dict]) -> "OrderedDict[tuple, dict]":
    """Collapse identical findings, keeping first-seen order and a count.

    A parser gap fires once per affected post — 300 identical lines are one
    finding with a number attached, not 300 things to read.
    """
    out: "OrderedDict[tuple, dict]" = OrderedDict()
    for e in entries:
        key = (e.get("level"), e.get("title"), e.get("file"), e.get("message"))
        if key in out:
            out[key]["count"] += 1
        else:
            out[key] = {**e, "count": 1}
    return out


def emit(entry: dict) -> None:
    props = []
    if entry.get("file"):
        props.append(f"file={esc(str(entry['file']), prop=True)}")
        if entry.get("line"):
            props.append(f"line={entry['line']}")
    if entry.get("title"):
        props.append(f"title={esc(str(entry['title']), prop=True)}")
    message = entry["message"]
    if entry.get("count", 1) > 1:
        message = f"{message} (×{entry['count']})"
    level = entry.get("level") if entry.get("level") in LEVELS else "warning"
    print(f"::{level} {','.join(props)}::{esc(message)}")


def write_summary(shown: dict[str, int], totals: Counter, distinct: Counter) -> None:
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if not summary or not sum(totals.values()):
        return
    lines = [
        "### Ingest diagnostics",
        "",
        "| level | distinct | occurrences | annotated |",
        "| --- | --- | --- | --- |",
    ]
    for level in LEVELS:
        if not distinct[level]:
            continue
        capped = "" if shown[level] == distinct[level] else f" (of {distinct[level]})"
        lines.append(
            f"| {level} | {distinct[level]} | {totals[level]} | {shown[level]}{capped} |"
        )
    if any(shown[l] < distinct[l] for l in LEVELS):
        lines += ["", "Annotations are capped per level; the step log has every line."]
    with open(summary, "a", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument(
        "path",
        nargs="?",
        default=os.environ.get("INGEST_LOG"),
        help="JSONL sink to read (default: $INGEST_LOG).",
    )
    p.add_argument(
        "--max-per-level",
        type=int,
        default=DEFAULT_MAX_PER_LEVEL,
        help=f"Annotations to emit per level (default {DEFAULT_MAX_PER_LEVEL}).",
    )
    args = p.parse_args(argv)

    if not args.path:
        print("annotate_log: no sink path given and INGEST_LOG unset; nothing to do")
        return 0
    path = Path(args.path)
    if not path.exists():
        print(f"annotate_log: {path} not written (no findings); nothing to do")
        return 0

    findings = dedupe(read_entries(path))
    if not findings:
        print(f"annotate_log: {path} holds no findings")
        return 0

    totals: Counter = Counter()
    distinct: Counter = Counter()
    for e in findings.values():
        level = e.get("level") if e.get("level") in LEVELS else "warning"
        distinct[level] += 1
        totals[level] += e["count"]

    shown = {level: 0 for level in LEVELS}
    # Most severe first, so a cap eats notices before it eats errors.
    for level in LEVELS:
        for e in findings.values():
            if (e.get("level") if e.get("level") in LEVELS else "warning") != level:
                continue
            if shown[level] >= args.max_per_level:
                continue
            emit(e)
            shown[level] += 1

    write_summary(shown, totals, distinct)
    print(
        "annotate_log: "
        + ", ".join(
            f"{distinct[l]} distinct {l}(s) over {totals[l]} occurrence(s)"
            for l in LEVELS
            if distinct[l]
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
