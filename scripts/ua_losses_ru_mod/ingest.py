#!/usr/bin/env python3
"""
ingest.py — build ua-losses-ru-mod-john-felix.db from John Felix's sheet.

Source: John Felix's (@NedSnow2019) hand-compiled Google Sheet of the Ukrainian
losses the Russian MoD claims, first tab, read through the public CSV export:
https://docs.google.com/spreadsheets/d/1U1kZiRglakIO_rfyYaR2cNaD2DUNCGKWv60iDPspgFs

There is no licence on it, so this DB is LOCAL ONLY for now — no CI workflow,
no R2 upload, and the site is only listed in dev (see README.md).

THE SHEET'S SHAPE. One row per MoD report day, ~290 columns. Header text, not
position, identifies a column: Felix inserts a model column wherever it belongs
as new kit turns up. Columns fall into blocks, each opened by an anchor header:

  - the eight categories of the MoD's own "since the start" tally (tanks and
    other armoured vehicles, artillery, MLRS, air defence, aircraft,
    helicopters, UAVs, special motor vehicles). The anchor column is the MoD's
    RUNNING TOTAL; the "(Daily)" column beside it is only the sheet's own diff
    and is not stored. The columns after it are Felix's itemisation of the
    report text by model ("Leopard", "M777", …) — daily counts that do NOT
    reliably sum to the MoD's figure (the itemisation of 2022–24 is
    incomplete, and on some days overshoots), which is why the total is
    stored as the MoD's and the items as a breakdown of it.
  - personnel (killed + wounded, daily) and captured (daily).
  - blocks the MoD never totals: intercepted munitions, radars, EW stations.

Weekly columns are the sums of the daily ones and are not stored; nor are the
day index, the ISO-date helper column, or columns without a header.

STORAGE. Long format, `claims(report_date, item_id, snapshot, value)`: one row
per non-blank cell, append-on-change per cell — a corrected cell gets a new row
under a newer snapshot (`snapshots.scraped_at`), a cleared one a NULL, and
nothing is ever updated or deleted. `items` names each (section, item) and records its role
(`total` | `daily` | `item` | `sub`) and, for the armour block, its subgroup
(tanks / ifv / apc / acv / other). The `daily` view turns it into one row per
day — the running totals diffed, the armour items summed per subgroup, and
the radar and EW-station items summed (the MoD keeps no total for either).

DATES. `report_date` is the date the sheet gives the row: the day the MoD
published the claims, which cover the 24 hours to that morning. The `daily`
view is keyed by `loss_date`, the day before — the GSUA series' dating, so the
two line up (evidence and the war's-first-day exception at WAR_START).
"""

from __future__ import annotations

import argparse
import csv
import io
import os
import re
import sqlite3
import sys
import urllib.request
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from ingest_log import ann, excerpt, get_logger  # noqa: E402

log = get_logger("ua-losses-ru-mod")

SHEET_ID = "1U1kZiRglakIO_rfyYaR2cNaD2DUNCGKWv60iDPspgFs"
CSV_URL = f"https://docs.google.com/spreadsheets/d/{SHEET_ID}/export?format=csv&gid=0"

SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_DB_NAME = "ua-losses-ru-mod-john-felix.db"

# The war started 2022-02-24, so a sane fetch carries well over a year of days.
MIN_ROWS_FLOOR = 365


def norm(header: str) -> str:
    return re.sub(r"\s+", " ", header).strip().lower()


