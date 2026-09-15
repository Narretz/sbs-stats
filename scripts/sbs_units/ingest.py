#!/usr/bin/env python3
"""
ingest.py
---------
Snapshots each SBS sub-unit's published statistics into data/sbs-units.db.

The grouping total (Угруповання СБС) is NOT here — `scripts/fetch_and_update.py`
already tracks it into sbs.db, and the two are kept in separate files so the
hourly SBS pages don't pay for data only the unit views read.

Three grains, three tables, all the same wide shape as sbs.db's `monthly_stats`
so the frontend's existing MonthlyRow / StatKey / TARGET_IDS carry over
untouched:

    unit_daily_stats     one calendar day   (from the daily + prev_day periods)
    unit_monthly_stats   one calendar month (from the monthly_N periods)
    unit_yearly_stats    one calendar year  (from the yearly_N periods)

Storage model
-------------
Append-on-change, like every scraped dataset here, but with a second brake:
a **capture bucket** in the primary key.

    unit_daily_stats                    bucket = the UTC day of the snapshot
    unit_monthly_stats / _yearly_stats  bucket = the Monday of the UTC ISO week

A run whose bucket row already exists updates it in place instead of appending.
That decouples row count from run frequency entirely: polling hourly and
polling daily produce the same number of rows, only different freshness. It is
a deliberate narrowing of the repo's usual "every fetch is a version" rule, and
the reason it costs nothing is that the interesting history lives elsewhere —
`unit_daily_stats` already carries the shape of a month, so a second
day-by-day record of the same month accumulating in `unit_monthly_stats` would
be 30 rows a month to say what the daily table says better.

What it keeps: the current bucket is refreshed on every run, so the value the
site shows is never more than one run old; and a month picks up ~2 more rows
during its 10-day revision tail, which is where the source's corrections
actually land.

Do NOT derive monthly from daily. They disagree — summing the USF's day-final
values against its own published month reconciles exactly in some months and
runs 1-2.5% high in others, because the source revises a day more than once and
`prev_day` only ever looks one day back. The monthly endpoint absorbs those
later revisions; a sum of dailies cannot. See README.md.

Usage
-----
    python3 scripts/sbs_units/ingest.py                  # current buckets
    python3 scripts/sbs_units/ingest.py --all            # full backfill
    python3 scripts/sbs_units/ingest.py --months 3
    python3 scripts/sbs_units/ingest.py --no-daily --dry-run
"""
from __future__ import annotations

import argparse
import os
import sqlite3
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR.parent) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR.parent))
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from fetch_and_update import (  # noqa: E402
    BASE_STAT_COLS,
    _payload_is_usable,
    _payload_period_start,
    ensure_columns,
    fetch_json,
    parse_api_response,
)
from ingest_log import ann, get_logger  # noqa: E402

from discover import Discovery, Unit, discover  # noqa: E402

log = get_logger("sbs-units")

DB_PATH = os.environ.get("SBS_UNITS_DB_PATH", "data/sbs-units.db")
SUMMARY_PATH = os.environ.get("SUMMARY_PATH", "")

DAILY_TABLE = "unit_daily_stats"
MONTHLY_TABLE = "unit_monthly_stats"
YEARLY_TABLE = "unit_yearly_stats"
STAT_TABLES = (DAILY_TABLE, MONTHLY_TABLE, YEARLY_TABLE)

# How long after a month ends the source keeps revising it. Same window the USF
# ingest uses; it is the reason a closed month is re-read at all.
REVISION_TAIL_DAYS = 10

# The USF ingest is triggered hourly, and one unit run costs ~60 requests
# against a small public API. Because the capture bucket caps row growth,
# running hourly would buy nothing but freshness — the rows are identical. So
# the run no-ops unless this much time has passed, which lets the workflow call
# it on every SBS tick without thinking about it.
DEFAULT_MIN_INTERVAL_HOURS = 6


