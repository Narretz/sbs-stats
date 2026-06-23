"""
Re-parse stored RU MoD air-defense posts in place from the SQLite DB, without
going back to Telegram. Use after a parser change to fix specific rows or a
batch — much faster than re-scraping, and survives offline.

Each ad_reports row has `raw_text`, `posted_at`, and `post_id` — the same three
inputs the live scraper feeds into parse_report — so the parser is fully
re-runnable on stored rows. Per-region rows in ad_regions get replaced in
lockstep, and _flag_overlaps is re-run at the end so any window-classification
changes refresh the overlap-caveat notes too.

Examples:
    python reparse.py 55511 55452                 # specific post_ids
    python reparse.py --since 2025-08-01 --until 2025-08-31
    python reparse.py --window-other              # rows whose window didn't classify
    python reparse.py --breakdown-mismatch        # rows where breakdown sum != drones
    python reparse.py --all                       # the entire DB (slow but safe)
    python reparse.py --since 2025-08-01 --dry-run

A row whose text no longer passes the AD gate (parse_report returns None) is
DELETED — mirrors what a re-scrape via INSERT-OR-IGNORE-or-skip would produce.
"""
import argparse
import sqlite3
from datetime import datetime
from pathlib import Path

import ingest as ig


# Columns parse_report fills on each ad_reports row. raw_text is the input
# (unchanged), notes is re-derived by _flag_overlaps post-pass — neither is
# in the UPDATE set.
_PARSER_COLS = (
    "window_start", "window_end", "window_kind", "report_date",
    "drones", "region_count", "regions",
)


def _fmt(v) -> str:
    return "∅" if v is None else str(v)


def _existing_breakdown(conn: sqlite3.Connection, post_id: int, scraped_at: str) -> list[tuple[str, int]]:
    return [(r[0], r[1]) for r in conn.execute(
        "SELECT region, drones FROM ad_regions "
        "WHERE post_id = ? AND scraped_at = ? ORDER BY region",
        (post_id, scraped_at),
    )]


def _reparse_one(conn: sqlite3.Connection, row, dry_run: bool) -> str:
    """Re-parse a single row. Returns a short status string."""
    pid = row["post_id"]
    tag = f"post {pid}"
    text = row["raw_text"]
    if text is None:
        return f"{tag}: raw_text is NULL — skipping (pre-raw-text storage)"
    posted_at_utc = datetime.fromisoformat(row["posted_at"])

    report = ig.parse_report(text, pid, posted_at_utc)
    if report is None:
        # Gate now rejects — drop the row entirely (and its per-region rows).
        if dry_run:
            return f"{tag}: gate rejects → would DELETE"
        conn.execute("DELETE FROM ad_regions WHERE post_id = ?", (pid,))
        conn.execute("DELETE FROM ad_reports WHERE post_id = ?", (pid,))
        return f"{tag}: gate rejects → deleted"

    # Diff against the stored values for both the report row and its
    # per-region breakdown. Used both for the dry-run printout and to
    # short-circuit a no-op update.
    diffs = []
    for col in _PARSER_COLS:
        old = row[col]
        new = getattr(report, col)
        if old != new:
            diffs.append(f"{col}={_fmt(old)} → {_fmt(new)}")

    old_bd = dict(_existing_breakdown(conn, pid, row["scraped_at"]))
    new_bd = dict(report.breakdown)
    region_changes = []
    for region in sorted(set(old_bd) | set(new_bd)):
        if region not in new_bd:
            region_changes.append(f"-{region}({_fmt(old_bd[region])})")
        elif region not in old_bd:
            region_changes.append(f"+{region}({_fmt(new_bd[region])})")
        elif old_bd[region] != new_bd[region]:
            region_changes.append(f"{region}({_fmt(old_bd[region])}→{_fmt(new_bd[region])})")
    if region_changes:
        diffs.append(f"regions[{'; '.join(region_changes)}]")

    if not diffs:
        return f"{tag}: no changes (date={report.report_date})"
    if dry_run:
        return f"{tag}: {', '.join(diffs)}"

    # Update the ad_reports row in place. _select_rows only returns the latest
    # edit-version per post_id, so this scraped_at is the correct target.
    conn.execute(
        """
        UPDATE ad_reports SET
            window_start = ?, window_end = ?, window_kind = ?, report_date = ?,
            drones = ?, region_count = ?, regions = ?
        WHERE post_id = ? AND scraped_at = ?
        """,
        (
            report.window_start, report.window_end, report.window_kind,
            report.report_date, report.drones, report.region_count, report.regions,
            pid, row["scraped_at"],
        ),
    )
    conn.execute(
        "DELETE FROM ad_regions WHERE post_id = ? AND scraped_at = ?",
        (pid, row["scraped_at"]),
    )
    if report.breakdown:
        conn.executemany(
            "INSERT INTO ad_regions (post_id, scraped_at, report_date, region, drones) "
            "VALUES (?, ?, ?, ?, ?)",
            [(pid, row["scraped_at"], report.report_date, region, count)
             for region, count in report.breakdown],
        )
    return f"{tag}: updated (date={report.report_date}) [{', '.join(diffs)}]"


