#!/usr/bin/env python3
"""
ingest.py — build mediazona.db from Mediazona/Meduza's two weekly CSV exports.

Source: Mediazona + Meduza's count of Russian war dead, published as periodic
articles (see scripts/mediazona/README.md). Two distinct weekly series:

  1. confirmed_losses_per_week.csv  — CONFIRMED, individually-NAMED deaths, broken
     down by branch/role. Bucketed by *date of death*; recent weeks are right-
     censored (deaths not yet identified). → table `weekly_roles`.

  2. probate_registry_estimate.csv  — the probate-registry-based estimate.
     Columns:
       real  — documented/named deaths by week (cumulative ≈ 217,808)
       rnd   — the "estimate of actual losses" topline (cum. ≈ 352,000)
     → table `weekly_estimate` (documented = real, estimate = rnd).

The two CSVs use different week anchors (roles = Thursday from war start;
estimate = Monday) and are different snapshots; the frontend charts them
separately. See README for the full data model.

APPEND-ONLY / EDIT-VERSIONED. Mirrors the ru_losses / gsua model. A stored row
is never mutated or deleted. Each row in either table is one *version* of that
week's numbers, tagged with `scraped_at` (ingest UTC) and `published_at` (the
Mediazona article's publication date — passed in via --published-at, analogous
to ru_losses' `reported_at`). On each run we compare fetched values against the
latest stored version per week and INSERT a NEW row only when they differ (or
the week is new). The frontend reads the latest snapshot per week.

This shape matters here: Mediazona publishes infrequently (the May-22-2026
article was the only public source at the time of writing) and revises prior
weeks each release as more probate filings complete. Append-versioned storage
preserves the full historical development across releases — a fresh release
ingested with --published-at 2026-11-DD will leave the May-22-2026 numbers
intact and add new rows where the values changed.

A row-count floor + a no-shrink guard abort the build (without writing) if the
fetch looks broken, so a partial/empty CSV leaves the DB untouched.

stdlib only (csv + sqlite3) — no extra dependencies.
"""

from __future__ import annotations

import argparse
import csv
import os
import re
import sqlite3
import sys
from datetime import date as date_cls, datetime, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_SOURCE = SCRIPT_DIR / "source"
DEFAULT_DB_NAME = os.environ.get("MEDIAZONA_DB_NAME", "mediazona.db")

# weekly_roles columns ← raw CSV headers. We store every role column verbatim
# (plus `total`) and leave grouping to the frontend (MEDIAZONA_ROLE_GROUPS in
# src/types/index.ts), so the bucketing can change without a re-ingest.
ROLE_COLS = [
    "total", "nguard", "rifle", "air", "pilot", "seaman", "marine", "tank",
    "art", "eng", "other", "nd", "special", "vol", "mob", "signal", "airdef",
    "chem", "pmc", "fsb", "groundavia", "inmates",
]

# A war that started 2022-02-24 yields ~200 weeks by 2026 — a healthy CSV has
# well over a year of rows. Far below this means a truncated/empty export.
MIN_ROWS_FLOOR = 100


def iso(ddmmyyyy: str) -> str:
    """'24.02.2022' → '2022-02-24'."""
    d, m, y = (int(x) for x in ddmmyyyy.strip().strip('"').split("."))
    return date_cls(y, m, d).isoformat()


def to_int(v: str) -> int | None:
    v = v.strip()
    return int(v) if v else None


def to_float(v: str) -> float | None:
    v = v.strip()
    return float(v) if v else None


def parse_roles(path: Path) -> list[tuple]:
    """Return [(week_iso, *ROLE_COLS values)]. Blank cells → 0 (meaningful 0 for a
    stacked composition). Rows whose `total` is blank (a not-yet-filled trailing
    week) are skipped entirely."""
    rows: list[tuple] = []
    with path.open(newline="", encoding="utf-8") as f:
        for rec in csv.DictReader(f):
            if not (rec.get("week_start") or "").strip():
                continue
            if not (rec.get("total") or "").strip():
                continue
            week = iso(rec["week_start"])
            vals = [to_int(rec.get(c, "")) or 0 for c in ROLE_COLS]
            rows.append((week, *vals))
    return rows


