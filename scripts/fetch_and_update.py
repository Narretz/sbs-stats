#!/usr/bin/env python3
"""
fetch_and_update.py
-------------------
Fetches latest battlefield data from sbs-group.army and writes it into data/sbs.db.
Runs on a cron schedule via GitHub Actions (.github/workflows/update-db.yml).
"""

import argparse
import os
import sqlite3
import time
import zoneinfo
import requests
from datetime import datetime, timedelta, timezone

DB_PATH = os.environ.get("DB_PATH", "data/sbs.db")
KYIV_TZ = zoneinfo.ZoneInfo("Europe/Kyiv")
SUBDIVISION_ID = "68b0c85589944c4bfb2a5edc"

# ─── API endpoints ────────────────────────────────────────────────────────────

BASE_PUBLIC_URL = "https://sbs-group.army/api/public"
DAILY_URL = f"{BASE_PUBLIC_URL}/statistics/{SUBDIVISION_ID}/68fa98652f31834f2e051459"
PREVIOUS_DAY_URL = f"{BASE_PUBLIC_URL}/statistics/{SUBDIVISION_ID}/68b4852e792cdf918400daf1"
PERIODS_URL = f"{BASE_PUBLIC_URL}/periods"

FALLBACK_MONTHLY_URLS: dict[str, str] = {
    "2025-06": "https://sbs-group.army/api/public/statistics/68b0c85589944c4bfb2a5edc/68e4e5d484f8ca462d9a7c77",
    "2025-07": "https://sbs-group.army/api/public/statistics/68b0c85589944c4bfb2a5edc/68e4e67684f8ca462d9a80db",
    "2025-08": "https://sbs-group.army/api/public/statistics/68b0c85589944c4bfb2a5edc/68b47e50792cdf918400b06c",
    "2025-09": "https://sbs-group.army/api/public/statistics/68b0c85589944c4bfb2a5edc/68b1c0f79d5ff32bdf80e705",
    "2025-10": "https://sbs-group.army/api/public/statistics/68b0c85589944c4bfb2a5edc/68dd1906de22367a4e908027",
    "2025-11": "https://sbs-group.army/api/public/statistics/68b0c85589944c4bfb2a5edc/690531b56519eae72cea27b4",
    "2025-12": "https://sbs-group.army/api/public/statistics/68b0c85589944c4bfb2a5edc/692cbeb9145504ee2b0171e5",
    "2026-01": "https://sbs-group.army/api/public/statistics/68b0c85589944c4bfb2a5edc/69559d35869d2691543f313f",
    "2026-02": "https://sbs-group.army/api/public/statistics/68b0c85589944c4bfb2a5edc/697e7bbb1ae0eb20ad9dbf56",
    "2026-03": "https://sbs-group.army/api/public/statistics/68b0c85589944c4bfb2a5edc/69a365b5e9679075a2e69d57",
    "2026-04": "https://sbs-group.army/api/public/statistics/68b0c85589944c4bfb2a5edc/69cc3630d5f5789a478b2f7b",
}

REQUEST_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/136.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Connection": "keep-alive",
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
}

# ─── Schema ───────────────────────────────────────────────────────────────────