def hours_since_last_capture(conn: sqlite3.Connection, now: datetime) -> float | None:
    """Age of the newest snapshot in the DB, or None when there is none."""
    newest = None
    for table in STAT_TABLES:
        row = conn.execute(f"SELECT MAX(captured_at) FROM {table}").fetchone()
        if row and row[0] and (newest is None or row[0] > newest):
            newest = row[0]
    if newest is None:
        return None
    try:
        stamp = datetime.fromisoformat(newest)
    except ValueError:
        return None
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=timezone.utc)
    return (now - stamp).total_seconds() / 3600


# ─── Schema ───────────────────────────────────────────────────────────────────

def ensure_schema(conn: sqlite3.Connection) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS units (
            slug            TEXT PRIMARY KEY,
            subdivision_id  TEXT NOT NULL UNIQUE,
            division_id     TEXT,
            title_uk        TEXT,
            title_en        TEXT,
            color           TEXT,
            display_order   INTEGER,
            -- Derived from "still has a live daily period", never a hand-kept
            -- list: the API flags nothing when a unit retires, it just stops
            -- issuing periods for it.
            active          INTEGER NOT NULL,
            has_daily       INTEGER NOT NULL,
            first_month     TEXT,
            last_month      TEXT,
            scraped_at      TEXT NOT NULL
        )
    """)
    for table in STAT_TABLES:
        conn.execute(f"""
            CREATE TABLE IF NOT EXISTS {table} (
                unit_slug          TEXT NOT NULL,
                -- The bucket this row measures: the day, the month's 1st, or
                -- the year's Jan 1.
                date               DATE NOT NULL,
                -- When we captured it, rounded to the bucket that caps row
                -- growth (see the module docstring).
                capture_bucket     TEXT NOT NULL,
                captured_at        TEXT NOT NULL,
                data_collected_at  TEXT,
                last_updated       TEXT,
                personnel_killed            INTEGER,
                personnel_wounded           INTEGER,
                total_targets_hit           INTEGER,
                total_targets_destroyed     INTEGER,
                total_personnel_casualties  INTEGER,
                flights_strike              INTEGER,
                flights_recon               INTEGER,
                PRIMARY KEY (unit_slug, date, capture_bucket)
            )
        """)
    conn.commit()


# ─── Capture buckets ─────────────────────────────────────────────────────────

def capture_bucket(grain: str, now: datetime) -> str:
    """The version key a snapshot taken at `now` lands in.

    Daily rows bucket by day — one settled row per date plus the provisional
    one captured during the day itself. Monthly and yearly bucket by ISO week,
    because a per-day record of a month-to-date counter is 30 rows a month
    restating what `unit_daily_stats` holds at better resolution.
    """
    d = now.date()
    if grain == "daily":
        return d.isoformat()
    return (d - timedelta(days=d.weekday())).isoformat()


# ─── Which buckets to read ───────────────────────────────────────────────────

def months_to_fetch(unit: Unit, today: date, months: int | None, all_months: bool) -> list[str]:
    """The months worth re-reading this run, newest first.

    Everything the unit exposes when backfilling; otherwise the current month
    plus any that ended inside the revision tail. A month the API no longer
    lists has rolled out of its twelve-slot window and is unreachable — see
    README.md, it is why the backfill is a one-shot opportunity.
    """
    if all_months:
        return list(reversed(unit.months))
    out = []
    for m in reversed(unit.months):
        y, mo = map(int, m.split("-"))
        end = date(y + 1, 1, 1) if mo == 12 else date(y, mo + 1, 1)
        if (today - end).days <= REVISION_TAIL_DAYS:
            out.append(m)
        if months is not None and len(out) >= months:
            break
    return out


def years_to_fetch(unit: Unit, today: date, all_years: bool) -> list[str]:
    """Current year only, unless backfilling.

    The yearly rows exist because they are the ONLY figure reachable for a
    month that has already rolled out of the monthly window — not because a
    year-to-date counter is interesting to watch tick.
    """
    if all_years:
        return list(reversed(unit.years))
    return [y for y in unit.years if y == str(today.year)]


# ─── Writing ─────────────────────────────────────────────────────────────────

def _stat_columns(conn: sqlite3.Connection, table: str) -> list[str]:
    cur = conn.execute(f"PRAGMA table_info({table})")
    cols = [r[1] for r in cur.fetchall()]
    return [c for c in cols if c in BASE_STAT_COLS or c.startswith(("hit_", "destroyed_"))]


def _values_for(parsed: dict, targets: dict[int, dict], cols: list[str]) -> tuple:
    out = []
    for c in cols:
        if c.startswith("hit_"):
            out.append(targets.get(int(c.removeprefix("hit_")), {}).get("hit"))
        elif c.startswith("destroyed_"):
            out.append(targets.get(int(c.removeprefix("destroyed_")), {}).get("destroyed"))
        else:
            out.append(parsed.get(c))
    return tuple(out)


def upsert_stats(
    conn: sqlite3.Connection,
    table: str,
    unit_slug: str,
    bucket_date: str,
    bucket: str,
    parsed: dict,
    now_iso: str,
) -> bool:
    """Write one snapshot. False when nothing changed and nothing was written."""
    targets: dict[int, dict] = parsed.get("targets", {})
    ensure_columns(conn, table, list(targets.keys()))

    cols = _stat_columns(conn, table)
    new_vals = _values_for(parsed, targets, cols)

    # Append-on-change sits ON TOP of the bucket cap, not instead of it: a
    # frozen unit (both retired ones) would otherwise accrue a row per week
    # forever, restating numbers that can no longer move.
    latest = conn.execute(
        f"SELECT {', '.join(cols)} FROM {table} WHERE unit_slug = ? AND date = ? "
        "ORDER BY capture_bucket DESC LIMIT 1",
        (unit_slug, bucket_date),
    ).fetchone()
    if latest is not None and tuple(latest) == new_vals:
        return False

    meta = ["unit_slug", "date", "capture_bucket", "captured_at",
            "data_collected_at", "last_updated"]
    all_cols = meta + cols
    values = (
        unit_slug, bucket_date, bucket, now_iso,
        parsed.get("data_collected_at"), parsed.get("last_updated"),
        *new_vals,
    )
    updates = ", ".join(
        f"{c} = excluded.{c}" for c in all_cols
        if c not in ("unit_slug", "date", "capture_bucket")
    )
    conn.execute(
        f"INSERT INTO {table} ({', '.join(all_cols)}) "
        f"VALUES ({', '.join('?' * len(all_cols))}) "
        f"ON CONFLICT(unit_slug, date, capture_bucket) DO UPDATE SET {updates}",
        values,
    )
    return True


def upsert_units(conn: sqlite3.Connection, units: list[Unit], now_iso: str) -> None:
    """Refresh the registry, and say so when a unit's identity moves under us."""
    for u in units:
        prior = conn.execute(
            "SELECT slug, title_en, active FROM units WHERE subdivision_id = ?",
            (u.subdivision_id,),
        ).fetchone()
        if prior is not None:
            if prior[0] != u.slug:
                # The slug is derived from title_en, and it is what the URL and
                # every stored row reference. A silent change would orphan the
                # unit's history and start a second, empty one beside it.
                log.warning(
                    f"unit {u.subdivision_id} slug changed: {prior[0]!r} -> "
                    f"{u.slug!r} (title now {u.title_en!r}). Stored rows still "
                    f"reference {prior[0]!r}; migrate them or pin the slug.",
                    extra=ann(title="sbs-units: unit renamed"),
                )
            if prior[2] and not u.active:
                log.warning(
                    f"unit {u.slug} lost its daily period — treating it as "
                    "retired. Its monthly periods stay readable for now; back "
                    "them up while they last.",
                    extra=ann(title="sbs-units: unit retired"),
                )
        conn.execute(
            """INSERT INTO units (slug, subdivision_id, division_id, title_uk,
                                  title_en, color, display_order, active,
                                  has_daily, first_month, last_month, scraped_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(subdivision_id) DO UPDATE SET
                 slug=excluded.slug, division_id=excluded.division_id,
                 title_uk=excluded.title_uk, title_en=excluded.title_en,
                 color=excluded.color, display_order=excluded.display_order,
                 active=excluded.active, has_daily=excluded.has_daily,
                 first_month=excluded.first_month, last_month=excluded.last_month,
                 scraped_at=excluded.scraped_at""",
            (u.slug, u.subdivision_id, u.division_id, u.title_uk, u.title_en,
             u.color, u.display_order, int(u.active), int(u.active),
             u.first_month, u.last_month, now_iso),
        )


