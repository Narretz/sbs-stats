#!/usr/bin/env python3
"""Front-line weather → data/weather.db. Stdlib only.

    python3 scripts/weather/ingest.py                     # the hourly run (CI)
    python3 scripts/weather/ingest.py --backfill-from 2025-10-26   # one-off history

What a run does (schema.sql explains each table):

  live      one request for every sector, from three days back (further, to
            close a gap a missed run left — up to the ~90 days the live
            endpoint serves) to the end of tomorrow. Hours already past go to
            `hourly`, overwriting each unsettled row and marking it settled
            once it is 48 h old; hours ahead replace `forecast` whole. The
            first run at or after 06:00 Kyiv each day also keeps today's and
            tomorrow's hours in `forecast_snapshot`.
  backfill  Open-Meteo's archive of past runs (historical-forecast API), in
            month-sized requests, up to three days ago — where the live run
            takes over. Every row it writes is already settled.

Writes `changed=true|false` to $GITHUB_OUTPUT for the upload gate. In
practice a live run always changes something — the forecast moves every hour
and the strip shows it — so the gate matters for a re-run, not the schedule.
"""
from __future__ import annotations

import argparse
import os
import sqlite3
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))
# Shared diagnostics sink (scripts/ingest_log.py); `scripts/` isn't a package.
if str(SCRIPT_DIR.parent) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR.parent))

import openmeteo  # noqa: E402
from ingest_log import ann, get_logger  # noqa: E402
from openmeteo import ARCHIVE_URL, FORECAST_URL, HOURLY, OpenMeteoError, request_url  # noqa: E402
from sectors import SECTORS, Sector  # noqa: E402

log = get_logger("weather")

KYIV = ZoneInfo(openmeteo.TZ)
SCHEMA = SCRIPT_DIR / "schema.sql"
DEFAULT_DB = SCRIPT_DIR.parent.parent / "data" / "weather.db"

SETTLE_AFTER = timedelta(hours=48)
# Re-read this far back every run, so each hour gets its last writes before it
# settles: a day more than the settling window.
LIVE_LOOKBACK_DAYS = 3
# The live endpoint's reach into the past; beyond it only the archive helps.
LIVE_MAX_PAST_DAYS = openmeteo.FORECAST_MAX_PAST_DAYS - 1
SNAPSHOT_HOUR = 6
BACKFILL_CHUNK_DAYS = 31
BACKFILL_PAUSE_S = 2.0

COLUMNS = HOURLY  # stored exactly as requested


# ── db ──────────────────────────────────────────────────────────────────────