def ensure_schema(conn: sqlite3.Connection) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS daily_stats (
            date DATE,
            hour INTEGER,
            data_collected_at TEXT,
            last_updated DATETIME,
            personnel_killed INTEGER,
            personnel_wounded INTEGER,
            total_targets_hit INTEGER,
            total_targets_destroyed INTEGER,
            total_personnel_casualties INTEGER,
            flights_strike INTEGER,
            flights_recon INTEGER,
            PRIMARY KEY (date, hour)
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS monthly_stats (
            date DATE,
            data_collected_at TEXT,
            last_updated DATETIME,
            personnel_killed INTEGER,
            personnel_wounded INTEGER,
            total_targets_hit INTEGER,
            total_targets_destroyed INTEGER,
            total_personnel_casualties INTEGER,
            flights_strike INTEGER,
            flights_recon INTEGER,
            PRIMARY KEY (date, data_collected_at)
        )
    """)
    conn.commit()
    # Migrate monthly_stats if it still has the old PRIMARY KEY (date) only
    _migrate_monthly_pk(conn)
    # Migrate existing tables that predate flights columns
    _migrate_flight_columns(conn)


def _migrate_monthly_pk(conn: sqlite3.Connection) -> None:
    """Migrate monthly_stats from PRIMARY KEY (date) to PRIMARY KEY (date, data_collected_at)."""
    # Check current primary key columns
    cur = conn.execute("PRAGMA table_info(monthly_stats)")
    pk_cols = [row[1] for row in cur.fetchall() if row[5] > 0]  # row[5] = pk index
    if "data_collected_at" in pk_cols:
        return  # Already migrated

    print("  Migrating monthly_stats primary key...")
    # Get all existing columns
    cur = conn.execute("PRAGMA table_info(monthly_stats)")
    columns = [row[1] for row in cur.fetchall()]
    col_list = ", ".join(columns)

    conn.execute(f"ALTER TABLE monthly_stats RENAME TO monthly_stats_old")
    conn.execute(f"""
        CREATE TABLE monthly_stats (
            date DATE,
            data_collected_at TEXT,
            last_updated DATETIME,
            personnel_killed INTEGER,
            personnel_wounded INTEGER,
            total_targets_hit INTEGER,
            total_targets_destroyed INTEGER,
            total_personnel_casualties INTEGER,
            PRIMARY KEY (date, data_collected_at)
        )
    """)
    # Re-add any dynamic target columns from the old table
    cur = conn.execute("PRAGMA table_info(monthly_stats)")
    new_cols = {row[1] for row in cur.fetchall()}
    for col in columns:
        if col not in new_cols:
            conn.execute(f"ALTER TABLE monthly_stats ADD COLUMN {col} INTEGER")
    # Copy data
    conn.execute(f"INSERT INTO monthly_stats ({col_list}) SELECT {col_list} FROM monthly_stats_old")
    conn.execute("DROP TABLE monthly_stats_old")
    conn.commit()
    print("  [OK] monthly_stats migrated to PRIMARY KEY (date, data_collected_at)")


def _migrate_flight_columns(conn: sqlite3.Connection) -> None:
    """Add flights_strike / flights_recon columns to existing tables if missing."""
    for table in ("daily_stats", "monthly_stats"):
        cur = conn.execute(f"PRAGMA table_info({table})")
        existing = {row[1] for row in cur.fetchall()}
        for col in ("flights_strike", "flights_recon"):
            if col not in existing:
                print(f"  Adding column {table}.{col}")
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} INTEGER")
    conn.commit()


def ensure_columns(conn: sqlite3.Connection, table: str, target_ids: list[int]) -> None:
    """Dynamically add hit_X / destroyed_X columns if they don't exist yet."""
    cur = conn.cursor()
    cur.execute(f"PRAGMA table_info({table})")
    existing = {row[1] for row in cur.fetchall()}
    for tid in target_ids:
        for prefix in ("hit", "destroyed"):
            col = f"{prefix}_{tid}"
            if col not in existing:
                print(f"  Adding column {table}.{col}")
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} INTEGER")
    conn.commit()


# ─── HTTP fetch with retries ──────────────────────────────────────────────────

def fetch_json(url: str, retries: int = 5, backoff: int = 5) -> dict:
    session = requests.Session()
    session.headers.update(REQUEST_HEADERS)

    for attempt in range(1, retries + 1):
        now = datetime.now().strftime("[%d.%m.%Y %H:%M:%S]")
        try:
            response = session.get(url, timeout=15)
            response.raise_for_status()
            return response.json()
        except requests.exceptions.HTTPError as e:
            if "525" in str(e):
                print(f"[WARN] {now} HTTP 525 (SSL Handshake Failed). Attempt {attempt}/{retries}...")
                if attempt < retries:
                    time.sleep(backoff * attempt)
                    continue
            raise
        except requests.exceptions.RequestException as e:
            print(f"[WARN] {now} Network error: {e}. Attempt {attempt}/{retries}...")
            if attempt < retries:
                time.sleep(backoff * attempt)
                continue
            raise

    raise RuntimeError(f"Failed to fetch {url} after {retries} attempts")


