#!/usr/bin/env python3
"""
check_db.py
-----------
Whole-table checks for data/sbs-units.db, run after the ingest.

The ingest can only see one payload at a time, so anything that needs the shape
of the table — a unit that has quietly stopped reporting, a month nobody
captured before it rolled out of the API's window — belongs here rather than as
inline SQL in the workflow.

    python3 scripts/sbs_units/check_db.py [--db data/sbs-units.db]
"""
from __future__ import annotations

import argparse
import os
import sqlite3
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR.parent) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR.parent))

from ingest_log import ann, get_logger  # noqa: E402

log = get_logger("sbs-units")

DB_PATH = os.environ.get("SBS_UNITS_DB_PATH", "data/sbs-units.db")

# How far a unit's newest daily row may lag before it's worth a look. Two days
# covers a missed run plus the fact that `prev_day` is always a day behind.
DAILY_STALE_DAYS = 3

# A closed month whose stored total moves by more than this is worth reading;
# anything smaller is the source's routine revision noise. Measured on the USF
# series, where closed months drift by single digits in both directions
# (2026-01 fell by 3, 2026-04 rose by 4) — a check that fired on those would
# cry wolf every run.
REVISION_PCT = 1.0


def _rows(conn, sql, *params):
    return conn.execute(sql, params).fetchall()


def check(conn: sqlite3.Connection, today: date) -> int:
    findings = 0

    units = _rows(conn, "SELECT slug, title_en, active, first_month, last_month FROM units")
    if not units:
        log.warning("units table is empty — the ingest never ran or discovery failed.",
                    extra=ann(title="sbs-units: no units"))
        return 1

    tracked = [u for u in units if u[3]]  # has at least one monthly period

    # ── A unit that has stopped producing rows ───────────────────────────────
    for slug, title, active, first_month, _ in tracked:
        if not active:
            continue
        newest = _rows(conn, "SELECT MAX(date) FROM unit_daily_stats WHERE unit_slug = ?", slug)
        newest = newest[0][0] if newest else None
        if newest is None:
            # Expected on the first runs after switch-on, since daily has no
            # backfill — but not expected to persist.
            log.warning(
                f"{slug} ({title}) is active but has no daily rows yet.",
                extra=ann(level="notice", title="sbs-units: no daily rows"),
            )
            findings += 1
            continue
        lag = (today - date.fromisoformat(newest)).days
        if lag > DAILY_STALE_DAYS:
            log.warning(
                f"{slug} ({title}): newest daily row is {newest} ({lag} days "
                "old). Either the unit stopped reporting or the ingest has been "
                "failing for it.",
                extra=ann(title="sbs-units: daily series stalled"),
            )
            findings += 1

    # ── A month the API offers that we never captured ────────────────────────
    # This is the one that cannot be fixed later: the monthly slots hold twelve
    # months and are re-pointed every year, so a month missed here is gone for
    # good once it rolls out.
    for slug, title, _, first_month, last_month in tracked:
        stored = {r[0][:7] for r in _rows(
            conn, "SELECT DISTINCT date FROM unit_monthly_stats WHERE unit_slug = ?", slug)}
        wanted = set()
        y, m = map(int, first_month.split("-"))
        end_y, end_m = map(int, last_month.split("-"))
        while (y, m) <= (end_y, end_m):
            wanted.add(f"{y:04d}-{m:02d}")
            y, m = (y + 1, 1) if m == 12 else (y, m + 1)
        missing = sorted(wanted - stored)
        if missing:
            log.warning(
                f"{slug} ({title}): the API lists {len(missing)} month(s) with "
                f"no stored row — {', '.join(missing)}. Run "
                "`ingest.py --all` NOW; a month that rolls out of the API's "
                "twelve-slot window is unrecoverable.",
                extra=ann(title="sbs-units: uncaptured month"),
            )
            findings += 1

    # ── A closed month whose total moved materially ──────────────────────────
    for slug, date_, old, new in _rows(conn, """
        SELECT a.unit_slug, a.date, a.total_targets_hit, b.total_targets_hit
        FROM unit_monthly_stats a
        JOIN unit_monthly_stats b
          ON b.unit_slug = a.unit_slug AND b.date = a.date
         AND b.capture_bucket = (SELECT MAX(capture_bucket) FROM unit_monthly_stats
                                  WHERE unit_slug = a.unit_slug AND date = a.date)
        WHERE a.capture_bucket = (SELECT MIN(capture_bucket) FROM unit_monthly_stats
                                   WHERE unit_slug = a.unit_slug AND date = a.date)
          AND a.total_targets_hit IS NOT NULL AND b.total_targets_hit IS NOT NULL
          AND a.total_targets_hit > 0
    """):
        pct = 100.0 * (new - old) / old
        if abs(pct) >= REVISION_PCT:
            log.warning(
                f"{slug} {date_[:7]}: targets hit revised {old} -> {new} "
                f"({pct:+.1f}%) after first capture.",
                extra=ann(level="notice", title="sbs-units: large revision"),
            )
            findings += 1

    print(f"check_db: {findings} finding(s) across {len(tracked)} tracked unit(s)")
    return findings


def main() -> None:
    p = argparse.ArgumentParser(description="Whole-table checks for sbs-units.db")
    p.add_argument("--db", default=DB_PATH)
    args = p.parse_args()
    conn = sqlite3.connect(args.db)
    try:
        check(conn, datetime.now(timezone.utc).date())
    finally:
        conn.close()


if __name__ == "__main__":
    main()
