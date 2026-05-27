#!/usr/bin/env python3
"""
ingest.py — build ru-losses-gsua-petroivaniuk.db from PetroIvaniuk's dataset.

Source: github.com/PetroIvaniuk/2022-Ukraine-Russia-War-Dataset — the de-facto
machine-readable mirror of the Ukrainian General Staff's daily national loss
totals (the figures behind the GS's daily infographic). We switched to it from
russian-casualties.in.ua because (a) Petro adds the GS's new `ground robotic
systems` category — unmanned ground systems (UGS) — which the old source never
exposed; (b) it's a named, MIT-licensed, daily-pushed repo with four years of
git history that downstream analysts (CSIS/ISW) build on, vs an anonymous site
with no contact; (c) it's a strict superset of the columns we tracked.

There is no REST API: we fetch two raw JSON files (equipment + personnel).

CUMULATIVE → DAILY. Unlike russian-casualties.in.ua (already per-day), Petro is
cumulative war-to-date totals, one record per day, so a per-day figure is the
diff of consecutive days. Notes baked into that transform:
  - Corrections are ALREADY in the cumulative series (the totals physically
    decrease on the GS's correction dates), so we just diff and let them pass
    through. The repo's russia_losses_equipment_correction.json is documentary
    only — we never apply it (doing so would double-count).
  - A category backfilled mid-war (UGS arrived 2026-05-03 with a war-to-date
    value) gets daily=NULL on its first day — a backfill can't be one day's loss.

DATE MODEL. Petro labels each record by the GS *report* day; the increment is
losses from the day before. We store:
  - `date`       = the loss day (report day − 1) — "the date the data is for",
                   matching how the previous source keyed it (verified: Petro
                   report-day D == old source loss-day D−1 on 1517/1552 days).
  - `reported_at`= the GS report/publication day (Petro's native date).

Snapshot-only: the frontend never calls these files. This script runs in CI (and
locally), writes a small SQLite file, and that file is uploaded to R2.

Append-only / versioned (mirrors the GSUA `posts` model): a stored row is never
mutated or deleted. Each `daily_losses` row is one *version* of a date's numbers,
tagged with `scraped_at` (ingest time). On each run we compare fetched values to
the latest stored version per date and insert a NEW row only when they differ (or
the date is new). The frontend reads the latest snapshot per date.

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
from datetime import date as date_cls, datetime, timedelta, timezone
from pathlib import Path

RAW = "https://raw.githubusercontent.com/PetroIvaniuk/2022-Ukraine-Russia-War-Dataset/main/data"
EQUIP_URL = f"{RAW}/russia_losses_equipment.json"
PERSONNEL_URL = f"{RAW}/russia_losses_personnel.json"

# our daily_losses column  ←  PetroIvaniuk source key. Order is the display order;
# mirror it in RU_LOSSES_METRIC_KEYS (src/types/index.ts). `ugs` is the category
# the switch was about. `captive` ← POW: Petro's last POW is 2022-04-27, but
# that's correct — the General Staff stopped reporting POWs (the old source's
# `captive` was null on every date), so it's a dead-but-harmless early-war column.
EQUIP_MAP = {
    "tanks": "tank",
    "apv": "APC",
    "artillery": "field artillery",
    "mlrs": "MRL",
    "aaws": "anti-aircraft warfare",
    "aircraft": "aircraft",
    "helicopters": "helicopter",
    "uav": "drone",
    "vehicles": "vehicles and fuel tanks",
    "boats": "naval ship",
    "se": "special equipment",
    "missiles": "cruise missiles",
    "ugs": "ground robotic systems",
}
PERSONNEL_MAP = {
    "personnel": "personnel",
    "captive": "POW",
}

# Metric columns, in display order. Mirrors src/types/index.ts RU_LOSSES_METRIC_KEYS.
METRICS = ["personnel"] + list(EQUIP_MAP) + ["captive"]

# Source keys we already account for (mapped) or deliberately ignore. Anything
# else is a NEW category — flagged by check_drift so it can't slip in silently.
IGNORED_SOURCE_KEYS = {
    "submarines",     # rides along flat-zero, as in the old source
    "date", "day", "personnel*",          # record metadata, not metrics
    "greatest losses direction",          # text annotation (e.g. "Bakhmut"), not a count
    # Early-war (Feb–Apr 2022) categories the General Staff later CONSOLIDATED.
    # `military auto` + `fuel tank` merged into `vehicles and fuel tanks` (our
    # `vehicles`) cleanly on 2022-05-01 — no overlap — so `vehicles` legitimately
    # starts there; `mobile SRBM system` was simply discontinued. All dead since
    # 2022; we don't resurrect them as columns.
    "military auto", "fuel tank", "mobile SRBM system",
}
KNOWN_SOURCE_KEYS = set(EQUIP_MAP.values()) | set(PERSONNEL_MAP.values()) | IGNORED_SOURCE_KEYS

# PetroIvaniuk labels each increment one day later than the loss day (report-day
# vs loss-day). Verified: petro[date] == old-source[date-1] on 1517/1552 days.
REPORT_TO_LOSS_DAY = -1

# Absolute floor: the war started 2022-02-24, so the source should always return
# well over a year of days. Below this means a broken/partial fetch — refuse it.
MIN_ROWS_FLOOR = 365

SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_DB_NAME = os.environ.get("RU_LOSSES_DB_NAME", "ru-losses-gsua-petroivaniuk.db")


def fetch_json(url: str) -> list[dict]:
    req = urllib.request.Request(url, headers={"User-Agent": "sbs-stats-ingest"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        if resp.status != 200:
            raise RuntimeError(f"{url} returned HTTP {resp.status}")
        return json.load(resp)


def fetch() -> tuple[list[dict], list[dict]]:
    return fetch_json(EQUIP_URL), fetch_json(PERSONNEL_URL)


def check_drift(equip: list[dict], personnel: list[dict]) -> list[str]:
    """Flag any upstream key we don't already map or ignore.

    Returns the sorted unknown keys (empty if none) and prints a prominent
    warning (plus a GitHub Actions annotation in CI). A new category — the way
    `ground robotic systems` first appeared — surfaces here so we know to add it
    to EQUIP_MAP/METRICS + RU_LOSSES_METRIC_KEYS rather than silently dropping it.
    """
    seen: set[str] = set()
    for rec in (*equip, *personnel):
        if isinstance(rec, dict):
            seen |= set(rec)
    unknown = sorted(seen - KNOWN_SOURCE_KEYS)
    if unknown:
        msg = (
            f"PetroIvaniuk exposes {len(unknown)} unmapped key(s): {', '.join(unknown)}. "
            f"Add to EQUIP_MAP/PERSONNEL_MAP + METRICS here and RU_LOSSES_METRIC_KEYS "
            f"in src/types/index.ts, or extend KNOWN_SOURCE_KEYS if intentionally ignored."
        )
        print(f"\n⚠️  SOURCE DRIFT: {msg}\n", file=sys.stderr)
        if os.environ.get("GITHUB_ACTIONS") == "true":
            print(f"::warning title=ru_losses source drift::{msg}")
    return unknown


def shift_iso(iso: str, days: int) -> str:
    y, m, d = map(int, iso.split("-"))
    return (date_cls(y, m, d) + timedelta(days=days)).isoformat()


def parse_rows(equip: list[dict], personnel: list[dict]) -> dict[str, dict]:
    """Return {loss_date: {"reported_at": report_day, <metric>: value|None}}.

    Merges both files into a per-report-day cumulative record, diffs consecutive
    days into per-day increments, then re-keys each increment to its loss day
    (report day − 1). A column appearing mid-series (UGS backfill) yields None on
    its first day. Negative values are real GS corrections, passed through.
    """
    cum: dict[str, dict[str, int | None]] = {}
    for rec in equip:
        row = cum.setdefault(rec["date"], {})
        for ours, theirs in EQUIP_MAP.items():
            v = rec.get(theirs)
            row[ours] = int(v) if v is not None else None
    for rec in personnel:
        row = cum.setdefault(rec["date"], {})
        for ours, theirs in PERSONNEL_MAP.items():
            v = rec.get(theirs)
            row[ours] = int(v) if v is not None else None

    report_days = sorted(cum)
    if not report_days:
        raise RuntimeError("no records parsed — source shape changed?")
    first = report_days[0]
    prev: dict[str, int | None] = {m: None for m in METRICS}

    out: dict[str, dict] = {}
    for rd in report_days:
        loss_date = shift_iso(rd, REPORT_TO_LOSS_DAY)
        rec = {"reported_at": rd}
        for m in METRICS:
            cur = cum[rd].get(m)
            if cur is None:
                rec[m] = None
            elif prev[m] is None:
                rec[m] = cur if rd == first else None  # baseline vs mid-war backfill
                prev[m] = cur
            else:
                rec[m] = cur - prev[m]
                prev[m] = cur
        out[loss_date] = rec
    return out


def build(db_path: Path, equip: list[dict], personnel: list[dict]) -> tuple[int, int, str]:
    """Append changed/new day-versions into db_path. Never mutates/deletes rows.

    Returns (inserted_rows, distinct_dates, latest_date). Aborts (raises) without
    writing if the payload looks broken, so the caller can skip the R2 upload.
    """
    fetched = parse_rows(equip, personnel)

    # Guard 1: absolute floor — empty/tiny payloads are never legitimate.
    if len(fetched) < MIN_ROWS_FLOOR:
        raise RuntimeError(
            f"parsed only {len(fetched)} days (< floor {MIN_ROWS_FLOOR}) — refusing "
            f"to write {db_path}. Upstream likely returned a partial response."
        )

    cols = ", ".join(f"{m} INTEGER" for m in METRICS)
    metric_cols = ", ".join(METRICS)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            f"CREATE TABLE IF NOT EXISTS daily_losses "
            f"(date TEXT NOT NULL, scraped_at TEXT NOT NULL, reported_at TEXT, {cols}, "
            f"PRIMARY KEY (date, scraped_at))"
        )

        # Latest stored version per date, for change detection.
        latest_rows = conn.execute(
            f"""
            SELECT d.date, {metric_cols}
            FROM daily_losses d
            JOIN (SELECT date, MAX(scraped_at) AS ms FROM daily_losses GROUP BY date) l
              ON d.date = l.date AND d.scraped_at = l.ms
            """
        ).fetchall()
        stored = {r[0]: tuple(r[1:]) for r in latest_rows}

        # Guard 2: we should never see fewer distinct dates than already stored.
        if len(fetched) < len(stored):
            raise RuntimeError(
                f"parsed {len(fetched)} days but DB already has {len(stored)} dates — "
                f"refusing to write a shrinking dataset into {db_path}."
            )

        scraped_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
        to_insert = [
            [date, scraped_at, rec["reported_at"], *[rec[m] for m in METRICS]]
            for date, rec in fetched.items()
            if stored.get(date) != tuple(rec[m] for m in METRICS)  # new date, or changed
        ]

        if to_insert:
            placeholders = ", ".join(["?"] * (len(METRICS) + 3))
            collist = ", ".join(["date", "scraped_at", "reported_at"] + METRICS)
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
    ap = argparse.ArgumentParser(description="Build ru-losses DB from PetroIvaniuk's dataset")
    ap.add_argument(
        "--out",
        default=os.environ.get("RU_LOSSES_DB_PATH", str(SCRIPT_DIR / "output" / DEFAULT_DB_NAME)),
        help="output SQLite path (default: scripts/ru_losses/output/%s)" % DEFAULT_DB_NAME,
    )
    args = ap.parse_args()

    print(f"==> Fetching {EQUIP_URL}\n==> Fetching {PERSONNEL_URL}")
    equip, personnel = fetch()
    check_drift(equip, personnel)
    out = Path(args.out)
    inserted, distinct, latest = build(out, equip, personnel)
    print(
        f"==> Inserted {inserted} new/changed day-versions; "
        f"{distinct} distinct dates (latest {latest}) → {out} ({out.stat().st_size} bytes)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