# ─── Fetch one bucket ────────────────────────────────────────────────────────

def read_period(
    disc: Discovery, unit: Unit, period_id: str, what: str, expect_start: str | None,
) -> dict | None:
    """Fetch and validate one (unit, period) payload.

    `expect_start` is the bucket we are about to file it under — "YYYY-MM" or
    "YYYY-MM-DD". The check is not paranoia: the twelve monthly slots are
    re-pointed every year, so a retired unit's `monthly_8` still serves ITS
    August, not this one's.
    """
    url = disc.stats_url(unit.subdivision_id, period_id)
    raw = fetch_json(url)
    data = raw.get("data", {})
    if not _payload_is_usable(data, f"{unit.slug} {what}"):
        return None
    stated = _payload_period_start(data, f"{unit.slug} {what}")
    if expect_start and stated and not stated.startswith(expect_start):
        log.warning(
            f"{unit.slug} {what}: period {period_id} covers {stated}, not "
            f"{expect_start} — skipping rather than filing it under the wrong "
            "bucket.",
            extra=ann(title="sbs-units: period mismatch"),
        )
        return None
    parsed = parse_api_response(raw)
    parsed["stated_start"] = stated
    return parsed


# ─── Main ────────────────────────────────────────────────────────────────────

def run(conn: sqlite3.Connection, disc: Discovery, args) -> list[str]:
    now = datetime.now(timezone.utc)
    now_iso = now.isoformat()
    today = now.date()
    written: list[str] = []

    wanted = {s.strip() for s in args.units.split(",")} if args.units else None

    upsert_units(conn, disc.units, now_iso)
    conn.commit()

    for unit in disc.units:
        if wanted and unit.slug not in wanted:
            continue

        # A unit with no monthly periods has nothing this ingest can store. The
        # rule is derived rather than a name-based exclusion, so a unit that
        # gains months later starts being tracked without a code change.
        if not unit.months:
            log.warning(
                f"{unit.slug} ({unit.title_en}) exposes no monthly periods — "
                "skipping. Nothing to track until the source publishes one.",
                extra=ann(level="notice", title="sbs-units: unit has no monthly data"),
            )
            continue

        # ── Monthly ──────────────────────────────────────────────────────────
        bucket = capture_bucket("monthly", now)
        for month in months_to_fetch(unit, today, args.months, args.all):
            pid = disc.monthly.get((unit.subdivision_id, month))
            if not pid:
                continue
            parsed = read_period(disc, unit, pid, f"monthly {month}", month)
            if parsed is None:
                continue
            if upsert_stats(conn, MONTHLY_TABLE, unit.slug, f"{month}-01",
                            bucket, parsed, now_iso):
                written.append(f"{unit.slug} monthly {month}")

        # ── Yearly ───────────────────────────────────────────────────────────
        if not args.no_yearly:
            for year in years_to_fetch(unit, today, args.all):
                pid = disc.yearly.get((unit.subdivision_id, year))
                if not pid:
                    continue
                parsed = read_period(disc, unit, pid, f"yearly {year}", year)
                if parsed is None:
                    continue
                if upsert_stats(conn, YEARLY_TABLE, unit.slug, f"{year}-01-01",
                                bucket, parsed, now_iso):
                    written.append(f"{unit.slug} yearly {year}")

        # ── Daily ────────────────────────────────────────────────────────────
        # No backfill exists for this grain: only "today" and "yesterday" are
        # addressable, so the series starts the day this is switched on and can
        # never be filled in behind.
        if args.no_daily:
            continue
        day_bucket = capture_bucket("daily", now)
        for kind in ("prev_day", "daily"):
            pid = disc.intraday.get(unit.subdivision_id, {}).get(kind)
            if not pid:
                continue
            # The endpoint states which day it covers; that is the row's date.
            # Deriving it from the clock instead is how a lagging endpoint gets
            # filed as a correction to the wrong day.
            parsed = read_period(disc, unit, pid, kind, None)
            if parsed is None:
                continue
            day = parsed.get("stated_start")
            if not day:
                continue
            if upsert_stats(conn, DAILY_TABLE, unit.slug, day,
                            day_bucket, parsed, now_iso):
                written.append(f"{unit.slug} {kind} {day}")

        conn.commit()

    return written


