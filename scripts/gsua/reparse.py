"""
Re-parse stored posts in place from output/ru-attacks-gsua.db, without going
back to the source (Telegram / Facebook). Use after a parser change to fix
specific rows or a batch.

Examples:
    python reparse.py 38047 38098                # Telegram message ids
    python reparse.py --source facebook 1340260674953674
    python reparse.py --null-combat              # all rows where combat_engagements IS NULL
    python reparse.py --since 2025-09-01 --until 2025-09-30
    python reparse.py --all                      # everything
    python reparse.py --null-combat --dry-run    # preview without writing

A row that no longer passes is_operational_report is deleted (mirrors what a
re-scrape via INSERT-OR-REPLACE-or-skip would produce).
"""
import argparse
import sqlite3
from datetime import datetime
from types import SimpleNamespace

import scrape_general_staff as gs


def _build_msg(row):
    """Build a source-agnostic Message-like stand-in from a DB row.

    `id` is reconstructed as int when the source is Telegram (so the rest
    of the parser sees the same shape as a Telethon Message), and left as
    a string for Facebook (story_fbid). `source` is propagated so
    parse_summary / parse_directions can tag the resulting summary.
    """
    sid = row["source_id"]
    msg_id = int(sid) if row["source"] == "telegram" and sid.isdigit() else sid
    return SimpleNamespace(
        id=msg_id,
        source=row["source"],
        date=datetime.fromisoformat(row["message_date"]),
        text=row["text"],
    )


def _reparse_one(conn: sqlite3.Connection, row, dry_run: bool) -> str:
    """Re-parse a single row. Returns a short status string."""
    src, sid = row["source"], row["source_id"]
    tag = f"{src}:{sid}" if src != "telegram" else f"msg {sid}"
    text = row["text"]
    msg = _build_msg(row)

    if not gs.is_operational_report(text):
        if dry_run:
            return f"{tag}: gate rejects → would DELETE"
        conn.execute(
            "DELETE FROM directions WHERE source = ? AND source_id = ?", (src, sid),
        )
        conn.execute(
            "DELETE FROM posts WHERE source = ? AND source_id = ?", (src, sid),
        )
        return f"{tag}: gate rejects → deleted"

    summary = gs.parse_summary(text, msg)
    if summary is None:
        return f"{tag}: parse_summary returned None (unexpected)"
    directions = gs.parse_directions(text, msg, summary.date)

    if dry_run:
        return (
            f"{tag}: would update "
            f"(date={summary.date}, combat={summary.combat_engagements}, "
            f"dirs={len(directions)})"
        )
    gs.upsert_report(conn, summary, directions, text, row["url"])
    return (
        f"{tag}: updated "
        f"(date={summary.date}, combat={summary.combat_engagements}, "
        f"dirs={len(directions)})"
    )


def _select_rows(conn: sqlite3.Connection, args) -> list:
    """Pick the rows to reparse based on CLI arguments."""
    base_cols = "source, source_id, message_date, text, url"

    if args.message_ids:
        # Specific IDs — match against source_id (TEXT). When --source is given
        # it filters to that source; otherwise we match across all sources.
        placeholders = ",".join("?" * len(args.message_ids))
        params = [str(x) for x in args.message_ids]
        if args.source:
            sql = (
                f"SELECT {base_cols} FROM posts "
                f"WHERE source = ? AND source_id IN ({placeholders}) "
                f"ORDER BY source_id"
            )
            return conn.execute(sql, [args.source] + params).fetchall()
        sql = (
            f"SELECT {base_cols} FROM posts "
            f"WHERE source_id IN ({placeholders}) "
            f"ORDER BY source, source_id"
        )
        return conn.execute(sql, params).fetchall()

    where, params = [], []
    if args.source:
        where.append("source = ?")
        params.append(args.source)
    if args.null_combat:
        where.append("combat_engagements IS NULL")
    if args.since:
        where.append("date >= ?")
        params.append(args.since)
    if args.until:
        where.append("date <= ?")
        params.append(args.until)
    sql = f"SELECT {base_cols} FROM posts"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY source, source_id"
    return conn.execute(sql, params).fetchall()


def main() -> None:
    p = argparse.ArgumentParser(
        description="Re-parse stored posts in place (no source round-trip).",
    )
    p.add_argument("message_ids", nargs="*", help="Specific source_ids to reparse.")
    p.add_argument("--source", choices=["telegram", "facebook"],
                   help="Restrict to one source.")
    p.add_argument("--all", action="store_true", help="Re-parse every stored row.")
    p.add_argument("--null-combat", action="store_true",
                   help="Re-parse rows where combat_engagements IS NULL.")
    p.add_argument("--since", help="Only re-parse rows with date >= YYYY-MM-DD.")
    p.add_argument("--until", help="Only re-parse rows with date <= YYYY-MM-DD.")
    p.add_argument("--dry-run", action="store_true",
                   help="Show what would change without writing.")
    p.add_argument("--db", default=str(gs.DB_PATH), help="Path to the SQLite DB.")
    args = p.parse_args()

    if not (args.message_ids or args.all or args.null_combat or args.since or args.until):
        p.error("specify message_ids, --all, --null-combat, or --since/--until")

    conn = sqlite3.connect(args.db)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")

    rows = _select_rows(conn, args)
    print(f"Selected {len(rows)} row(s).")

    for row in rows:
        print(_reparse_one(conn, row, args.dry_run))

    if not args.dry_run:
        conn.commit()
    conn.close()


if __name__ == "__main__":
    main()
