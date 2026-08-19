#!/usr/bin/env python3
"""
ingest.py — build ua-losses.db from ualosses.org's UKR_ualosses_Personnel.xlsx.

Source: ualosses.org publishes a workbook of confirmed Ukrainian military
personnel losses — individually researched, named records — with pre-aggregated
daily time-series sheets. We ingest the two daily sheets:

  ByDay        — Date, Number (losses recorded that day, all statuses),
                 ofwhich_Male, meanAgeEvent, CumNumber, ...
  ByDayStatus  — Date, Dead, Missing, Prisoner, Released
                 (the status split of that day's Number).

`Number` is already a per-day incremental count (`CumNumber` carries the
cumulative), so no cumulative→daily diffing is needed. The two sheets join on
Date, and the status columns sum *exactly* to `Number` on every date — so one
date key carries both the headline total and its status breakdown.

APPEND-ONLY / EDIT-VERSIONED (mirrors mediazona / ru_losses / wartears). A stored
row is never mutated or deleted. Each row is one *version* of that date's numbers,
tagged with `scraped_at` (ingest UTC). ualosses continuously revises past days
upward as more deaths get identified (a death months ago may be added today), so
each run compares parsed values against the latest stored version per date and
INSERTs a NEW row only where they differ (or the date is new). The frontend reads
the latest snapshot per date.

A row-count floor + a no-shrink guard abort the build (without writing) if the
workbook looks truncated, so a partial/empty download leaves the DB untouched.

Requires openpyxl (the xlsx is a zip of XML; we stream sheets read-only).
"""

from __future__ import annotations

import argparse
import os
import sqlite3
import sys
from datetime import date as date_cls, datetime, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[1]
DEFAULT_DB_NAME = os.environ.get("UA_LOSSES_DB_NAME", "ua-losses.db")
DEFAULT_XLSX = os.environ.get(
    "UA_LOSSES_XLSX", str(REPO_ROOT / "sources" / "ualosses" / "UKR_ualosses_Personnel.xlsx")
)

SHEET_BYDAY = "ByDay"
SHEET_STATUS = "ByDayStatus"

# The war began 2022-02-24; ualosses' workbook also carries a long pre-war tail
# (Donbas-era and older records) that isn't relevant to this dashboard, so we
# default to war-scoping the DB. Override with --all-dates.
WAR_START = "2022-02-24"

# Integer metric columns, in storage order. `number` is the day's total losses
# (all statuses); dead/missing/prisoner/released are its status split; male is
# `ofwhich_Male`. `mean_age` (REAL) is stored separately because it's nullable
# and not summable.
METRIC_INT_COLS = ["number", "dead", "missing", "prisoner", "released", "male"]

# ~1.5 years of war by any real export. Far below this = truncated workbook.
MIN_ROWS_FLOOR = 365


# ── value coercion ────────────────────────────────────────────────────────────
def _int0(v) -> int:
    """A blank/None cell in a daily count means a genuine zero for that day."""
    if v is None or v == "":
        return 0
    return int(v)


def _round_age(v) -> float | None:
    """meanAgeEvent is a high-precision float; round to 2dp so re-ingests don't
    log spurious 'revised' rows from float noise. None on a zero-death day."""
    if v is None or v == "":
        return None
    return round(float(v), 2)


def _date_iso(v) -> str | None:
    """Normalise a Date cell (datetime, date, or 'YYYY-MM-DD…' string) to
    'YYYY-MM-DD'. Returns None for a blank/unparseable cell (e.g. header echo)."""
    if v is None or v == "":
        return None
    if isinstance(v, datetime):
        return v.date().isoformat()
    if isinstance(v, date_cls):
        return v.isoformat()
    s = str(v).strip()
    # Accept 'YYYY-MM-DD' possibly with a trailing time component.
    head = s[:10]
    try:
        date_cls.fromisoformat(head)
        return head
    except ValueError:
        return None


# ── sheet parsing (pure, so tests need no xlsx) ───────────────────────────────
def _rows_to_dicts(sheet_rows):
    """Turn an iterable whose first item is the header tuple into header-keyed
    dicts. Works with openpyxl's streaming `iter_rows(values_only=True)`."""
    it = iter(sheet_rows)
    header = list(next(it))
    for r in it:
        yield dict(zip(header, r))