def main() -> None:
    p = argparse.ArgumentParser(description="Ingest SBS sub-unit statistics")
    p.add_argument("--db", default=DB_PATH, help=f"SQLite path (default {DB_PATH})")
    p.add_argument("--all", action="store_true",
                   help="every month and year the API still exposes (backfill)")
    p.add_argument("--months", type=int, default=None,
                   help="cap how many recent months to re-read")
    p.add_argument("--units", default=None, help="comma-separated slugs, for debugging")
    p.add_argument("--no-daily", action="store_true", help="skip the daily grain")
    p.add_argument("--no-yearly", action="store_true", help="skip the yearly grain")
    p.add_argument("--dry-run", action="store_true", help="roll back instead of committing")
    p.add_argument("--min-interval-hours", type=float, default=DEFAULT_MIN_INTERVAL_HOURS,
                   help=f"no-op if the last capture is newer than this "
                        f"(default {DEFAULT_MIN_INTERVAL_HOURS}; 0 disables). "
                        "Ignored by --all.")
    args = p.parse_args()

    db_dir = os.path.dirname(args.db)
    if db_dir:
        os.makedirs(db_dir, exist_ok=True)

    # Cheap check before the ~60 requests discovery and ingest would cost.
    if args.min_interval_hours and not args.all and os.path.exists(args.db):
        probe = sqlite3.connect(args.db)
        try:
            ensure_schema(probe)
            age = hours_since_last_capture(probe, datetime.now(timezone.utc))
        finally:
            probe.close()
        if age is not None and age < args.min_interval_hours:
            print(f"Last capture was {age:.1f}h ago (< {args.min_interval_hours}h) — "
                  "nothing to do.")
            if SUMMARY_PATH and not args.dry_run:
                with open(SUMMARY_PATH, "w") as f:
                    f.write("skipped (too soon)")
            return

    print("Discovering units…")
    disc = discover()
    print(f"  {len(disc.units)} units, {len(disc.monthly)} monthly / "
          f"{len(disc.yearly)} yearly periods")

    conn = sqlite3.connect(args.db)
    ensure_schema(conn)
    try:
        written = run(conn, disc, args)
        if args.dry_run:
            conn.rollback()
            print(f"[DRY RUN] {len(written)} row(s) would have been written")
        else:
            conn.commit()
    finally:
        conn.close()

    summary = f"{len(written)} row(s)" if written else "no changes"
    print(f"Done. {summary}")
    for w in written[:40]:
        print(f"  {w}")
    if len(written) > 40:
        print(f"  … and {len(written) - 40} more")
    if SUMMARY_PATH and not args.dry_run:
        with open(SUMMARY_PATH, "w") as f:
            f.write(summary)


if __name__ == "__main__":
    main()