def _is_month_period(period: dict) -> bool:
    """True when period represents exactly one full calendar month."""
    start_s = period.get("startDate")
    end_s = period.get("endDate")
    if not start_s or not end_s:
        return False
    try:
        start = datetime.fromisoformat(start_s.replace("Z", "+00:00"))
        end = datetime.fromisoformat(end_s.replace("Z", "+00:00"))
    except ValueError:
        return False

    if start.day != 1:
        return False
    if start.year != end.year or start.month != end.month:
        return False

    if start.month == 12:
        next_month_start = datetime(start.year + 1, 1, 1, tzinfo=start.tzinfo)
    else:
        next_month_start = datetime(start.year, start.month + 1, 1, tzinfo=start.tzinfo)
    return end.day == (next_month_start - timedelta(days=1)).day


def discover_monthly_urls() -> dict[str, str]:
    """Build month->URL map from the live /periods endpoint."""
    raw = fetch_json(PERIODS_URL)
    periods = raw.get("data", {}).get("periods", [])
    monthly: dict[str, str] = {}
    for period in periods:
        if period.get("subdivision", {}).get("_id") != SUBDIVISION_ID:
            continue
        if not _is_month_period(period):
            continue
        period_id = period.get("_id")
        start_s = period.get("startDate")
        if not period_id or not start_s:
            continue
        start = datetime.fromisoformat(start_s.replace("Z", "+00:00")).astimezone(KYIV_TZ)
        month = start.strftime("%Y-%m")
        monthly[month] = f"{BASE_PUBLIC_URL}/statistics/{SUBDIVISION_ID}/{period_id}"
    return dict(sorted(monthly.items()))


# ─── Parse API response → internal dict ──────────────────────────────────────

def parse_api_response(raw: dict) -> dict:
    """
    Convert the sbs-group.army API response into the internal dict format.

    API shape:
      { "data": {
          "dataCollectedAt": "2025-10-26T00:19:00.008Z",
          "lastUpdated": "...",
          "personnel": { "killed": N, "wounded": N },
          "totalTargetsHit": N,
          "totalTargetsDestroyed": N,
          "totalPersonnelCasualties": N,
          "targetsByType": [
            { "targetClassId": N, "hit": N, "destroyed": N }, ...
          ]
      }}
    """
    data = raw.get("data", {})
    if not data:
        raise ValueError("API response missing 'data' field")

    personnel = data.get("personnel", {})
    flights = data.get("flights", {})
    targets = {
        t["targetClassId"]: {"hit": t.get("hit"), "destroyed": t.get("destroyed")}
        for t in data.get("targetsByType", [])
        if t.get("targetClassId") is not None
    }

    return {
        "data_collected_at": data.get("dataCollectedAt"),
        "last_updated": data.get("lastUpdated"),
        "personnel_killed": personnel.get("killed"),
        "personnel_wounded": personnel.get("wounded"),
        "total_targets_hit": data.get("totalTargetsHit"),
        "total_targets_destroyed": data.get("totalTargetsDestroyed"),
        "total_personnel_casualties": data.get("totalPersonnelCasualties"),
        "flights_strike": flights.get("strike"),
        "flights_recon": flights.get("recon"),
        "targets": targets,
    }


def to_kyiv_dt(iso_str: str) -> datetime:
    """Parse an ISO UTC timestamp and return it in Kyiv local time."""
    utc_dt = datetime.fromisoformat(iso_str.replace("Z", "+00:00"))
    return utc_dt.astimezone(KYIV_TZ)


# ─── Stat value helpers ───────────────────────────────────────────────────────