def index_byday(sheet_rows) -> dict[str, tuple[int, int, float | None]]:
    """{date_iso: (number, male, mean_age)}."""
    out: dict[str, tuple[int, int, float | None]] = {}
    for rec in _rows_to_dicts(sheet_rows):
        d = _date_iso(rec.get("Date"))
        if d is None:
            continue
        out[d] = (_int0(rec.get("Number")), _int0(rec.get("ofwhich_Male")),
                  _round_age(rec.get("meanAgeEvent")))
    return out


def index_status(sheet_rows) -> dict[str, tuple[int, int, int, int]]:
    """{date_iso: (dead, missing, prisoner, released)}."""
    out: dict[str, tuple[int, int, int, int]] = {}
    for rec in _rows_to_dicts(sheet_rows):
        d = _date_iso(rec.get("Date"))
        if d is None:
            continue
        out[d] = (_int0(rec.get("Dead")), _int0(rec.get("Missing")),
                  _int0(rec.get("Prisoner")), _int0(rec.get("Released")))
    return out


def join_daily(byday: dict, status: dict, since: str | None) -> list[tuple]:
    """Join the two indexed sheets on date into storage tuples:
        (date, number, dead, missing, prisoner, released, male, mean_age)
    A date present in ByDay but absent from ByDayStatus gets zero statuses.
    Rows before `since` (when set) are dropped."""
    rows: list[tuple] = []
    for d in sorted(byday):
        if since and d < since:
            continue
        number, male, mean_age = byday[d]
        dead, missing, prisoner, released = status.get(d, (0, 0, 0, 0))
        rows.append((d, number, dead, missing, prisoner, released, male, mean_age))
    return rows


def parse_workbook(xlsx_path: Path, since: str | None) -> list[tuple]:
    """Read the two daily sheets from the workbook and return storage tuples."""
    import openpyxl  # lazy — keeps `--help` and imports cheap without the dep

    wb = openpyxl.load_workbook(xlsx_path, read_only=True, data_only=True)
    try:
        missing = [s for s in (SHEET_BYDAY, SHEET_STATUS) if s not in wb.sheetnames]
        if missing:
            raise RuntimeError(
                f"{xlsx_path} is missing sheet(s) {missing}; found {wb.sheetnames}. "
                f"Is this the ualosses UKR_ualosses_Personnel workbook?"
            )
        byday = index_byday(wb[SHEET_BYDAY].iter_rows(values_only=True))
        status = index_status(wb[SHEET_STATUS].iter_rows(values_only=True))
    finally:
        wb.close()
    return join_daily(byday, status, since)


