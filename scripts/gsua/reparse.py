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


# Columns produced by the parser that the dry-run diff compares.
_PARSER_COLS = (
    "combat_engagements", "missile_strikes", "missiles_used", "air_strikes",
    "kabs_dropped", "kamikaze_drones", "shellings", "mlrs_shellings",
    "notes", "part",
)


def _fmt(v) -> str:
    return "∅" if v is None else str(v)


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
    # Mirror the scrape path: the sanity check catches branch-1a fallbacks
    # where the global combat_engagements got a per-direction value (impossible
    # because the global must be ≥ any individual direction). It runs inside
    # upsert_report on fresh scrapes; reparse calls it explicitly so the
    # reparsed row matches what a fresh scrape would store.
    gs._sanity_check(summary, directions, text)

    # Diff against the row being processed. Used both for dry-run reporting
    # and to short-circuit a no-op live update.
    diffs = []
    for col in _PARSER_COLS:
        old = row[col]
        new = getattr(summary, col)
        if old != new:
            diffs.append(f"{col}={_fmt(old)} → {_fmt(new)}")
    existing_dirs = conn.execute(
        "SELECT direction, attacks, ongoing FROM directions "
        "WHERE source = ? AND source_id = ? AND scraped_at = ?",
        (src, sid, row["scraped_at"]),
    ).fetchall()
    old_map = {d[0]: (d[1], d[2]) for d in existing_dirs}
    new_map = {d.direction: (d.attacks, d.ongoing) for d in directions}
    dir_changes = []
    for k in sorted(set(old_map) | set(new_map)):
        if k not in new_map:
            oa, oo = old_map[k]
            dir_changes.append(f"-{k} ({_fmt(oa)}/{_fmt(oo)})")
        elif k not in old_map:
            na, no = new_map[k]
            dir_changes.append(f"+{k} ({_fmt(na)}/{_fmt(no)})")
        elif old_map[k] != new_map[k]:
            oa, oo = old_map[k]
            na, no = new_map[k]
            dir_changes.append(
                f"{k} {_fmt(oa)}/{_fmt(oo)} → {_fmt(na)}/{_fmt(no)}"
            )
    if dir_changes:
        diffs.append(f"dirs[{'; '.join(dir_changes)}]")

    if not diffs:
        return f"{tag}: no changes (date={summary.date})"
    if dry_run:
        return f"{tag}: {', '.join(diffs)} (date={summary.date}, snapshot={summary.snapshot_at})"

    # Update this row in place. `_select_rows` only returns the latest
    # edit-version per (source, source_id), so the row's own scraped_at is
    # already the right target. (Text is unchanged on a parser-only reprocess
    # — `upsert_report` short-circuits on identical text and can't help here.)
    latest_at = row["scraped_at"]
    conn.execute(
        """
        UPDATE posts SET
            combat_engagements = ?, missile_strikes = ?, missiles_used = ?,
            air_strikes = ?, kabs_dropped = ?, kamikaze_drones = ?,
            shellings = ?, mlrs_shellings = ?, notes = ?, part = ?
        WHERE source = ? AND source_id = ? AND scraped_at = ?
        """,
        (
            summary.combat_engagements, summary.missile_strikes,
            summary.missiles_used, summary.air_strikes,
            summary.kabs_dropped, summary.kamikaze_drones,
            summary.shellings, summary.mlrs_shellings,
            summary.notes, summary.part,
            src, sid, latest_at,
        ),
    )
    conn.execute(
        "DELETE FROM directions WHERE source = ? AND source_id = ? AND scraped_at = ?",
        (src, sid, latest_at),
    )
    if directions:
        conn.executemany(
            """
            INSERT INTO directions (source, source_id, scraped_at, direction, attacks, ongoing)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            [(src, sid, latest_at, d.direction, d.attacks, d.ongoing) for d in directions],
        )
    return f"{tag}: updated [{', '.join(diffs)}] (date={summary.date})"


def _select_rows(conn: sqlite3.Connection, args) -> list:
    """Pick the rows to reparse based on CLI arguments.

    Only the latest edit-version per (source, source_id) is returned. Older
    versions are immutable historical record (the dashboard reads via
    LATEST_POSTS), so reprocessing them serves no purpose and would just
    re-write the same correction to the latest row repeatedly.
    """
    base_cols = (
        "source, source_id, message_date, text, url, scraped_at, "
        + ", ".join(_PARSER_COLS)
    )
    latest_filter = (
        "NOT EXISTS (SELECT 1 FROM posts n "
        "WHERE n.source = p.source AND n.source_id = p.source_id "
        "AND n.scraped_at > p.scraped_at)"
    )

    if args.message_ids:
        # Specific IDs — match against source_id (TEXT). When --source is given
        # it filters to that source; otherwise we match across all sources.
        placeholders = ",".join("?" * len(args.message_ids))
        params = [str(x) for x in args.message_ids]
        if args.source:
            sql = (
                f"SELECT {base_cols} FROM posts p "
                f"WHERE source = ? AND source_id IN ({placeholders}) "
                f"AND {latest_filter} "
                f"ORDER BY source_id"
            )
            return conn.execute(sql, [args.source] + params).fetchall()
        sql = (
            f"SELECT {base_cols} FROM posts p "
            f"WHERE source_id IN ({placeholders}) "
            f"AND {latest_filter} "
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
    where.append(latest_filter)
    sql = f"SELECT {base_cols} FROM posts p WHERE " + " AND ".join(where)
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