def slug(header: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", header.lower()).strip("_")


# Anchor header → (section, role of the anchor column itself). Every column up
# to the next anchor belongs to the anchor's section. All must be present: a
# missing one means the sheet was restructured, and guessing would file whole
# blocks under the wrong category.
ANCHORS: dict[str, tuple[str, str]] = {
    "tanks and other armoured vehicles": ("armour", "total"),
    "artillery": ("artillery", "total"),
    "mrls": ("mlrs", "total"),
    "aa missile systems": ("air_defense", "total"),
    "aircraft": ("aircraft", "total"),
    "helicopters": ("helicopters", "total"),
    "uavs": ("uav", "total"),
    "special motor vehicles": ("vehicles", "total"),
    "servicemen (daily) killed and wounder": ("personnel", "daily"),
    "servicemen captured": ("captured", "daily"),
    "unknown rocket (probably grad)": ("munitions", "item"),
    "unknown radar": ("radars", "item"),
    "rers": ("ew", "item"),
    # The trailing block: an old mortar breakdown, then the weekly columns.
    "mortars (82mm/120mm)": ("_tail", "skip"),
}

# The report of day D covers the 24 hours to the morning of D: the sheet's
# long-range UAV figure equals the MoD's own daytime claim of D-1 plus its
# overnight claim into D on 227 of 1,003 days in 2024-26 (the same day's
# windows: 23 and 46). So D's losses are dated D-1, like the GSUA series —
# except the war's first reports, briefed through 24/02 about 24/02 itself.
WAR_START = "2022-02-24"
FIRST_REPORTS_THROUGH = "2022-02-25"

# Sections whose anchor is the MoD's running total — the `daily` view diffs them.
TOTAL_SECTIONS = [s for s, role in ANCHORS.values() if role == "total"]

# Armour items group by the "Unknown …" column that opens each run of models.
ARMOUR_SUBGROUPS = {
    "unknown tanks": "tanks",
    "unknown ifvs": "ifv",
    "unknown apcs": "apc",
    "unknown acvs": "acv",
    "engineering vehicles": "other",
}

# Munitions the MoD claims its air defence shot down, by kind. Grouped because
# the MoD's naming drifts — it stopped naming JDAM / Hammer around 06/2025 and
# says "guided aerial bomb" since — so a model's series starts and stops where
# the group's carries on. `None`: stored, in no group (S-200 fired at ground
# targets is neither cruise nor ballistic; "Patriot" is likely interceptors;
# jet drones are drones). A munitions column missing here is flagged.
MUNITION_GROUPS: dict[str, str | None] = {
    "storm shadow": "cruise",
    "scalp-eg": "cruise",
    "neptune anti-ship missile": "cruise",
    "neptune-md (long-range?)": "cruise",
    "flamingo (fp-5)": "cruise",
    "unspecified cruise missiles": "cruise",
    "long-range cruise missile": "cruise",
    "atacms": "ballistic",
    "tochka-u": "ballistic",
    "hrim-2 grom-2": "ballistic",
    "long-range operational-tactical missile": "ballistic",
    "unknown rocket (probably grad)": "mlrs_rockets",
    "grad": "mlrs_rockets",
    "vampire": "mlrs_rockets",
    "uragan": "mlrs_rockets",
    "smerch": "mlrs_rockets",
    "olkha": "mlrs_rockets",
    "himars": "mlrs_rockets",
    "unsp. mlrs": "mlrs_rockets",
    "guided aerial bomb": "guided_bombs",
    "jdam": "guided_bombs",
    "gbu-39 sdb": "guided_bombs",
    "aasm hammer": "guided_bombs",
    "glsdb": "guided_bombs",
    "harm": "air_launched",
    "unknown agm": "air_launched",
    "mald": "air_launched",
    "s-200": None,
    "patriot": None,
    "jet lr uavs": None,
}

# (section, header) → (section, role, item key), for the columns position alone
# files wrongly. `role` "skip" drops the column.
OVERRIDES: dict[tuple[str, str], tuple[str, str, str]] = {
    # Sits just before the artillery anchor, but is the artillery the report
    # gives no model for (mortars, and on Fridays the week's unspecified guns).
    ("armour", "mortars (and friday's unspecified artillery)"):
        ("artillery", "item", "mortars_and_unspecified"),
    # 2025's weekly NATO/Soviet split of the guns — weekly, and computable.
    ("artillery", "nato"): ("artillery", "skip", ""),
    ("artillery", "soviet"): ("artillery", "skip", ""),
    # A subset of the long-range one-way-attack drones within the MoD's UAV
    # figure. Stored, never summed with it.
    ("uav", "lr owa uavs (dailly)"): ("uav", "sub", "lr_owa"),
    ("uav", "lr owa uavs (daily)"): ("uav", "sub", "lr_owa"),
    # A launcher, in among the munitions it fires.
    ("munitions", "tochka-u launcher"): ("other", "item", "tochka_u_launcher"),
    # 2022–24's 82/120 mm breakdown of the mortars column above — a subset.
    ("_tail", "mortars (82mm/120mm)"): ("artillery", "sub", "mortars_82_120mm"),
}


@dataclass(frozen=True)
class Column:
    index: int
    label: str
    section: str
    item: str
    role: str  # total | daily | item | sub | note
    subgroup: str | None


def _is_skipped(header: str) -> bool:
    h = norm(header)
    return not h or "weekly" in h or h.endswith("(daily)") or h.endswith("(dailly)")


def map_columns(header: list[str]) -> list[Column]:
    """Resolve the header row into the columns we store.

    Raises when an anchor is missing. Warns (as a notice) for nothing: a new
    model column inside a known block is the normal way the sheet grows, and
    the run summary lists every stored column per section anyway.
    """
    found = {norm(h) for h in header}
    missing = [a for a in ANCHORS if a not in found]
    if missing:
        raise RuntimeError(
            f"sheet header lacks anchor column(s) {missing} — restructured? "
            f"Refusing to guess which block each column belongs to."
        )

    columns: list[Column] = []
    section, subgroup = None, None
    seen: set[tuple[str, str]] = set()
    for i, raw in enumerate(header):
        h = norm(raw)
        if h.startswith("comments"):
            columns.append(Column(i, raw.strip(), "_notes", "comment", "note", None))
            continue
        if h in ANCHORS:
            section, role = ANCHORS[h]
            subgroup = None
            if role != "skip":
                columns.append(Column(i, raw.strip(), section, "_total" if role in ("total", "daily") else slug(raw), role, None))
                seen.add((section, columns[-1].item))
                continue
        if section is None:
            continue
        if section == "armour" and h in ARMOUR_SUBGROUPS:
            subgroup = ARMOUR_SUBGROUPS[h]
        override = OVERRIDES.get((section, h))
        if override:
            sec, role, item = override
            if role == "skip":
                continue
            col = Column(i, raw.strip(), sec, item, role, None)
        elif _is_skipped(raw) or section == "_tail":
            continue
        else:
            col = Column(i, raw.strip(), section, slug(raw), "item", subgroup if section == "armour" else None)
        if (col.section, col.item) in seen:
            n = 2
            while (col.section, f"{col.item}_{n}") in seen:
                n += 1
            log.warning(
                f"header {raw.strip()!r} repeats within {col.section}; storing it as {col.item}_{n}",
                extra=ann(title="ua-losses-ru-mod: duplicate header"),
            )
            col = Column(col.index, col.label, col.section, f"{col.item}_{n}", col.role, col.subgroup)
        seen.add((col.section, col.item))
        columns.append(col)
    return [_munition_group(c) for c in columns]


def _munition_group(c: Column) -> Column:
    if c.section != "munitions":
        return c
    h = norm(c.label)
    if h not in MUNITION_GROUPS:
        log.warning(
            f"munitions column {c.label!r} has no group — stored, but in no chart until "
            f"it's added to MUNITION_GROUPS",
            extra=ann(title="ua-losses-ru-mod: unclassified munition", level="notice"),
        )
    return replace(c, subgroup=MUNITION_GROUPS.get(h))


DATE_RE = re.compile(r"^(\d{2})/(\d{2})/(\d{4})$")


def _value(cell: str, where: str) -> int | None:
    s = cell.strip().replace(",", "")
    if not s:
        return None
    try:
        return int(float(s))
    except ValueError:
        log.warning(
            f"non-numeric cell at {where}: {excerpt(cell)}",
            extra=ann(title="ua-losses-ru-mod: non-numeric cell", level="notice"),
        )
        return None


def parse(text: str) -> tuple[list[Column], dict[str, dict[tuple[str, str], int]], dict[str, str]]:
    """Parse the CSV into (columns, {report_date: {(section, item): value}}, notes).

    A row counts only once the MoD's armour total is filled in: the sheet keeps
    a couple of weeks of empty rows ready below today, whose formula columns
    already read as huge negative "daily" losses.
    """
    rows = list(csv.reader(io.StringIO(text)))
    header_idx = next(
        (i for i, r in enumerate(rows) if any(norm(c) == "tanks and other armoured vehicles" for c in r)),
        None,
    )
    if header_idx is None:
        raise RuntimeError("no header row (no 'Tanks and other Armoured Vehicles' column) — wrong tab?")
    columns = map_columns(rows[header_idx])
    armour_total = next(c.index for c in columns if c.section == "armour" and c.role == "total")

    data: dict[str, dict[tuple[str, str], int]] = {}
    notes: dict[str, str] = {}
    for r in rows[header_idx + 1:]:
        m = DATE_RE.match(r[0].strip()) if r else None
        if not m or armour_total >= len(r) or not r[armour_total].strip():
            continue
        d = f"{m.group(3)}-{m.group(2)}-{m.group(1)}"
        values: dict[tuple[str, str], int] = {}
        for c in columns:
            if c.index >= len(r):
                continue
            if c.role == "note":
                if r[c.index].strip():
                    notes[d] = r[c.index].strip()
                continue
            v = _value(r[c.index], f"{d} / {c.label}")
            if v is not None:
                values[(c.section, c.item)] = v
        data[d] = values
    return columns, data, notes


SCHEMA = """
CREATE TABLE IF NOT EXISTS items (
  id         INTEGER PRIMARY KEY,
  section    TEXT NOT NULL,
  item       TEXT NOT NULL,      -- '_total' for a section's MoD figure
  label      TEXT NOT NULL,      -- the sheet's header text
  role       TEXT NOT NULL,      -- total (MoD running total) | daily | item | sub (subset of another column)
  subgroup   TEXT,               -- armour: tanks | ifv | apc | acv | other; munitions: cruise | ballistic | mlrs_rockets | guided_bombs | air_launched
  first_seen TEXT NOT NULL,
  UNIQUE (section, item)
);
CREATE TABLE IF NOT EXISTS snapshots (
  id         INTEGER PRIMARY KEY,
  scraped_at TEXT NOT NULL UNIQUE
);
-- One row per non-blank cell version. Integer keys rather than text: the
-- table is ~35k rows and the browser downloads the whole file.
CREATE TABLE IF NOT EXISTS claims (
  report_date TEXT NOT NULL,     -- the day the MoD published the claim, as the sheet dates it
  item_id     INTEGER NOT NULL REFERENCES items (id),
  snapshot    INTEGER NOT NULL REFERENCES snapshots (id),
  value       INTEGER,           -- NULL: the cell was cleared in a later version
  PRIMARY KEY (report_date, item_id, snapshot)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS notes (
  report_date TEXT NOT NULL,     -- Felix's summary of the day's report
  snapshot    INTEGER NOT NULL REFERENCES snapshots (id),
  text        TEXT,
  PRIMARY KEY (report_date, snapshot)
) WITHOUT ROWID;
DROP VIEW IF EXISTS latest_claims;
CREATE VIEW latest_claims AS
SELECT c.report_date, i.section, i.item, i.role, i.subgroup, c.value
FROM claims c
JOIN (SELECT report_date, item_id, MAX(snapshot) AS ms
      FROM claims GROUP BY report_date, item_id) l
  ON c.report_date = l.report_date AND c.item_id = l.item_id AND c.snapshot = l.ms
JOIN items i ON i.id = c.item_id
WHERE c.value IS NOT NULL;
"""


def _daily_view_sql() -> str:
    # The running totals are diffed in long format, so a day missing one
    # section's total is simply absent from that section's LAG rather than
    # turning the next day's diff into the whole war-to-date figure.
    totals = ", ".join(f"'{s}'" for s in TOTAL_SECTIONS)
    pivot = ",\n  ".join(
        f"SUM(CASE WHEN section = '{s}' THEN v END) AS {s}" for s in TOTAL_SECTIONS
    )
    subgroups = ",\n  ".join(
        f"SUM(CASE WHEN section = 'armour_{g}' THEN v END) AS armour_{g}"
        for g in dict.fromkeys(ARMOUR_SUBGROUPS.values())
    )
    munitions = ",\n  ".join(
        f"COALESCE(SUM(CASE WHEN section = 'munitions_{g}' THEN v END), 0) AS intercepted_{g}"
        for g in dict.fromkeys(g for g in MUNITION_GROUPS.values() if g)
    )
    return f"""
DROP VIEW IF EXISTS daily;
CREATE VIEW daily AS
WITH inc AS (
  SELECT report_date, section,
         value - COALESCE(LAG(value) OVER (PARTITION BY section ORDER BY report_date), 0) AS v
  FROM latest_claims
  WHERE item = '_total' AND section IN ({totals})
),
direct AS (
  SELECT report_date, section, value AS v
  FROM latest_claims
  WHERE item = '_total' AND section IN ('personnel', 'captured')
),
armour AS (
  SELECT report_date, 'armour_' || subgroup AS section, SUM(value) AS v
  FROM latest_claims
  WHERE section = 'armour' AND role = 'item'
  GROUP BY report_date, subgroup
),
lr_owa AS (
  SELECT report_date, 'uav_lr_owa' AS section, value AS v
  FROM latest_claims WHERE section = 'uav' AND item = 'lr_owa'
),
-- Radars, EW stations and intercepted munitions have no MoD total: the
-- itemisation is all there is, so a day without one is 0 claimed, not unknown.
untotalled AS (
  SELECT report_date, section, SUM(value) AS v
  FROM latest_claims
  WHERE section IN ('radars', 'ew') AND role = 'item'
  GROUP BY report_date, section
  UNION ALL
  SELECT report_date, 'munitions_' || subgroup, SUM(value)
  FROM latest_claims
  WHERE section = 'munitions' AND role = 'item' AND subgroup IS NOT NULL
  GROUP BY report_date, subgroup
),
days AS (SELECT DISTINCT report_date FROM latest_claims WHERE section = 'armour' AND item = '_total'),
long AS (SELECT * FROM inc UNION ALL SELECT * FROM direct UNION ALL SELECT * FROM armour
             UNION ALL SELECT * FROM lr_owa UNION ALL SELECT * FROM untotalled)
SELECT
  -- One row per loss day: the report of day D covers the 24 hours to the
  -- morning of D, so its losses are D-1's. The war's first two reports both
  -- land on 24/02 — the MoD briefed through the 24th about the 24th itself.
  CASE WHEN d.report_date <= '{FIRST_REPORTS_THROUGH}' THEN '{WAR_START}'
       ELSE date(d.report_date, '-1 day') END AS loss_date,
  MAX(d.report_date) AS report_date,
  {pivot},
  SUM(CASE WHEN section = 'personnel' THEN v END) AS personnel,
  SUM(CASE WHEN section = 'captured' THEN v END) AS captured,
  {subgroups},
  SUM(CASE WHEN section = 'uav_lr_owa' THEN v END) AS uav_lr_owa,
  COALESCE(SUM(CASE WHEN section = 'radars' THEN v END), 0) AS radars,
  COALESCE(SUM(CASE WHEN section = 'ew' THEN v END), 0) AS ew,
  {munitions}
FROM days d
LEFT JOIN long l ON l.report_date = d.report_date
GROUP BY 1;
"""


def connect(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.executescript(SCHEMA)
    conn.executescript(_daily_view_sql())
    return conn


def store(conn: sqlite3.Connection, columns: list[Column],
          data: dict[str, dict[tuple[str, str], int]], notes: dict[str, str],
          scraped_at: str | None = None) -> dict[str, int]:
    """Append every cell that differs from its latest stored version.

    A cell stored before and blank now gets a NULL row, on dates the fetch
    still has. A date the fetch lacks altogether is left alone — that is the
    shrinking-sheet guard's business, not a correction.
    """
    if len(data) < MIN_ROWS_FLOOR:
        raise RuntimeError(f"parsed only {len(data)} days (< floor {MIN_ROWS_FLOOR}) — refusing to write")
    stored_dates = conn.execute("SELECT COUNT(DISTINCT report_date) FROM latest_claims").fetchone()[0]
    if len(data) < stored_dates:
        raise RuntimeError(f"parsed {len(data)} days but the DB already has {stored_dates} — refusing a shrinking sheet")

    scraped_at = scraped_at or datetime.now(timezone.utc).isoformat(timespec="seconds")
    for c in columns:
        if c.role == "note":
            continue
        conn.execute(
            "INSERT OR IGNORE INTO items (section, item, label, role, subgroup, first_seen) VALUES (?, ?, ?, ?, ?, ?)",
            (c.section, c.item, c.label, c.role, c.subgroup, scraped_at),
        )
        conn.execute(
            "UPDATE items SET label = ?, role = ?, subgroup = ? WHERE section = ? AND item = ?",
            (c.label, c.role, c.subgroup, c.section, c.item),
        )
    item_ids = {(sec, it): i for i, sec, it in conn.execute("SELECT id, section, item FROM items")}

    latest: dict[str, dict[int, int | None]] = {}
    for d, item_id, v in conn.execute(
        """SELECT c.report_date, c.item_id, c.value FROM claims c
           JOIN (SELECT report_date, item_id, MAX(snapshot) AS ms FROM claims
                 GROUP BY report_date, item_id) l
             ON c.report_date = l.report_date AND c.item_id = l.item_id AND c.snapshot = l.ms"""
    ):
        latest.setdefault(d, {})[item_id] = v

    changes: list[tuple[str, int, int | None]] = []
    for d, values in data.items():
        before = latest.get(d, {})
        now = {item_ids[key]: v for key, v in values.items()}
        changes += [(d, item_id, v) for item_id, v in now.items() if before.get(item_id) != v]
        changes += [(d, item_id, None) for item_id, v in before.items() if v is not None and item_id not in now]

    stored_notes = dict(conn.execute(
        """SELECT n.report_date, n.text FROM notes n
           JOIN (SELECT report_date, MAX(snapshot) AS ms FROM notes GROUP BY report_date) l
             ON n.report_date = l.report_date AND n.snapshot = l.ms"""
    ).fetchall())
    note_changes = [(d, t) for d, t in notes.items() if stored_notes.get(d) != t]

    if changes or note_changes:
        snapshot = conn.execute("INSERT INTO snapshots (scraped_at) VALUES (?)", (scraped_at,)).lastrowid
        conn.executemany(
            "INSERT INTO claims (report_date, item_id, snapshot, value) VALUES (?, ?, ?, ?)",
            [(d, i, snapshot, v) for d, i, v in changes],
        )
        conn.executemany(
            "INSERT INTO notes (report_date, snapshot, text) VALUES (?, ?, ?)",
            [(d, snapshot, t) for d, t in note_changes],
        )
    conn.commit()
    if changes or note_changes:
        conn.execute("VACUUM")
    return {"cells": len(changes), "notes": len(note_changes), "days": len(data)}


def fetch() -> str:
    req = urllib.request.Request(CSV_URL, headers={"User-Agent": "sbs-stats-ingest"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        return resp.read().decode("utf-8")


def main() -> int:
    ap = argparse.ArgumentParser(description="Build the RU MoD claimed-UA-losses DB from John Felix's sheet")
    ap.add_argument("--out", default=str(SCRIPT_DIR / "output" / DEFAULT_DB_NAME),
                    help=f"output SQLite path (default: scripts/ua_losses_ru_mod/output/{DEFAULT_DB_NAME})")
    ap.add_argument("--csv", help="read this CSV export instead of fetching the sheet")
    args = ap.parse_args()

    text = Path(args.csv).read_text(encoding="utf-8") if args.csv else fetch()
    columns, data, notes = parse(text)
    conn = connect(Path(args.out))
    try:
        result = store(conn, columns, data, notes)
        latest = conn.execute("SELECT MAX(report_date) FROM latest_claims").fetchone()[0]
    finally:
        conn.close()
    per_section: dict[str, int] = {}
    for c in columns:
        per_section[c.section] = per_section.get(c.section, 0) + 1
    print(f"==> {result['days']} days (latest {latest}); inserted {result['cells']} cell versions, "
          f"{result['notes']} notes → {args.out}")
    print("    columns per section: " + ", ".join(f"{s} {n}" for s, n in per_section.items()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
