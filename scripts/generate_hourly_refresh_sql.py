#!/usr/bin/env python3
"""
Generate SQL to refresh hourly rows in data/sbs.db from data/sbs-foosint.db where
the source DB has a strictly higher value for the chosen metric column. A higher
cumulative counter implies the source row was scraped later in the hour and is
therefore a more accurate end-of-hour snapshot.

Behavior:
- Looks at daily_stats only.
- Considers regular hourly buckets (hour 0..23).
- For each (date, hour) present in BOTH DBs from --start-date onward, takes the
  latest matching row from source DB (by data_collected_at, last_updated, rowid).
- If source[metric] > target[metric] (treating NULL as -infinity on both sides),
  writes an UPDATE statement covering all shared columns except date/hour.
- Does NOT modify either database.
"""

from __future__ import annotations

import argparse
import sqlite3
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Generate hourly refresh SQL from foosint DB")
    p.add_argument("--target-db", default="data/sbs.db", help="Target DB to update")
    p.add_argument("--source-db", default="data/sbs-foosint.db", help="Source DB for fresher rows")
    p.add_argument("--start-date", default="2026-03-20", help="Inclusive YYYY-MM-DD filter")
    p.add_argument(
        "--metric",
        default="total_personnel_casualties",
        help="Column used to decide freshness; source row wins if its value is strictly greater",
    )
    p.add_argument(
        "--output",
        default="data/refresh_hourly_from_foosint.sql",
        help="Output SQL file path",
    )
    return p.parse_args()


def sql_literal(value: Any) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, (int, float)):
        return str(value)
    text = str(value).replace("'", "''")
    return f"'{text}'"


def get_columns(conn: sqlite3.Connection, table: str) -> list[str]:
    return [r[1] for r in conn.execute(f"PRAGMA table_info({table})")]


def main() -> None:
    args = parse_args()

    target_path = Path(args.target_db)
    source_path = Path(args.source_db)
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    target = sqlite3.connect(str(target_path))
    source = sqlite3.connect(str(source_path))
    target.row_factory = sqlite3.Row
    source.row_factory = sqlite3.Row

    target_cols = get_columns(target, "daily_stats")
    source_cols = get_columns(source, "daily_stats")
    shared_cols = [c for c in target_cols if c in set(source_cols)]

    required = {"date", "hour", args.metric}
    if not required.issubset(shared_cols):
        missing = required - set(shared_cols)
        raise RuntimeError(f"Shared schema missing required columns: {sorted(missing)}")

    update_cols = [c for c in shared_cols if c not in {"date", "hour"}]

    # Keys present in target DB (regular hourly rows).
    target_keys = {
        (r["date"], int(r["hour"]))
        for r in target.execute(
            """
            SELECT date, hour
            FROM daily_stats
            WHERE date >= ? AND hour BETWEEN 0 AND 23
            """,
            (args.start_date,),
        )
    }

    # Candidate keys from source DB.
    source_keys = [
        (r["date"], int(r["hour"]))
        for r in source.execute(
            """
            SELECT DISTINCT date, hour
            FROM daily_stats
            WHERE date >= ? AND hour BETWEEN 0 AND 23
            ORDER BY date, hour
            """,
            (args.start_date,),
        )
    ]

    overlapping_keys = [k for k in source_keys if k in target_keys]

    col_list = ", ".join(shared_cols)
    statements: list[str] = []
    considered = 0
    refreshed = 0
    skipped_not_fresher = 0

    for date, hour in overlapping_keys:
        considered += 1

        source_row = source.execute(
            f"""
            SELECT {col_list}
            FROM daily_stats
            WHERE date = ? AND hour = ?
            ORDER BY
              CASE WHEN data_collected_at IS NULL THEN 1 ELSE 0 END,
              data_collected_at DESC,
              CASE WHEN last_updated IS NULL THEN 1 ELSE 0 END,
              last_updated DESC,
              rowid DESC
            LIMIT 1
            """,
            (date, hour),
        ).fetchone()
        if source_row is None:
            continue

        target_row = target.execute(
            f"SELECT {args.metric} FROM daily_stats WHERE date = ? AND hour = ? LIMIT 1",
            (date, hour),
        ).fetchone()
        if target_row is None:
            continue

        src_metric = source_row[args.metric]
        tgt_metric = target_row[args.metric]

        # NULL is treated as worse than any concrete value.
        if src_metric is None:
            skipped_not_fresher += 1
            continue
        if tgt_metric is not None and src_metric <= tgt_metric:
            skipped_not_fresher += 1
            continue

        set_clause = ", ".join(f"{c} = {sql_literal(source_row[c])}" for c in update_cols)
        statements.append(
            f"UPDATE daily_stats SET {set_clause} "
            f"WHERE date = {sql_literal(date)} AND hour = {sql_literal(hour)};"
        )
        refreshed += 1

    with output_path.open("w", encoding="utf-8", newline="\n") as f:
        f.write("-- Generated by scripts/generate_hourly_refresh_sql.py\n")
        f.write(f"-- target_db: {target_path}\n")
        f.write(f"-- source_db: {source_path}\n")
        f.write(f"-- start_date: {args.start_date}\n")
        f.write(f"-- metric: {args.metric}\n")
        f.write(f"-- shared_columns: {len(shared_cols)}\n")
        f.write(f"-- updated_columns: {len(update_cols)}\n")
        f.write(f"-- statements: {refreshed}\n\n")
        f.write("BEGIN TRANSACTION;\n")
        for line in statements:
            f.write(line)
            f.write("\n")
        f.write("COMMIT;\n")

    target.close()
    source.close()

    print(f"Shared columns used: {len(shared_cols)}")
    only_in_target = sorted(set(target_cols) - set(source_cols))
    if only_in_target:
        print(f"Target-only columns (omitted): {only_in_target}")
    print(f"Overlapping hourly keys considered: {considered}")
    print(f"Skipped (source not fresher): {skipped_not_fresher}")
    print(f"Refresh statements written: {refreshed}")
    print(f"Output SQL: {output_path}")


if __name__ == "__main__":
    main()
