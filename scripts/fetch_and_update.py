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

# `scripts/` is this file's own directory, so it is already sys.path[0] — no
# shim needed here, unlike the ingests that live a level down.
from ingest_log import ann, get_logger

log = get_logger("sbs")

DB_PATH = os.environ.get("DB_PATH", "data/sbs.db")
KYIV_TZ = zoneinfo.ZoneInfo("Europe/Kyiv")
SUBDIVISION_ID = "68b0c85589944c4bfb2a5edc"

# ─── API endpoints ────────────────────────────────────────────────────────────

BASE_PUBLIC_URL = "https://sbs-group.army/api/public"
DAILY_URL = f"{BASE_PUBLIC_URL}/statistics/{SUBDIVISION_ID}/68fa98652f31834f2e051459"
PREVIOUS_DAY_URL = f"{BASE_PUBLIC_URL}/statistics/{SUBDIVISION_ID}/68b4852e792cdf918400daf1"
# `/periods` paginates and defaults to 50 of ~245 entries — it serves every
# subdivision's periods, not just ours, so the 17 we care about only fit on
# page 1 by luck of ordering. Ask for the lot; `discover_monthly_urls` checks
# the pagination block and warns rather than silently working from a truncated
# list, which would look exactly like "that month doesn't exist yet".
PERIODS_URL = f"{BASE_PUBLIC_URL}/periods?limit=500"

# There is deliberately no hardcoded month -> URL fallback map here any more.
# The one that used to live at this spot went stale in the worst possible way:
# the API reuses a fixed set of twelve `monthly_N` period slots and re-points
# them every year, so the id the map had filed under "2025-06" now serves
# **June 2026**. A fallback that returns confidently wrong data is worse than
# no fallback — a failed `/periods` call just means this run skips the monthly
# section and the next hourly run picks it up.

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
    """Dynamically add hit_X / destroyed_X columns if they don't exist yet.

    An ALTER here means the source published a targetClassId we've never
    stored — either brand new (surface it so we know to label it in
    src/types/index.ts) or previously-unseen ordering. The warning banner
    makes the "new source category" case impossible to miss on the CI log
    or in a local run.
    """
    cur = conn.cursor()
    cur.execute(f"PRAGMA table_info({table})")
    existing = {row[1] for row in cur.fetchall()}
    # "New" only means anything against a table that already has target
    # columns. On a freshly created one every id is new, and warning about all
    # 43 of them says nothing except "this table is empty" — noise that would
    # fire on every backfill into a clean DB and train people to skip the
    # panel.
    established = any(c.startswith("hit_") for c in existing)
    added: list[int] = []
    for tid in target_ids:
        tid_added = False
        for prefix in ("hit", "destroyed"):
            col = f"{prefix}_{tid}"
            if col not in existing:
                print(f"  Adding column {table}.{col}")
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} INTEGER")
                tid_added = True
        if tid_added:
            added.append(tid)
    conn.commit()
    if added and established:
        log.warning(
            f"NEW targetClassId(s) in {table}: {sorted(set(added))}. "
            "Add label(s) to TARGET_LABELS in src/types/index.ts or the "
            "frontend will silently ignore this data.",
            extra=ann(title="sbs: new targetClassId"),
        )


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


def _period_month(start_s: str) -> str:
    """The "YYYY-MM" a period's startDate belongs to, in Kyiv terms.

    The single place this conversion happens, so that the month a URL is filed
    under and the month its payload is later checked against can never drift
    apart.
    """
    return datetime.fromisoformat(
        start_s.replace("Z", "+00:00")
    ).astimezone(KYIV_TZ).strftime("%Y-%m")


def discover_monthly_urls() -> dict[str, str]:
    """Build month->URL map from the live /periods endpoint."""
    raw = fetch_json(PERIODS_URL)
    data = raw.get("data", {})
    periods = data.get("periods", [])

    # A truncated page is indistinguishable downstream from "the API has fewer
    # months than it used to" — both just yield a shorter map — so say so here.
    pagination = data.get("pagination") or {}
    pages = pagination.get("pages")
    if isinstance(pages, int) and pages > 1:
        log.warning(
            f"/periods returned page {pagination.get('current')} of {pages} "
            f"({len(periods)} of {pagination.get('total')} periods). The limit is "
            "no longer enough to hold every subdivision's periods — raise it or "
            "paginate, or months will go missing without an error.",
            extra=ann(title="sbs: /periods truncated"),
        )

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
        monthly[_period_month(start_s)] = (
            f"{BASE_PUBLIC_URL}/statistics/{SUBDIVISION_ID}/{period_id}"
        )
    return dict(sorted(monthly.items()))


# ─── Payload validation ───────────────────────────────────────────────────────
# Two ways this API hands back data that looks fine and isn't:
#
#   1. `status: "not_collected"` — returned with HTTP 200 and every counter
#      zeroed. It is what an unrecognised (subdivision, period) pair yields,
#      and zero is NOT a sentinel here: real units do report months of zero, so
#      only `status` separates the two.
#   2. The twelve `monthly_N` period slots are reused and re-pointed each year,
#      so a period id captured in one year serves a different year later. The
#      payload always states its own `startDate`; trust that over the id we
#      asked with.
#
# Both are silent corruption if unchecked — the row is written, it just holds
# the wrong numbers — so both are warnings that skip the write.

def _payload_is_usable(data: dict, what: str) -> bool:
    """False (having warned) when the payload must not be written."""
    status = data.get("status")
    if status != "completed":
        log.warning(
            f"{what}: status={status!r}, not 'completed' — skipping. Zeroed "
            "payloads come back with HTTP 200, so writing this would store "
            "zeros as if they were reported.",
            extra=ann(title="sbs: payload not collected"),
        )
        return False
    return True