def _select_rows(conn: sqlite3.Connection, args) -> list:
    """Pick which ad_reports rows to reprocess based on CLI arguments.

    Only the latest edit-version per post_id is returned — older versions are
    immutable historical record (the dashboard reads via ad_latest) so
    rewriting them would just churn without effect.
    """
    base_cols = (
        "post_id, scraped_at, posted_at, raw_text, "
        + ", ".join(_PARSER_COLS)
    )
    latest_filter = (
        "scraped_at = (SELECT MAX(scraped_at) FROM ad_reports n WHERE n.post_id = p.post_id)"
    )

    if args.message_ids:
        placeholders = ",".join("?" * len(args.message_ids))
        sql = (
            f"SELECT {base_cols} FROM ad_reports p "
            f"WHERE post_id IN ({placeholders}) AND {latest_filter} "
            f"ORDER BY post_id"
        )
        return conn.execute(sql, list(args.message_ids)).fetchall()

    where, params = [], []
    if args.since:
        where.append("report_date >= ?")
        params.append(args.since)
    if args.until:
        where.append("report_date <= ?")
        params.append(args.until)
    if args.window_other:
        where.append("window_kind = 'other'")
    if args.breakdown_mismatch:
        # Same definition the scrape's _breakdown_mismatches uses: rows that
        # have AT LEAST one stored ad_regions row whose sum doesn't match the
        # headline `drones`. Posts with zero ad_regions rows (single-region
        # intercepts where parse_breakdown intentionally returns [] because
        # it requires ≥2 items) are NOT mismatches — there's no parser miss,
        # the source just doesn't itemize.
        where.append(
            "EXISTS (SELECT 1 FROM ad_regions g "
            "        WHERE g.post_id = p.post_id AND g.scraped_at = p.scraped_at) "
            "AND (SELECT SUM(drones) FROM ad_regions g "
            "     WHERE g.post_id = p.post_id AND g.scraped_at = p.scraped_at) != p.drones"
        )
    if not args.all and not where:
        # Defensive: require at least one filter unless --all is set, so a
        # bare `reparse.py` doesn't accidentally rewrite the whole DB.
        return []
    where.append(latest_filter)
    sql = f"SELECT {base_cols} FROM ad_reports p WHERE " + " AND ".join(where)
    sql += " ORDER BY post_id"
    return conn.execute(sql, params).fetchall()


def main() -> int:
    p = argparse.ArgumentParser(
        description="Re-parse stored RU MoD AD posts in place (no Telegram round-trip).",
    )
    p.add_argument("message_ids", nargs="*", type=int,
                   help="Specific post_ids to reparse.")
    p.add_argument("--all", action="store_true", help="Re-parse every stored row.")
    p.add_argument("--since", help="Only re-parse rows with report_date >= YYYY-MM-DD.")
    p.add_argument("--until", help="Only re-parse rows with report_date <= YYYY-MM-DD.")
    p.add_argument("--window-other", action="store_true",
                   help="Rows where window classification fell through to 'other' "
                        "(usually a parser miss on the window phrasing).")
    p.add_argument("--breakdown-mismatch", action="store_true",
                   help="Rows whose per-region SUM(drones) doesn't equal the headline `drones`.")
    p.add_argument("--dry-run", action="store_true",
                   help="Show what would change without writing.")
    p.add_argument("--db", default=str(ig.SCRIPT_DIR / "output" / ig.DEFAULT_DB_NAME),
                   help="Path to the SQLite DB.")
    args = p.parse_args()

    if not (args.message_ids or args.all or args.since or args.until
            or args.window_other or args.breakdown_mismatch):
        p.error("specify post_ids, --all, --since/--until, --window-other, or --breakdown-mismatch")

    db_path = Path(args.db)
    if not db_path.exists():
        p.error(f"DB not found: {db_path}")

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row

    rows = _select_rows(conn, args)
    print(f"Selected {len(rows)} row(s) from {db_path}.")
    if not rows:
        return 0

    n_changed = 0
    for row in rows:
        msg = _reparse_one(conn, row, args.dry_run)
        if "updated" in msg or "deleted" in msg or (args.dry_run and "would" in msg) or (args.dry_run and "→" in msg):
            n_changed += 1
        print(msg)

    if args.dry_run:
        print(f"\nDry-run: {n_changed} row(s) would change.")
        return 0

    # Reparsing may have changed window_start/end on enough rows that the
    # overlap graph shifts — refresh the notes (and emit the standard count
    # for visibility).
    pairs = ig._flag_overlaps(conn)
    conn.commit()
    print(f"\nApplied: {n_changed} row(s) changed.")
    print(f"Refreshed overlap notes: {len(pairs)} flagged pair(s) total in DB.")
    conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