BASE_STAT_COLS = [
    "personnel_killed", "personnel_wounded",
    "total_targets_hit", "total_targets_destroyed",
    "total_personnel_casualties",
    "flights_strike", "flights_recon",
]


def _stat_values(data: dict, targets: dict[int, dict], target_ids: list[int]) -> tuple:
    """Extract a comparable tuple of stat values (excludes metadata like date/hour)."""
    return (
        data.get("personnel_killed"), data.get("personnel_wounded"),
        data.get("total_targets_hit"), data.get("total_targets_destroyed"),
        data.get("total_personnel_casualties"),
        *[targets[tid]["hit"] for tid in target_ids],
        *[targets[tid]["destroyed"] for tid in target_ids],
    )


def _get_latest_correction(conn: sqlite3.Connection, date: str) -> tuple | None:
    """Get the stat values from the latest correction row (hour >= 24) for a date."""
    row = conn.execute(
        "SELECT * FROM daily_stats WHERE date = ? AND hour >= 24 ORDER BY hour DESC LIMIT 1",
        (date,),
    ).fetchone()
    if row is None:
        return None
    # Return just the stat columns as a tuple for comparison
    keys = row.keys()
    stat_keys = BASE_STAT_COLS + [k for k in keys if k.startswith(("hit_", "destroyed_"))]
    return tuple(row[k] for k in stat_keys if k in keys)


def _stat_values_for_comparison(data: dict, targets: dict[int, dict], target_ids: list[int],
                                all_stat_keys: list[str]) -> tuple:
    """Build a tuple matching the column order used by _get_latest_correction."""
    base = [data.get(c) for c in BASE_STAT_COLS]
    target_vals = []
    for k in all_stat_keys:
        if k in BASE_STAT_COLS:
            continue
        if k.startswith("hit_"):
            tid = int(k.removeprefix("hit_"))
            target_vals.append(targets.get(tid, {}).get("hit"))
        elif k.startswith("destroyed_"):
            tid = int(k.removeprefix("destroyed_"))
            target_vals.append(targets.get(tid, {}).get("destroyed"))
    return tuple(base + target_vals)


# ─── Upsert helpers ───────────────────────────────────────────────────────────

def upsert_daily(conn: sqlite3.Connection, data: dict) -> None:
    now = datetime.now(timezone.utc).isoformat()
    targets: dict[int, dict] = data.pop("targets", {})
    target_ids = list(targets.keys())

    ensure_columns(conn, "daily_stats", target_ids)

    base_cols = [
        "date", "hour", "data_collected_at", "last_updated",
        "personnel_killed", "personnel_wounded",
        "total_targets_hit", "total_targets_destroyed",
        "total_personnel_casualties",
        "flights_strike", "flights_recon",
    ]
    target_cols = [f"hit_{tid}" for tid in target_ids] + [f"destroyed_{tid}" for tid in target_ids]
    all_cols = base_cols + target_cols

    values = (
        data["date"], data["hour"], data.get("data_collected_at"), now,
        data.get("personnel_killed"), data.get("personnel_wounded"),
        data.get("total_targets_hit"), data.get("total_targets_destroyed"),
        data.get("total_personnel_casualties"),
        data.get("flights_strike"), data.get("flights_recon"),
        *[targets[tid]["hit"] for tid in target_ids],
        *[targets[tid]["destroyed"] for tid in target_ids],
    )

    placeholders = ", ".join("?" * len(all_cols))
    updates = ", ".join(f"{c} = excluded.{c}" for c in all_cols if c not in ("date", "hour"))

    conn.execute(f"""
        INSERT INTO daily_stats ({", ".join(all_cols)})
        VALUES ({placeholders})
        ON CONFLICT(date, hour) DO UPDATE SET {updates}
    """, values)
    conn.commit()
    print(f"  [OK] daily_stats: {data['date']} hour {data['hour']} ({len(target_ids)} target types)")