def _payload_period_start(data: dict, what: str) -> str | None:
    """The Kyiv calendar day the payload says it covers ("YYYY-MM-DD").

    Goes through the same UTC->Kyiv conversion as `_period_month` so a date and
    a month derived from one payload can never disagree with each other.
    """
    start_s = data.get("startDate")
    if not isinstance(start_s, str) or len(start_s) < 10:
        log.warning(
            f"{what}: payload has no usable startDate ({start_s!r}) — cannot "
            "verify which period it actually covers.",
            extra=ann(title="sbs: payload missing startDate"),
        )
        return None
    try:
        return datetime.fromisoformat(
            start_s.replace("Z", "+00:00")
        ).astimezone(KYIV_TZ).strftime("%Y-%m-%d")
    except ValueError:
        log.warning(
            f"{what}: unparseable startDate ({start_s!r}).",
            extra=ann(title="sbs: payload missing startDate"),
        )
        return None


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
    raw_daily = fetch_json(DAILY_URL)
    data_daily = raw_daily.get("data", {})
    if _payload_is_usable(data_daily, "daily (today)"):
        parsed = parse_api_response(raw_daily)
        kyiv_dt = to_kyiv_dt(parsed["data_collected_at"])
        parsed["date"] = kyiv_dt.strftime("%Y-%m-%d")
        parsed["hour"] = kyiv_dt.hour
        # `hour` has to come from dataCollectedAt — it is the intraday bucket,
        # and the end-of-day projection reads the curve it forms. `date` could
        # come from the period's own startDate instead, and around Kyiv
        # midnight the two can disagree: the collection stamp rolls over before
        # the API swaps to the new day. Warn rather than switch, because moving
        # `date` back a day while `hour` stays 0 would file the reading as an
        # early-morning point on the *previous* day's curve and skew the
        # projection. If this ever fires, that trade-off is worth revisiting
        # with evidence in hand.
        stated = _payload_period_start(data_daily, "daily (today)")
        if stated and stated != parsed["date"]:
            log.warning(
                f"daily (today): period covers {stated} but dataCollectedAt is "
                f"{parsed['date']} h{parsed['hour']} — storing under "
                f"{parsed['date']}. Expected only around Kyiv midnight.",
                extra=ann(level="notice", title="sbs: daily date disagreement"),
            )
        upsert_daily(conn, parsed)
        updated.append(f"daily {parsed['date']} h{parsed['hour']}")

    # ── Daily (previous day correction) ───────────────────────────────────────
    print("Fetching daily data (previous day)...")
    try:
        raw_prev = fetch_json(PREVIOUS_DAY_URL)
        data_prev = raw_prev.get("data", {})
        # Usability first: a not_collected payload carries no startDate either,
        # and one finding per problem reads better than two.
        if _payload_is_usable(data_prev, "daily (previous day)"):
            kyiv_now = datetime.now(KYIV_TZ)
            yesterday = (kyiv_now - timedelta(days=1)).strftime("%Y-%m-%d")
            # The day this correction belongs to used to be pure wall-clock
            # arithmetic — "yesterday, in Kyiv" — with nothing checking that
            # the endpoint agreed. It states its own day, so use that: a
            # lagging endpoint would otherwise file the day-before-yesterday's
            # numbers as a correction to yesterday, overwriting a good row
            # with a wrong one.
            stated_prev = _payload_period_start(data_prev, "daily (previous day)")
            if stated_prev and stated_prev != yesterday:
                log.warning(
                    f"daily (previous day): endpoint covers {stated_prev}, not "
                    f"{yesterday} — filing the correction under {stated_prev}.",
                    extra=ann(title="sbs: prev-day date disagreement"),
                )
            target_day = stated_prev or yesterday
            parsed_prev = parse_api_response(raw_prev)
            parsed_prev["date"] = target_day
            if upsert_daily_correction(conn, parsed_prev):
                updated.append(f"prev-day {target_day}")
    except Exception as e:
        print(f"  [WARN] Skipping previous day: {e}")

    # ── Monthly ───────────────────────────────────────────────────────────────
    kyiv_now = datetime.now(KYIV_TZ)
    kyiv_today = kyiv_now.date()
    # No fallback map: see the note at PERIODS_URL. A run that can't reach
    # /periods skips the monthly section entirely and the next run picks it up.
    try:
        monthly_urls = discover_monthly_urls()
    except Exception as e:
        log.warning(
            f"could not discover monthly periods ({e}) — skipping the monthly "
            "section this run.",
            extra=ann(title="sbs: /periods unreachable"),
        )
        monthly_urls = {}
    if monthly_urls:
        print(f"Discovered {len(monthly_urls)} monthly periods from /periods")
    else:
        log.warning(
            "no monthly periods discovered for the USF subdivision — no "
            "monthly rows will be written this run.",
            extra=ann(title="sbs: no monthly periods"),
        )

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
            raw_m = fetch_json(url)
            data_m = raw_m.get("data", {})
            if not _payload_is_usable(data_m, f"monthly {month}"):
                continue
            # The period-slot reuse guard. `url` came from this same run's
            # /periods call so it should always agree, but the twelve slots are
            # re-pointed every year and a mismatch writes one year's totals
            # under another year's date — the exact failure the deleted
            # fallback map had already walked into.
            stated_m = _payload_period_start(data_m, f"monthly {month}")
            if stated_m and stated_m[:7] != month:
                log.warning(
                    f"monthly {month}: period {url.rsplit('/', 1)[-1]} returned "
                    f"data for {stated_m[:7]} — skipping rather than filing it "
                    f"under {month}.",
                    extra=ann(title="sbs: monthly period mismatch"),
                )
                continue
            parsed_m = parse_api_response(raw_m)
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
