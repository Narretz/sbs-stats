#!/usr/bin/env python3
"""Post-ingest data-quality checks over the CIT civilians DB.

These are the checks that need the whole table rather than one post, so they
can't live in ingest.py's per-post warnings. Findings go through the shared
logger, so the same run that prints them to stderr locally turns them into
GitHub annotations in Actions (CLAUDE.md: never hand-roll `::warning`).

    python3 check_db.py --db data/cit-civilians.db --since 2026-09-01
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from ingest_log import ann, get_logger  # noqa: E402

log = get_logger("cit-civilians")


def check_day_coverage(conn: sqlite3.Connection, since: str) -> int:
    """Flag calendar days no report covers.

    A weekday post covers one day and a weekend post covers two, so coverage
    is not "one row per day" — it's the union of the windows. A genuine gap
    means CIT skipped a day or the scrape missed a post, and a missing day is
    the one failure a casualty chart cannot paper over.
    """
    rows = conn.execute(
        "SELECT report_date, window_days FROM reports_latest "
        "WHERE report_date >= ? ORDER BY report_date", (since,)).fetchall()
    if not rows:
        log.warning("no reports at or after %s", since,
                    extra=ann(title="CIT: no reports in the checked window"))
        return 1
    covered: set[date] = set()
    for report_date, window_days in rows:
        end = date.fromisoformat(report_date)
        for back in range(window_days):
            covered.add(end - timedelta(days=back))
    first, last = min(covered), max(covered)
    missing = [first + timedelta(days=n)
               for n in range((last - first).days + 1)
               if first + timedelta(days=n) not in covered]
    if missing:
        log.warning(
            "%d day(s) between %s and %s are covered by no report: %s. CIT may "
            "have skipped them, or the scrape missed a post — a wider "
            "--max-pages re-run is the only way to recover one that was never "
            "stored.", len(missing), first, last,
            ", ".join(d.isoformat() for d in missing[:20]),
            extra=ann(title="CIT: gap in day coverage"))
    return len(missing)


def check_reconciliation(conn: sqlite3.Connection, since: str) -> int:
    """Report how often the regional breakdown matches the post's own total.

    A NOTICE, not a warning: the headline figures are stored regardless and are
    what the charts plot, and the rate is expected to sit near 60% because the
    older prose format is genuinely harder to read — and because CIT's own
    arithmetic sometimes differs from its own breakdown. It is worth watching
    for a sudden drop, which would mean the format changed.
    """
    row = conn.execute(
        "SELECT COUNT(*), SUM(reconciled) FROM reports_latest "
        "WHERE report_date >= ? AND reconciled IS NOT NULL", (since,)).fetchone()
    total, ok = row[0], row[1] or 0
    if not total:
        return 0
    pct = 100.0 * ok / total
    log.warning(
        "regional breakdown reconciles with the post's own total on %d of %d "
        "reports since %s (%.0f%%); the stated headline figures are unaffected",
        ok, total, since, pct,
        extra=ann(level="notice", title="CIT: reconciliation rate"))
    return total - ok


def check_negative_days(conn: sqlite3.Connection, since: str) -> int:
    """Flag days whose revised total went negative.

    Only an adjustment can push a day below zero, and that means we subtracted
    someone who was never added — typically a retraction or a died-of-wounds
    −1 naming a date that predates the backfill.
    """
    rows = conn.execute(
        "SELECT event_date, killed, injured FROM daily_revised "
        "WHERE event_date >= ? AND (killed < 0 OR injured < 0)", (since,)).fetchall()
    for event_date, killed, injured in rows:
        log.warning(
            "revised totals for %s are negative (%d killed, %d injured) — a "
            "correction subtracted casualties that were never recorded, most "
            "likely because the original report predates this DB",
            event_date, killed, injured,
            extra=ann(title="CIT: negative revised total"))
    return len(rows)


def check_duplicate_dates(conn: sqlite3.Connection, since: str) -> int:
    """Flag a report_date claimed by more than one post.

    Legitimate when CIT republishes a corrected summary, which then supersedes
    the first — but it doubles the day in `daily_reported`, so it needs eyes.
    """
    rows = conn.execute(
        "SELECT report_date, COUNT(*) n, group_concat(post_id) FROM reports_latest "
        "WHERE report_date >= ? GROUP BY report_date HAVING n > 1", (since,)).fetchall()
    for report_date, n, posts in rows:
        log.warning("%s is reported by %d posts (%s) — both are counted in "
                    "daily_reported, so one may need removing", report_date, n, posts,
                    extra=ann(title="CIT: duplicate report date"))
    return len(rows)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", type=Path, default=Path("data/cit-civilians.db"))
    ap.add_argument("--since", default="1970-01-01",
                    help="only check reports on or after this date (YYYY-MM-DD)")
    args = ap.parse_args(argv)

    if not args.db.exists():
        log.error("%s does not exist", args.db)
        return 1
    conn = sqlite3.connect(args.db)
    try:
        # Every check runs; none of them fails the job. A bad day must not skip
        # the R2 upload and lose the whole run's good rows with it.
        check_day_coverage(conn, args.since)
        check_reconciliation(conn, args.since)
        check_negative_days(conn, args.since)
        check_duplicate_dates(conn, args.since)
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