def parse_estimate(path: Path) -> list[tuple]:
    """Return [(week_iso, documented:int|None, estimate:float|None)] from the
    probate file's (week, real, rnd) columns. Rows with neither value are skipped."""
    rows: list[tuple] = []
    with path.open(newline="", encoding="utf-8") as f:
        for rec in csv.DictReader(f):
            if not (rec.get("week") or "").strip():
                continue
            documented = to_int(rec.get("real", ""))
            estimate = to_float(rec.get("rnd", ""))
            if documented is None and estimate is None:
                continue
            rows.append((iso(rec["week"]), documented, estimate))
    return rows


def build(
    db_path: Path,
    roles: list[tuple],
    estimate: list[tuple],
    scraped_at: str,
    published_at: str,
) -> tuple[dict, dict]:
    """Append changed/new week-versions into db_path. Never mutates/deletes rows.

    Returns (roles_summary, estimate_summary), each a dict with:
        new       — count of weeks not in DB before this run
        revised   — count of pre-existing weeks whose values differ from prior
        unchanged — count of pre-existing weeks whose values match prior (skipped)
        distinct  — total distinct weeks in the table after the run
    new + revised = number of rows actually inserted. Aborts (raises) without
    writing if either payload looks broken or would shrink an existing dataset.
    """
    # Guard 1: absolute floor.
    if len(roles) < MIN_ROWS_FLOOR:
        raise RuntimeError(
            f"roles CSV parsed only {len(roles)} weeks (< floor {MIN_ROWS_FLOOR}) — "
            f"refusing to write {db_path}; the export is probably truncated."
        )
    if len(estimate) < MIN_ROWS_FLOOR:
        raise RuntimeError(
            f"estimate CSV parsed only {len(estimate)} weeks (< floor {MIN_ROWS_FLOOR}) — "
            f"refusing to write {db_path}; the export is probably truncated."
        )

    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    try:
        role_cols_sql = ", ".join(f"{c} INTEGER NOT NULL DEFAULT 0" for c in ROLE_COLS)
        conn.executescript(
            f"""
            CREATE TABLE IF NOT EXISTS weekly_roles (
                week TEXT NOT NULL,
                scraped_at TEXT NOT NULL,
                published_at TEXT,
                {role_cols_sql},
                PRIMARY KEY (week, scraped_at)
            );
            CREATE TABLE IF NOT EXISTS weekly_estimate (
                week TEXT NOT NULL,
                scraped_at TEXT NOT NULL,
                published_at TEXT,
                documented INTEGER,
                estimate REAL,
                PRIMARY KEY (week, scraped_at)
            );
            """
        )

        # Latest stored version per week, for change detection. Mirrors
        # ru_losses' LATEST_PER_DATE pattern.
        role_metric_cols = ", ".join(ROLE_COLS)
        latest_roles = {
            r[0]: tuple(r[1:])
            for r in conn.execute(
                f"""
                SELECT d.week, {role_metric_cols}
                FROM weekly_roles d
                JOIN (SELECT week, MAX(scraped_at) AS ms FROM weekly_roles GROUP BY week) l
                  ON d.week = l.week AND d.scraped_at = l.ms
                """
            ).fetchall()
        }
        latest_estimate = {
            r[0]: (r[1], r[2])
            for r in conn.execute(
                """
                SELECT d.week, documented, estimate
                FROM weekly_estimate d
                JOIN (SELECT week, MAX(scraped_at) AS ms FROM weekly_estimate GROUP BY week) l
                  ON d.week = l.week AND d.scraped_at = l.ms
                """
            ).fetchall()
        }

        # Guard 2: shrink — a new export should never have fewer distinct weeks
        # than what's already stored. Catches a half-empty CSV that passed Guard 1.
        if len(roles) < len(latest_roles):
            raise RuntimeError(
                f"parsed {len(roles)} role-weeks but DB already has {len(latest_roles)} — "
                f"refusing to write a shrinking dataset into {db_path}."
            )
        if len(estimate) < len(latest_estimate):
            raise RuntimeError(
                f"parsed {len(estimate)} estimate-weeks but DB already has "
                f"{len(latest_estimate)} — refusing to write a shrinking dataset."
            )

        # Split the comparison into new vs revised vs unchanged so the CLI can
        # report a useful breakdown — a 200-row insert against an empty table
        # and a 200-row revision against a populated one look identical in a
        # single "inserted" counter, hiding both surprising backfills and the
        # cadence of Mediazona's revisions.
        roles_to_insert: list[list] = []
        roles_new = roles_revised = roles_unchanged = 0
        for week, *vals in roles:
            prior = latest_roles.get(week)
            if prior is None:
                roles_new += 1
                roles_to_insert.append([week, scraped_at, published_at, *vals])
            elif prior != tuple(vals):
                roles_revised += 1
                roles_to_insert.append([week, scraped_at, published_at, *vals])
            else:
                roles_unchanged += 1

        estimate_to_insert: list[list] = []
        est_new = est_revised = est_unchanged = 0
        for week, documented, estimate_val in estimate:
            prior = latest_estimate.get(week)
            if prior is None:
                est_new += 1
                estimate_to_insert.append([week, scraped_at, published_at, documented, estimate_val])
            elif prior != (documented, estimate_val):
                est_revised += 1
                estimate_to_insert.append([week, scraped_at, published_at, documented, estimate_val])
            else:
                est_unchanged += 1

        if roles_to_insert:
            ph = ", ".join(["?"] * (3 + len(ROLE_COLS)))
            cols = ", ".join(["week", "scraped_at", "published_at"] + ROLE_COLS)
            conn.executemany(
                f"INSERT INTO weekly_roles ({cols}) VALUES ({ph})",
                roles_to_insert,
            )
        if estimate_to_insert:
            conn.executemany(
                "INSERT INTO weekly_estimate "
                "(week, scraped_at, published_at, documented, estimate) "
                "VALUES (?, ?, ?, ?, ?)",
                estimate_to_insert,
            )
        if roles_to_insert or estimate_to_insert:
            conn.commit()
            conn.execute("VACUUM")
            conn.commit()

        roles_distinct = conn.execute("SELECT COUNT(DISTINCT week) FROM weekly_roles").fetchone()[0]
        est_distinct = conn.execute("SELECT COUNT(DISTINCT week) FROM weekly_estimate").fetchone()[0]
    finally:
        conn.close()
    return (
        {"new": roles_new, "revised": roles_revised, "unchanged": roles_unchanged, "distinct": roles_distinct},
        {"new": est_new, "revised": est_revised, "unchanged": est_unchanged, "distinct": est_distinct},
    )