def connect(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.executescript(SCHEMA.read_text())
    return conn


def sync_sectors(conn: sqlite3.Connection, sectors: tuple[Sector, ...] = SECTORS) -> None:
    for i, s in enumerate(sectors):
        conn.execute(
            """INSERT INTO sectors (key, gsua, near, lat, lon, placed, sort)
               VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(key) DO UPDATE SET gsua = excluded.gsua, near = excluded.near,
                 lat = excluded.lat, lon = excluded.lon, placed = excluded.placed,
                 sort = excluded.sort""",
            (s.key, ",".join(s.labels), s.near, s.lat, s.lon, s.placed, i),
        )


_COLS = ", ".join(COLUMNS)
_MARKS = ", ".join("?" for _ in COLUMNS)
_SET = ", ".join(f"{c} = excluded.{c}" for c in COLUMNS)
_DIFFERS = " OR ".join(f"hourly.{c} IS NOT excluded.{c}" for c in COLUMNS)

# A settled row is never written again; an unsettled one only when the run
# brings something new — a value, or the step to settled.
_UPSERT_HOURLY = f"""
INSERT INTO hourly (sector, time, {_COLS}, source, fetched_at, settled)
VALUES (?, ?, {_MARKS}, ?, ?, ?)
ON CONFLICT(sector, time) DO UPDATE SET {_SET},
    source = excluded.source, fetched_at = excluded.fetched_at, settled = excluded.settled
WHERE hourly.settled = 0 AND ({_DIFFERS} OR hourly.settled IS NOT excluded.settled)
"""


def _values(row: dict) -> tuple:
    return tuple(row.get(c) for c in COLUMNS)


def store(conn: sqlite3.Connection, sectors: list[Sector], series: list[list[dict]],
          now_local: datetime, fetched_at: str, source: str,
          take_snapshot: bool) -> tuple[int, int, bool]:
    """Write one fetch. Returns (hourly rows changed, forecast rows, snapshot stored)."""
    settle_before = now_local - SETTLE_AFTER
    today = now_local.date()
    snapshot_days = {today.isoformat(), (today + timedelta(days=1)).isoformat()}
    before = conn.total_changes
    future: list[tuple] = []
    snap: list[tuple] = []
    for sec, rows in zip(sectors, series):
        for row in rows:
            t = datetime.fromisoformat(row["time"])
            vals = _values(row)
            if t < now_local:
                conn.execute(_UPSERT_HOURLY, (sec.key, row["time"], *vals, source, fetched_at,
                                              int(t < settle_before)))
            else:
                future.append((sec.key, row["time"], *vals, fetched_at))
            if take_snapshot and row["time"][:10] in snapshot_days:
                snap.append((today.isoformat(), sec.key, row["time"], *vals, fetched_at))
    hourly_changed = conn.total_changes - before

    if source == "forecast":
        # Hours that have since passed go with the old forecast: from now on
        # they live in `hourly`.
        conn.execute("DELETE FROM forecast")
        conn.executemany(
            f"INSERT INTO forecast (sector, time, {_COLS}, fetched_at) VALUES (?, ?, {_MARKS}, ?)",
            future)
    if snap:
        conn.executemany(
            f"""INSERT OR IGNORE INTO forecast_snapshot
                (snapshot_date, sector, time, {_COLS}, fetched_at)
                VALUES (?, ?, ?, {_MARKS}, ?)""", snap)
    return hourly_changed, len(future), bool(snap)


def needs_snapshot(conn: sqlite3.Connection, now_local: datetime) -> bool:
    if now_local.hour < SNAPSHOT_HOUR:
        return False
    return conn.execute("SELECT 1 FROM forecast_snapshot WHERE snapshot_date = ? LIMIT 1",
                        (now_local.date().isoformat(),)).fetchone() is None


def live_start(conn: sqlite3.Connection, today: date) -> date:
    """Three days back, or further to close a gap — within the live endpoint's reach."""
    start = today - timedelta(days=LIVE_LOOKBACK_DAYS)
    last = conn.execute("SELECT MAX(time) FROM hourly").fetchone()[0]
    if last is None:
        return start
    last_day = date.fromisoformat(last[:10])
    if last_day >= start:
        return start
    floor = today - timedelta(days=LIVE_MAX_PAST_DAYS)
    if last_day < floor:
        log.warning(
            f"hourly ends {last_day}, beyond the live endpoint's {LIVE_MAX_PAST_DAYS}-day reach: "
            f"{last_day} to {floor} stays a gap until a run with backfill_from={last_day}",
            extra=ann(title="weather gap needs a backfill"))
        return floor
    log.info(f"closing a gap: hourly ends {last_day}, re-reading from there")
    return last_day


def record_run(conn: sqlite3.Connection, fetched_at: str, mode: str, start: date, end: date,
               hourly_changed: int, forecast_rows: int, snapshot: bool) -> None:
    conn.execute("INSERT OR REPLACE INTO runs VALUES (?, ?, ?, ?, ?, ?, ?)",
                 (fetched_at, mode, start.isoformat(), end.isoformat(),
                  hourly_changed, forecast_rows, int(snapshot)))


# ── checks ──────────────────────────────────────────────────────────────────

def check(sectors: list[Sector], series: list[list[dict]], start: date, end: date) -> None:
    """A field the model stopped serving reads as calm weather downstream —
    say so rather than rate a fog-free day."""
    expected = ((end - start).days + 1) * 24
    for sec, rows in zip(sectors, series):
        if len(rows) < expected - 1:  # a DST change day can be an hour short
            log.warning(f"{sec.key}: {len(rows)} hours for {start}..{end}, expected {expected}",
                        extra=ann(title="weather hours missing"))
        for col in COLUMNS:
            if rows and all(r.get(col) is None for r in rows):
                log.warning(f"{sec.key}: Open-Meteo returned no {col} for {start}..{end}",
                            extra=ann(title="weather field missing"))


# ── modes ───────────────────────────────────────────────────────────────────

def _fetch(base: str, sectors: list[Sector], start: date, end: date) -> list[list[dict]]:
    url = request_url(base, sectors, start, end)
    return openmeteo.hourly_rows(openmeteo.fetch(url), len(sectors))


def run_live(conn: sqlite3.Connection, now_utc: datetime, fetch=_fetch) -> bool:
    now_local = now_utc.astimezone(KYIV).replace(tzinfo=None)
    today = now_local.date()
    sectors = list(SECTORS)
    start, end = live_start(conn, today), today + timedelta(days=1)
    series = fetch(FORECAST_URL, sectors, start, end)
    check(sectors, series, start, end)
    fetched_at = now_utc.strftime("%Y-%m-%dT%H:%M:%SZ")
    snap = needs_snapshot(conn, now_local)
    changed, n_forecast, stored = store(conn, sectors, series, now_local, fetched_at,
                                        "forecast", snap)
    record_run(conn, fetched_at, "live", start, end, changed, n_forecast, stored)
    log.info(f"live {start}..{end}: {changed} hourly rows changed, {n_forecast} forecast rows"
             + (", snapshot stored" if stored else ""))
    # The forecast moves every hour, and the strip shows it.
    return changed > 0 or n_forecast > 0 or stored


def run_backfill(conn: sqlite3.Connection, now_utc: datetime, first: date,
                 fetch=_fetch, pause=time.sleep) -> bool:
    now_local = now_utc.astimezone(KYIV).replace(tzinfo=None)
    last = now_local.date() - timedelta(days=LIVE_LOOKBACK_DAYS)
    sectors = list(SECTORS)
    total = 0
    start = first
    while start <= last:
        end = min(start + timedelta(days=BACKFILL_CHUNK_DAYS - 1), last)
        series = fetch(ARCHIVE_URL, sectors, start, end)
        check(sectors, series, start, end)
        fetched_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        changed, _, _ = store(conn, sectors, series, now_local, fetched_at, "archive", False)
        record_run(conn, fetched_at, "backfill", start, end, changed, 0, False)
        conn.commit()
        log.info(f"backfill {start}..{end}: {changed} hourly rows written")
        total += changed
        start = end + timedelta(days=1)
        if start <= last:
            pause(BACKFILL_PAUSE_S)
    return total > 0


def _emit_changed(changed: bool) -> None:
    """Tell the workflow whether to re-upload."""
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a", encoding="utf-8") as fh:
            fh.write(f"changed={'true' if changed else 'false'}\n")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0],
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", type=Path, default=DEFAULT_DB, help=f"default {DEFAULT_DB}")
    ap.add_argument("--backfill-from", type=date.fromisoformat, metavar="YYYY-MM-DD",
                    help="fill `hourly` from the archive from this day, then do the live run")
    ap.add_argument("--now", type=datetime.fromisoformat,
                    help="pretend it is this UTC time (tests, re-runs)")
    args = ap.parse_args(argv)

    now_utc = (args.now.replace(tzinfo=timezone.utc) if args.now and args.now.tzinfo is None
               else args.now or datetime.now(timezone.utc))
    conn = connect(args.db)
    changed = False
    try:
        sync_sectors(conn)
        if args.backfill_from:
            changed |= run_backfill(conn, now_utc, args.backfill_from)
            conn.commit()
        changed |= run_live(conn, now_utc)
        conn.commit()
    except OpenMeteoError as e:
        # What was committed before the failure (a backfill's months) is
        # still worth uploading; the workflow uploads on `changed` even when
        # this step fails.
        log.error(f"Open-Meteo {e}", extra=ann(title="weather fetch failed"))
        _emit_changed(changed)
        return 1
    finally:
        conn.close()
    _emit_changed(changed)
    return 0


if __name__ == "__main__":
    sys.exit(main())
