#!/usr/bin/env python3
"""
Build a frontend-only copy of a dataset DB with bulky text columns stripped.

The full DB stays as the authoritative R2 object: ingest scripts and reparse.py
need the raw post text to re-derive parsed fields from stored sources (and
future Сводка/transcript parsing experiments will too). The frontend never
queries those text columns, so the public copy can drop their contents — for
ru-mod-ad that shrinks the DB ~5×, for gsua ~3×. CI uploads both the
authoritative '<name>.db' and the stripped '<name>.public.db'; the frontend's
VITE_*_DB_URL points at the public copy.

Sentinel choice is automatic: NULL where the column allows it, '' where there's
a NOT NULL constraint — so post-VACUUM the row layout shrinks either way.

Usage:
  python scripts/build_public_db.py \\
    --in scripts/ru_mod/output/ru-mod-ad.db \\
    --out scripts/ru_mod/output/ru-mod-ad.public.db \\
    --blank ad_reports.raw_text \\
    --blank summaries.raw_text
"""
import argparse
import shutil
import sqlite3
import sys
from pathlib import Path


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    p.add_argument("--in", dest="src", required=True, type=Path, help="Input DB path.")
    p.add_argument("--out", dest="dst", required=True, type=Path, help="Output DB path.")
    p.add_argument(
        "--blank", action="append", required=True, metavar="table.col",
        help="Column to blank out (repeatable). Sentinel auto-picked: '' for "
             "NOT NULL columns, NULL otherwise.",
    )
    args = p.parse_args()

    if not args.src.exists():
        p.error(f"input DB not found: {args.src}")
    args.dst.parent.mkdir(parents=True, exist_ok=True)
    # Copy + mutate + VACUUM, rather than VACUUM INTO + UPDATE on a fresh DB,
    # because VACUUM INTO emits a snapshot of the source — we'd then have to
    # reopen and mutate it anyway, and shutil.copy is simpler.
    shutil.copy(args.src, args.dst)
    conn = sqlite3.connect(args.dst)
    conn.isolation_level = None  # autocommit so VACUUM doesn't trip on the txn
    try:
        for spec in args.blank:
            if "." not in spec:
                p.error(f"--blank value must be 'table.col', got {spec!r}")
            table, col = spec.split(".", 1)
            info = conn.execute(
                "SELECT [notnull] FROM pragma_table_info(?) WHERE name = ?",
                (table, col),
            ).fetchone()
            if info is None:
                p.error(f"column not found: {spec}")
            sentinel = "''" if info[0] else "NULL"
            n = conn.execute(f"UPDATE {table} SET {col} = {sentinel}").rowcount
            print(f"  blanked {spec} ({n} row(s), sentinel={sentinel})")
        conn.execute("VACUUM")
    finally:
        conn.close()

    src_mb = args.src.stat().st_size / 1024 / 1024
    dst_mb = args.dst.stat().st_size / 1024 / 1024
    saved_pct = (1 - dst_mb / src_mb) * 100 if src_mb else 0
    print(f"==> {args.src} ({src_mb:.1f} MB) → {args.dst} "
          f"({dst_mb:.1f} MB; -{saved_pct:.0f}%)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