# ── DB build (append-version, guarded) ────────────────────────────────────────
def build(db_path: Path, rows: list[tuple], scraped_at: str) -> dict:
    """Append changed/new date-versions into db_path. Never mutates/deletes rows.

    Returns a summary dict: new / revised / unchanged / distinct. Aborts (raises)
    without writing if the payload looks broken or would shrink the dataset.
    """
    # Guard 1: absolute floor.
    if len(rows) < MIN_ROWS_FLOOR:
        raise RuntimeError(
            f"parsed only {len(rows)} day-rows (< floor {MIN_ROWS_FLOOR}) — refusing "
            f"to write {db_path}; the workbook is probably truncated."
        )

    int_cols_sql = ", ".join(f"{c} INTEGER NOT NULL DEFAULT 0" for c in METRIC_INT_COLS)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    try:
        conn.executescript(
            f"""
            CREATE TABLE IF NOT EXISTS daily_losses (
                date TEXT NOT NULL,
                scraped_at TEXT NOT NULL,
                {int_cols_sql},
                mean_age REAL,
                PRIMARY KEY (date, scraped_at)
            );
            """
        )

        # Latest stored version per date, for change detection (mirrors the
        # ru_losses / mediazona LATEST_PER_DATE pattern).
        metric_sql = ", ".join(METRIC_INT_COLS + ["mean_age"])
        latest = {
            r[0]: tuple(r[1:])
            for r in conn.execute(
                f"""
                SELECT d.date, {metric_sql}
                FROM daily_losses d
                JOIN (SELECT date, MAX(scraped_at) AS ms FROM daily_losses GROUP BY date) l
                  ON d.date = l.date AND d.scraped_at = l.ms
                """
            ).fetchall()
        }

        # Guard 2: shrink — a fresh export should never carry fewer distinct
        # dates than what's already stored. Catches a half-empty workbook that
        # slipped past Guard 1.
        if len(rows) < len(latest):
            raise RuntimeError(
                f"parsed {len(rows)} dates but DB already has {len(latest)} — "
                f"refusing to write a shrinking dataset into {db_path}."
            )

        to_insert: list[tuple] = []
        new = revised = unchanged = 0
        for row in rows:
            d, *vals = row
            prior = latest.get(d)
            if prior is None:
                new += 1
                to_insert.append((d, scraped_at, *vals))
            elif prior != tuple(vals):
                revised += 1
                to_insert.append((d, scraped_at, *vals))
            else:
                unchanged += 1

        if to_insert:
            cols = ", ".join(["date", "scraped_at"] + METRIC_INT_COLS + ["mean_age"])
            ph = ", ".join(["?"] * (2 + len(METRIC_INT_COLS) + 1))
            conn.executemany(f"INSERT INTO daily_losses ({cols}) VALUES ({ph})", to_insert)
            conn.commit()
            conn.execute("VACUUM")
            conn.commit()

        distinct = conn.execute("SELECT COUNT(DISTINCT date) FROM daily_losses").fetchone()[0]
    finally:
        conn.close()
    return {"new": new, "revised": revised, "unchanged": unchanged, "distinct": distinct}


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Append-version ua-losses.db from ualosses.org's daily xlsx sheets.",
    )
    ap.add_argument("--xlsx", default=DEFAULT_XLSX,
                    help="path to UKR_ualosses_Personnel.xlsx (default: %(default)s)")
    ap.add_argument("--since", default=WAR_START,
                    help="drop dates before this YYYY-MM-DD (default: %(default)s)")
    ap.add_argument("--all-dates", action="store_true",
                    help="keep the full pre-war tail (overrides --since)")
    ap.add_argument("--out", default=os.environ.get(
        "UA_LOSSES_DB_PATH", str(SCRIPT_DIR / "output" / DEFAULT_DB_NAME)),
        help="output SQLite path (default: scripts/ua_losses/output/%s)" % DEFAULT_DB_NAME)
    ap.add_argument("--dry-run", action="store_true",
                    help="parse + report what would change, without writing")
    args = ap.parse_args()

    since = None if args.all_dates else args.since
    if since is not None:
        try:
            date_cls.fromisoformat(since)
        except ValueError:
            raise SystemExit(f"--since must be YYYY-MM-DD, got {since!r}")

    xlsx = Path(args.xlsx)
    if not xlsx.exists():
        raise SystemExit(f"xlsx not found: {xlsx}")
    rows = parse_workbook(xlsx, since)

    total = sum(r[1] for r in rows)
    span = f"{rows[0][0]}..{rows[-1][0]}" if rows else "(empty)"
    print(f"[parse] {len(rows)} day-rows {span}; sum(number)={total}"
          f"{'' if since is None else f'  (since {since})'}")

    if args.dry_run:
        # Emulate build()'s change detection against any existing DB, no write.
        out = Path(args.out)
        prior_n = 0
        if out.exists():
            conn = sqlite3.connect(out)
            try:
                prior_n = conn.execute("SELECT COUNT(DISTINCT date) FROM daily_losses").fetchone()[0]
            except sqlite3.OperationalError:
                prior_n = 0
            finally:
                conn.close()
        print(f"[dry-run] would guard against floor={MIN_ROWS_FLOOR}, "
              f"existing distinct dates={prior_n}; no write.")
        return 0

    scraped_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    out = Path(args.out)
    s = build(out, rows, scraped_at)
    print(
        f"==> {s['new']:>4} new, {s['revised']:>4} revised, {s['unchanged']:>4} unchanged "
        f"-> {s['new'] + s['revised']} inserted; {s['distinct']} distinct dates\n"
        f"==> scraped_at={scraped_at}\n"
        f"==> {out} ({out.stat().st_size} bytes)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