def upsert_daily_correction(conn: sqlite3.Connection, data: dict) -> bool:
    """Insert a correction row for a previous day, only if values differ from the last correction.
    Returns True if a row was written, False if skipped."""
    targets: dict[int, dict] = data.pop("targets", {})
    target_ids = list(targets.keys())

    ensure_columns(conn, "daily_stats", target_ids)

    date = data["date"]

    # Get all stat column names from the table to ensure consistent comparison
    cur = conn.cursor()
    cur.execute("PRAGMA table_info(daily_stats)")
    all_db_cols = [row[1] for row in cur.fetchall()]
    all_stat_keys = BASE_STAT_COLS + [c for c in all_db_cols if c.startswith(("hit_", "destroyed_"))]

    # Compare with the latest existing correction
    existing = _get_latest_correction(conn, date)
    new_vals = _stat_values_for_comparison(data, targets, target_ids, all_stat_keys)

    if existing is not None and existing == new_vals:
        print(f"  [SKIP] daily_stats: {date} correction unchanged, skipping")
        return False

    # Use 24 + current Kyiv hour, so the value encodes when the correction was fetched.
    # E.g. fetched at Kyiv hour 19 → hour = 43. Same hour re-fetch upserts via ON CONFLICT.
    kyiv_hour = datetime.now(KYIV_TZ).hour
    data["hour"] = 24 + kyiv_hour
    data["targets"] = targets  # put it back for upsert_daily
    upsert_daily(conn, data)
    return True


def upsert_monthly(conn: sqlite3.Connection, data: dict) -> bool:
    """Insert a new monthly row only if stat values differ from the latest version.
    Returns True if a row was written, False if skipped."""
    now = datetime.now(timezone.utc).isoformat()
    targets: dict[int, dict] = data.pop("targets", {})
    target_ids = list(targets.keys())

    ensure_columns(conn, "monthly_stats", target_ids)

    date = data["date"]

    # Get all stat column names from the table for comparison
    cur = conn.cursor()
    cur.execute("PRAGMA table_info(monthly_stats)")
    all_db_cols = [row[1] for row in cur.fetchall()]
    all_stat_keys = BASE_STAT_COLS + [c for c in all_db_cols if c.startswith(("hit_", "destroyed_"))]

    # Compare with the latest existing row for this month
    existing_row = conn.execute(
        "SELECT * FROM monthly_stats WHERE date = ? ORDER BY data_collected_at DESC LIMIT 1",
        (date,),
    ).fetchone()
    if existing_row is not None:
        existing_vals = tuple(existing_row[k] for k in all_stat_keys if k in existing_row.keys())
        new_vals = _stat_values_for_comparison(data, targets, target_ids, all_stat_keys)
        if existing_vals == new_vals:
            print(f"  [SKIP] monthly_stats: {date} unchanged, skipping")
            return False

    # Insert new version
    base_cols = [
        "date", "data_collected_at", "last_updated",
        "personnel_killed", "personnel_wounded",
        "total_targets_hit", "total_targets_destroyed",
        "total_personnel_casualties",
        "flights_strike", "flights_recon",
    ]
    target_cols = [f"hit_{tid}" for tid in target_ids] + [f"destroyed_{tid}" for tid in target_ids]
    all_cols = base_cols + target_cols

    values = (
        data["date"], data.get("data_collected_at"), now,
        data.get("personnel_killed"), data.get("personnel_wounded"),
        data.get("total_targets_hit"), data.get("total_targets_destroyed"),
        data.get("total_personnel_casualties"),
        data.get("flights_strike"), data.get("flights_recon"),
        *[targets[tid]["hit"] for tid in target_ids],
        *[targets[tid]["destroyed"] for tid in target_ids],
    )

    placeholders = ", ".join("?" * len(all_cols))
    conn.execute(f"""
        INSERT INTO monthly_stats ({", ".join(all_cols)})
        VALUES ({placeholders})
    """, values)
    conn.commit()
    print(f"  [OK] monthly_stats: {date} new version ({len(target_ids)} target types)")
    return True


# ─── Main ─────────────────────────────────────────────────────────────────────

