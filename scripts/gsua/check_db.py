#!/usr/bin/env python3
"""Post-ingest data-quality checks over the GSUA DB.

These are the checks that need the whole table rather than one post, so they
can't live in `_sanity_check` (which sees a single report at a time). They used
to live as inline SQL inside `.github/workflows/update-telegram-web-dbs.yml`,
which meant the predicate existed in two languages, only ran in CI, and could
never be unit-tested. Findings go through the shared logger, so the same run
that prints them to stderr locally turns them into annotations in Actions.

    python check_db.py --since 2026-09-01
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from ingest_log import ann, get_logger  # noqa: E402

import scrape_general_staff as gs  # noqa: E402

log = get_logger("gsua")

# Latest edit-version of every post from `since` onward — the same resolution
# rule the frontend and daily_combined use.
_LATEST_POSTS = """
    WITH lp AS (
      SELECT p.* FROM posts p
      WHERE p.source = 'telegram' AND p.date >= ?
        AND NOT EXISTS (
          SELECT 1 FROM posts n
          WHERE n.source = p.source AND n.source_id = p.source_id
            AND n.scraped_at > p.scraped_at)
    )
"""


def check_missile_field_asymmetry(conn: sqlite3.Connection, since: str) -> int:
    """Flag dates where exactly one of missile_strikes / missiles_used is set.

    The two count different things — missile STRIKES vs missiles USED — and the
    General Staff often reports them independently, so one being absent is
    frequently legitimate. That's why this is a NOTICE: a prompt to eyeball the
    day, not a claim that the parse is wrong. Emitting it as a warning would
    train people to ignore the panel, which is how the direction-count gaps
    went unnoticed for two years.
    """
    rows = conn.execute(
        _LATEST_POSTS
        + """
        SELECT date, MAX(missile_strikes), MAX(missiles_used)
        FROM lp GROUP BY date ORDER BY date
        """,
        (since,),
    ).fetchall()
    hits = 0
    for date, strikes, used in rows:
        if (strikes is None) != (used is None):
            s = strikes if strikes is not None else "∅"
            u = used if used is not None else "∅"
            log.warning(
                f"GSUA {date}: only one of the missile fields is set "
                f"(missile_strikes={s}, missiles_used={u}).",
                extra=ann(
                    level="notice",
                    title="gsua: missile-field asymmetry",
                    file="scripts/gsua/scrape_general_staff.py",
                ),
            )
            hits += 1
    log.info(
        f"Missile-field asymmetry: {len(rows)} date(s) since {since}, {hits} notice(s)."
    )
    return hits


CHECKS = (check_missile_field_asymmetry,)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--db", default=str(gs.DB_PATH), help="Path to the SQLite DB.")
    p.add_argument(
        "--since", required=True, help="Only check report dates >= YYYY-MM-DD."
    )
    args = p.parse_args(argv)

    conn = sqlite3.connect(args.db)
    try:
        for check in CHECKS:
            check(conn, args.since)
    finally:
        conn.close()
    # Always 0: a data-quality observation must never fail the update and take
    # the site stale over a report the ingest handled correctly.
    return 0


if __name__ == "__main__":
    sys.exit(main())
