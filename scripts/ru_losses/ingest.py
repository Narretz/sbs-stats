#!/usr/bin/env python3
"""
ingest.py — build ru-losses-gsua.db from russian-casualties.in.ua.

Source: https://russian-casualties.in.ua (Ukrainian General Staff daily totals,
re-published as a clean JSON/CSV API). We use the *daily* endpoint, which already
returns per-day increments (NOT cumulative), keyed by date — so no diffing needed.

Snapshot-only: the frontend never calls this API. This script runs in CI (and
locally), writes a small SQLite file, and that file is uploaded to R2.

Append-only by design (mirrors the GSUA `posts` snapshot model): a stored row is
never mutated or deleted. Each `daily_losses` row is one *version* of a date's
numbers, tagged with `snapshot_at` (when we ingested it). On each run we compare
the fetched values to the latest stored version per date and insert a NEW row
only when they differ (or the date is new) — so unchanged days add nothing, and
the General Staff's occasional same-day corrections are captured as a fresh row
that simply wins by having a newer `snapshot_at`. The frontend always reads the
latest snapshot per date. Nothing is ever overwritten, so a bad value can't
clobber good stored data — the prior version is still in the table.

A guard aborts the build (without writing) if the fetch looks broken — an
absolute row-count floor and a "no fewer dates than we already store" check — so
a partial/empty response fails the build, the upload step is skipped, and R2 is
left untouched.

stdlib only (urllib + sqlite3 + json) — no extra dependencies.
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

API_URL = "https://russian-casualties.in.ua/api/v1/data/json/daily"

# Metric columns, in display order. Mirrors src/types/index.ts RU_LOSSES_METRIC_KEYS.
# These are the source's own legend keys (the API also sends `submarines`, which
# is absent from the legend and flat-zero, so we omit it).
METRICS = [
    "personnel",
    "captive",
    "tanks",
    "apv",
    "artillery",
    "mlrs",
    "aaws",
    "aircraft",
    "helicopters",
    "uav",
    "vehicles",
    "boats",
    "se",
    "missiles",
]

SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_DB_NAME = os.environ.get("RU_LOSSES_DB_NAME", "ru-losses-gsua.db")


def fetch() -> dict:
    req = urllib.request.Request(API_URL, headers={"User-Agent": "sbs-stats-ingest"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        if resp.status != 200:
            raise RuntimeError(f"{API_URL} returned HTTP {resp.status}")
        return json.load(resp)


def normalize_date(raw: str) -> str:
    # API keys look like "2026.05.24"; we store ISO "2026-05-24".
    return raw.replace(".", "-")


# Absolute floor: the war started 2022-02-24, so the live API should always
# return well over a year of days. Anything below this means a broken/partial
# response — refuse it rather than write a suspicious snapshot.
MIN_ROWS_FLOOR = 365


def parse_rows(payload: dict) -> dict[str, tuple[int, ...]]:
    """Return {date: (metric values in METRICS order)} for the fetched payload."""
    data = payload.get("data")
    if not isinstance(data, dict) or not data:
        raise RuntimeError("payload has no 'data' object — API shape changed?")
    out: dict[str, tuple[int, ...]] = {}
    for raw_date, vals in data.items():
        if not isinstance(vals, dict):
            continue
        out[normalize_date(raw_date)] = tuple(int(vals.get(m) or 0) for m in METRICS)
    return out


def build(db_path: Path, payload: dict) -> tuple[int, int, str]:
    """Append changed/new day-versions into db_path. Never mutates/deletes rows.

    Compares each fetched day to the latest stored snapshot for that date and
    inserts a new (date, snapshot_at, …) row only when the values differ or the
    date is unseen. Aborts (raises) without writing if the payload looks broken,
    so a bad fetch can't pollute the DB and the caller can skip the R2 upload.

    Returns (inserted_rows, distinct_dates, latest_date).
    """
    fetched = parse_rows(payload)

    # Guard 1: absolute floor — empty/tiny payloads are never legitimate.
    if len(fetched) < MIN_ROWS_FLOOR:
        raise RuntimeError(
            f"fetched only {len(fetched)} days (< floor {MIN_ROWS_FLOOR}) — refusing "
            f"to write {db_path}. Upstream likely returned a partial response."
        )

    cols = ", ".join(f"{m} INTEGER" for m in METRICS)
    metric_cols = ", ".join(METRICS)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            f"CREATE TABLE IF NOT EXISTS daily_losses "
            f"(date TEXT NOT NULL, snapshot_at TEXT NOT NULL, {cols}, "
            f"PRIMARY KEY (date, snapshot_at))"
        )

        # Latest stored version per date, for change detection.
        latest_rows = conn.execute(
            f"""
            SELECT d.date, {metric_cols}
            FROM daily_losses d
            JOIN (SELECT date, MAX(snapshot_at) AS ms FROM daily_losses GROUP BY date) l
              ON d.date = l.date AND d.snapshot_at = l.ms
            """
        ).fetchall()
        stored = {r[0]: tuple(r[1:]) for r in latest_rows}

        # Guard 2: we should never see fewer distinct dates than already stored.
        if len(fetched) < len(stored):
            raise RuntimeError(
                f"fetched {len(fetched)} days but DB already has {len(stored)} dates — "
                f"refusing to write a shrinking dataset into {db_path}."
            )

        snapshot_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
        to_insert = [
            [date, snapshot_at, *vals]
            for date, vals in fetched.items()
            if stored.get(date) != vals  # new date, or values changed
        ]

        if to_insert:
            placeholders = ", ".join(["?"] * (len(METRICS) + 2))
            collist = ", ".join(["date", "snapshot_at"] + METRICS)
            conn.executemany(
                f"INSERT INTO daily_losses ({collist}) VALUES ({placeholders})",
                to_insert,
            )
            conn.commit()
            conn.execute("VACUUM")
            conn.commit()

        distinct = conn.execute("SELECT COUNT(DISTINCT date) FROM daily_losses").fetchone()[0]
        latest = conn.execute("SELECT MAX(date) FROM daily_losses").fetchone()[0]
    finally:
        conn.close()
    return len(to_insert), distinct, latest


def main() -> int:
    ap = argparse.ArgumentParser(description="Build ru-losses-gsua.db from russian-casualties.in.ua")
    ap.add_argument(
        "--out",
        default=os.environ.get("RU_LOSSES_DB_PATH", str(SCRIPT_DIR / "output" / DEFAULT_DB_NAME)),
        help="output SQLite path (default: scripts/ru_losses/output/%s)" % DEFAULT_DB_NAME,
    )
    args = ap.parse_args()

    print(f"==> Fetching {API_URL}")
    payload = fetch()
    out = Path(args.out)
    inserted, distinct, latest = build(out, payload)
    print(
        f"==> Inserted {inserted} new/changed day-versions; "
        f"{distinct} distinct dates (latest {latest}) → {out} ({out.stat().st_size} bytes)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