SUMMARY_PATH = os.environ.get("SUMMARY_PATH", "")


def main() -> None:
    parser = argparse.ArgumentParser(description="Fetch and update SBS stats DB")
    parser.add_argument("--all-months", action="store_true",
                        help="Fetch all months, ignoring the 10-day and 6-hour thresholds")
    args = parser.parse_args()

    db_dir = os.path.dirname(DB_PATH)
    if db_dir:
        os.makedirs(db_dir, exist_ok=True)

    print(f"Connecting to {DB_PATH}")
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    ensure_schema(conn)

    updated: list[str] = []

    # ── Daily (today) ─────────────────────────────────────────────────────────
    print("Fetching daily data (today)...")
    parsed = parse_api_response(fetch_json(DAILY_URL))
    kyiv_dt = to_kyiv_dt(parsed["data_collected_at"])
    parsed["date"] = kyiv_dt.strftime("%Y-%m-%d")
    parsed["hour"] = kyiv_dt.hour
    upsert_daily(conn, parsed)
    updated.append(f"daily {parsed['date']} h{parsed['hour']}")

    # ── Daily (previous day correction) ───────────────────────────────────────
    print("Fetching daily data (previous day)...")
    try:
        parsed_prev = parse_api_response(fetch_json(PREVIOUS_DAY_URL))
        kyiv_now = datetime.now(KYIV_TZ)
        yesterday = (kyiv_now - timedelta(days=1)).strftime("%Y-%m-%d")
        parsed_prev["date"] = yesterday
        if upsert_daily_correction(conn, parsed_prev):
            updated.append(f"prev-day {yesterday}")
    except Exception as e:
        print(f"  [WARN] Skipping previous day: {e}")

    # ── Monthly ───────────────────────────────────────────────────────────────
    kyiv_now = datetime.now(KYIV_TZ)
    kyiv_today = kyiv_now.date()
    try:
        monthly_urls = discover_monthly_urls()
        if monthly_urls:
            print(f"Discovered {len(monthly_urls)} monthly periods from /periods")
        else:
            print("  [WARN] No monthly periods discovered; falling back to static map")
            monthly_urls = FALLBACK_MONTHLY_URLS
    except Exception as e:
        print(f"  [WARN] Could not discover monthly periods: {e}")
        print("  [WARN] Falling back to static monthly URL map")
        monthly_urls = FALLBACK_MONTHLY_URLS

    for month, url in monthly_urls.items():
        if not args.all_months:
            y, m = map(int, month.split("-"))
            if m == 12:
                month_end = datetime(y + 1, 1, 1).date()
            else:
                month_end = datetime(y, m + 1, 1).date()
            if (kyiv_today - month_end).days > 10:
                continue

            # Skip if last update was less than 6 hours ago
            row = conn.execute(
                "SELECT data_collected_at FROM monthly_stats WHERE date = ? ORDER BY data_collected_at DESC LIMIT 1",
                (f"{month}-01",),
            ).fetchone()
            if row and row["data_collected_at"]:
                last_collected = datetime.fromisoformat(
                    row["data_collected_at"].replace("Z", "+00:00")
                )
                hours_since = (kyiv_now - last_collected.astimezone(KYIV_TZ)).total_seconds() / 3600
                if hours_since < 6:
                    print(f"  [SKIP] monthly_stats: {month} updated {hours_since:.1f}h ago, skipping")
                    continue

        print(f"Fetching monthly data for {month}...")
        try:
            parsed_m = parse_api_response(fetch_json(url))
            parsed_m["date"] = f"{month}-01"
            if upsert_monthly(conn, parsed_m):
                updated.append(f"monthly {month}")
        except Exception as e:
            print(f"  [WARN] Skipping {month}: {e}")

    conn.close()

    summary = ", ".join(updated) if updated else "no changes"
    print(f"Done. Updated: {summary}")
    if SUMMARY_PATH:
        with open(SUMMARY_PATH, "w") as f:
            f.write(summary)


if __name__ == "__main__":
    main()