def main() -> int:
    ap = argparse.ArgumentParser(description="Append-version mediazona.db from the two weekly CSV exports")
    ap.add_argument("--roles", default=str(DEFAULT_SOURCE / "confirmed_losses_per_week.csv"),
                    help="path to the confirmed-losses-by-role CSV")
    ap.add_argument("--estimate", default=str(DEFAULT_SOURCE / "probate_registry_estimate.csv"),
                    help="path to the probate-registry-estimate CSV")
    ap.add_argument("--published-at", required=True,
                    help="Mediazona article publication date (YYYY-MM-DD) — the source vintage these CSVs come from")
    ap.add_argument("--out", default=os.environ.get(
        "MEDIAZONA_DB_PATH", str(SCRIPT_DIR / "output" / DEFAULT_DB_NAME)),
        help="output SQLite path (default: scripts/mediazona/output/%s)" % DEFAULT_DB_NAME)
    args = ap.parse_args()

    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", args.published_at):
        raise SystemExit(f"--published-at must be YYYY-MM-DD, got {args.published_at!r}")

    scraped_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    roles = parse_roles(Path(args.roles))
    estimate = parse_estimate(Path(args.estimate))
    out = Path(args.out)
    r, e = build(out, roles, estimate, scraped_at, args.published_at)
    fmt = lambda s: (
        f"{s['new']:>4} new, {s['revised']:>4} revised, {s['unchanged']:>4} unchanged "
        f"-> {s['new'] + s['revised']} inserted; {s['distinct']} distinct weeks"
    )
    print(
        f"==> roles:    {fmt(r)}\n"
        f"==> estimate: {fmt(e)}\n"
        f"==> published_at={args.published_at}  scraped_at={scraped_at}\n"
        f"==> {out} ({out.stat().st_size} bytes)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
