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
    """Report how closely the regional breakdown tracks each post's own total.

    A NOTICE, not a warning. The strict flag — both figures matching exactly —
    is a harsh test and sits near 30%, but it badly understates how usable the
    breakdown is: across the archive the parsed region rows come within ~1% of
    the stated totals in aggregate, and the KILLED column matches exactly on
    roughly three quarters of reports. Injured is the soft one: many posts are
    off by one or two people in a figure of a hundred-odd.

    What matters is the trend. A sudden drop in the killed-exact rate, or an
    aggregate drift beyond a couple of percent, means the format moved and the
    parser needs a look — which a single strict percentage would hide.
    """
    rows = conn.execute(
        "SELECT stated_killed, sum_killed, stated_injured, sum_injured "
        "FROM reports_latest WHERE report_date >= ? AND reconciled IS NOT NULL",
        (since,)).fetchall()
    if not rows:
        return 0
    n = len(rows)
    k_exact = sum(1 for r in rows if r[0] == r[1])
    i_near = sum(1 for r in rows if abs(r[3] - r[2]) <= 3)
    both = sum(1 for r in rows if r[0] == r[1] and r[2] == r[3])
    k_stated = sum(r[0] for r in rows) or 1
    i_stated = sum(r[2] for r in rows) or 1
    k_drift = 100.0 * (sum(r[1] for r in rows) - k_stated) / k_stated
    i_drift = 100.0 * (sum(r[3] for r in rows) - i_stated) / i_stated
    log.warning(
        "breakdown vs the posts' own totals over %d reports since %s: killed "
        "exact on %d (%.0f%%), injured within 3 on %d (%.0f%%), both exact on "
        "%d (%.0f%%); aggregate drift killed %+.1f%%, injured %+.1f%%. The "
        "stated headline figures — what the charts plot — are unaffected.",
        n, since, k_exact, 100.0 * k_exact / n, i_near, 100.0 * i_near / n,
        both, 100.0 * both / n, k_drift, i_drift,
        extra=ann(level="notice", title="CIT: breakdown accuracy"))
    return n - both


def check_negative_days(conn: sqlite3.Connection, since: str) -> int:
    """Flag days whose revised total went negative.

    Only an adjustment can push a day below zero. Two cases, and they mean
    different things:

    * The day HAS daily rows → we subtracted more than was ever added, which is
      a real problem worth a warning.
    * The day has NO daily rows → expected, and not an error. A weekend report
      stores its regional rows under the window's END date, so the Saturday of
      a weekend has no rows of its own; a later correction naming that Saturday
      then stands alone in `daily_revised`. (The frontend spreads a weekend's
      headline across both days; the stored breakdown is not spread, because
      the source never split it.)
    """
    rows = conn.execute(
        """
        SELECT r.event_date, r.killed, r.injured,
               EXISTS (SELECT 1 FROM casualties_latest d
                       WHERE d.event_date = r.event_date AND d.kind = 'daily') AS covered
        FROM daily_revised r
        WHERE r.event_date >= ? AND (r.killed < 0 OR r.injured < 0)
        """,
        (since,)).fetchall()
    real = 0
    for event_date, killed, injured, covered in rows:
        if covered:
            real += 1
            log.warning(
                "revised totals for %s are negative (%d killed, %d injured) even "
                "though the day has its own regional rows — a correction "
                "subtracted casualties that were never recorded",
                event_date, killed, injured,
                extra=ann(title="CIT: negative revised total"))
        else:
            log.warning(
                "%s carries only corrections (%d killed, %d injured) and no "
                "regional rows of its own — normally the first day of a weekend, "
                "whose breakdown is stored under the Sunday",
                event_date, killed, injured,
                extra=ann(level="notice", title="CIT: corrections-only day"))
    return real


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
