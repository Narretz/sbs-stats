#!/usr/bin/env python3
"""
ingest.py — build the Russian air-attacks-on-Ukraine DB (ru-air-attacks-gsua.db) from
piterfm's Kaggle dataset "Massive Missile Attacks on Ukraine".

Named as the Ukrainian-side mirror of scripts/ru_mod's ru-mod-ad.db: ru-mod-ad =
what UA launched at Russia + RU intercepts; ru-air-attacks-gsua = what RU launched at
Ukraine + UA intercepts. (Source here is the UA Air Force Command + General Staff
via piterfm/Kaggle, not the UA MoD channel directly, and this table carries both
`launched` and `destroyed` — broader than ru-mod-ad's intercepts-only.)

Source: https://www.kaggle.com/datasets/piterfm/massive-missile-attacks-on-ukraine
piterfm (Petro Ivaniuk) digitizes the Ukrainian Air Force Command + General Staff
daily reports of Russian missile/UAV strikes into a long-format CSV
(`missile_attacks_daily.csv`): ONE ROW PER WEAPON MODEL PER ATTACK, with a
`time_start`/`time_end` window and `launched`/`destroyed` counts. So a single
overnight strike using Shahed-136 + Kh-101 + Kalibr is three rows sharing the
same window. We keep that grain as-is and aggregate (daily volume etc.) in the
query layer / views — the filename says "daily" but it is NOT a daily aggregate.

This data is Kaggle-only (no GitHub mirror; piterfm's GitHub dataset repo holds
only the losses JSON). The Kaggle API gates programmatic downloads behind a free
account's API token — set KAGGLE_USERNAME / KAGGLE_KEY (the two fields from
kaggle.json) and we pull the whole-dataset zip over HTTP Basic auth. No `kaggle`
pip package needed; stdlib only (urllib + zipfile + csv + sqlite3).

Snapshot-only (the frontend never calls Kaggle): this runs in CI, writes a small
SQLite file, and that file is uploaded to R2.

Append-only & versioned on edit — mirrors scripts/ru_mod and scripts/ru_losses.
piterfm re-publishes the dataset roughly weekly and EDITS historical rows in
place (Kaggle versions are whole-file snapshots, not row-addressable), so each run
re-downloads the latest file and, per natural key, inserts a NEW row tagged with
`scraped_at` only when a value changed (or the key is new). Nothing is ever
overwritten; the frontend reads the latest `scraped_at` per key. We use
`scraped_at` (when WE ingested) — not `snapshot_at`, which in the GSUA schema
already means the source's own "as of" timestamp.

The natural key is (time_start, time_end, model, launch_place, target, source) —
`source` (the originating UA Air Force / regional-command post) is what makes a
row unique: same-day reports of the same model+target from different commands
differ only by source. A header-drift guard aborts the build (so the R2 upload is
skipped) if any essential column is missing; a row-count floor, a "never fewer
keys than already stored" guard, and an in-download key-uniqueness guard refuse a
partial/broken or unexpectedly-shaped download.
"""
from __future__ import annotations

import argparse
import base64
import csv
import io
import os
import sqlite3
import sys
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path

SLUG = os.environ.get("MISSILE_SLUG", "piterfm/massive-missile-attacks-on-ukraine")
CSV_NAME = os.environ.get("MISSILE_CSV_NAME", "missile_attacks_daily.csv")
SCRIPT_DIR = Path(__file__).resolve().parent
# DB filename — Ukrainian-side mirror of ru-mod-ad.db. Overridable via env.
DB_NAME = "ru-air-attacks-gsua.db"
DEFAULT_DB_NAME = os.environ.get("MISSILE_DB_NAME", DB_NAME)
TABLE = "missile_attacks"

# Natural-key columns, in priority order. Each row is one report line; `source`
# (the originating UA Air Force / regional-command post) is what makes a row
# unique — same-day reports of the same model+target from different commands
# differ only by source. time_start/time_end/model/source are guaranteed by the
# header-drift guard; launch_place/target further disambiguate. Everything else
# in the header is a "value" column subject to versioning.
KEY_COLS = ["time_start", "time_end", "model", "launch_place", "target", "source"]
# Stored as INTEGER (everything else as TEXT).
INT_COLS = ["launched", "destroyed"]
# Columns that MUST exist or the source shape changed — abort rather than write.
REQUIRED = {"time_start", "time_end", "model", "launched", "destroyed", "source"}
# Derived column we add (not in the CSV): date portion of time_start, for daily
# aggregation without relying on SQLite parsing arbitrary timestamp formats.
DATE_COL = "attack_date"

# Absolute floor: the dataset spans Oct 2022→now at one row per model per attack,
# i.e. thousands of rows. Anything tiny means a broken/partial download.
MIN_ROWS_FLOOR = int(os.environ.get("MISSILE_MIN_ROWS", "1000"))

KAGGLE_DOWNLOAD = "https://www.kaggle.com/api/v1/datasets/download/{slug}"


# ── fetch ─────────────────────────────────────────────────────────────────────
class _RedirectStripAuth(urllib.request.HTTPRedirectHandler):
    """Drop our Basic-auth header when Kaggle 302-redirects to signed storage."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        new = super().redirect_request(req, fp, code, msg, headers, newurl)
        if new is not None:
            new.headers.pop("Authorization", None)
            new.unredirected_hdrs.pop("Authorization", None)
        return new


def fetch_csv_from_kaggle(slug: str, csv_name: str) -> str:
    """Download the dataset zip via the Kaggle API and return the CSV text.

    Requires KAGGLE_USERNAME / KAGGLE_KEY (free account → Settings → API token).
    """
    user = os.environ.get("KAGGLE_USERNAME")
    key = os.environ.get("KAGGLE_KEY")
    if not user or not key:
        raise SystemExit(
            "ERROR: set KAGGLE_USERNAME and KAGGLE_KEY (from kaggle.json) — the "
            "Kaggle API requires a (free) account token. Or pass --csv <path> to "
            "ingest a locally downloaded file."
        )
    url = KAGGLE_DOWNLOAD.format(slug=slug)
    token = base64.b64encode(f"{user}:{key}".encode()).decode()
    req = urllib.request.Request(
        url,
        headers={"Authorization": f"Basic {token}", "User-Agent": "sbs-stats-ingest"},
    )
    opener = urllib.request.build_opener(_RedirectStripAuth())
    with opener.open(req, timeout=180) as resp:
        if resp.status != 200:
            raise RuntimeError(f"{url} returned HTTP {resp.status}")
        blob = resp.read()
    return _extract_csv(blob, csv_name)


def _extract_csv(blob: bytes, csv_name: str) -> str:
    """The dataset download is a zip; pull out the wanted CSV by basename."""
    if not zipfile.is_zipfile(io.BytesIO(blob)):
        # A single-file download can come back as the raw CSV.
        return blob.decode("utf-8-sig")
    with zipfile.ZipFile(io.BytesIO(blob)) as zf:
        match = next((n for n in zf.namelist() if n.split("/")[-1] == csv_name), None)
        if match is None:
            raise RuntimeError(
                f"{csv_name} not found in dataset zip (members: {zf.namelist()})"
            )
        with zf.open(match) as f:
            return f.read().decode("utf-8-sig")


# ── parse ───────────────────────────────────────────────────────────────────
def parse_rows(text: str) -> tuple[list[str], list[dict]]:
    """Return (header, rows). Each row is a dict with stripped values + DATE_COL.

    Key columns are coalesced to '' (never NULL) so they group/join cleanly.
    Aborts if the essential columns are missing (source shape changed).
    """
    reader = csv.DictReader(io.StringIO(text))
    header = reader.fieldnames or []
    missing = REQUIRED - set(header)
    if missing:
        raise RuntimeError(
            f"{CSV_NAME} is missing required columns {sorted(missing)} — source "
            f"shape changed? Got header {header}."
        )

    key_cols = [c for c in KEY_COLS if c in header]
    rows: list[dict] = []
    for raw in reader:
        row = {c: (raw.get(c) or "").strip() for c in header}
        for c in key_cols:
            row[c] = row.get(c, "")  # already '' if empty — keep non-NULL keys
        ts = row.get("time_start", "")
        row[DATE_COL] = ts[:10] if len(ts) >= 10 else ""
        rows.append(row)
    return header, rows


def _ident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


# ── store ─────────────────────────────────────────────────────────────────
def build(db_path: Path, header: list[str], rows: list[dict]) -> tuple[int, int, str | None]:
    """Append changed/new rows into db_path; never mutates/deletes. Returns
    (inserted_versions, distinct_keys, latest_attack_date)."""
    # Guard 1: absolute floor.
    if len(rows) < MIN_ROWS_FLOOR:
        raise RuntimeError(
            f"parsed only {len(rows)} rows (< floor {MIN_ROWS_FLOOR}) — refusing to "
            f"write {db_path}. Kaggle likely returned a partial/empty download."
        )

    key_cols = [c for c in KEY_COLS if c in header]
    all_cols = header + [DATE_COL]
    value_cols = [c for c in all_cols if c not in key_cols]

    def col_type(c: str) -> str:
        return "INTEGER" if c in INT_COLS else "TEXT"

    coldefs = ", ".join(f"{_ident(c)} {col_type(c)}" for c in all_cols)
    pk = ", ".join(_ident(c) for c in key_cols + ["scraped_at"])

    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            f"CREATE TABLE IF NOT EXISTS {TABLE} "
            f"({coldefs}, scraped_at TEXT NOT NULL, PRIMARY KEY ({pk}))"
        )
        _create_views(conn, key_cols, value_cols)

        # Latest stored version per natural key, for change detection.
        keysel = ", ".join(f"t.{_ident(c)}" for c in key_cols)
        valsel = ", ".join(f"t.{_ident(c)}" for c in value_cols)
        joinon = " AND ".join(f"t.{_ident(c)} = l.{_ident(c)}" for c in key_cols)
        grp = ", ".join(_ident(c) for c in key_cols)
        stored: dict[tuple, tuple] = {}
        for r in conn.execute(
            f"SELECT {keysel}, {valsel} FROM {TABLE} t "
            f"JOIN (SELECT {grp}, MAX(scraped_at) ms FROM {TABLE} GROUP BY {grp}) l "
            f"ON {joinon} AND t.scraped_at = l.ms"
        ):
            n = len(key_cols)
            stored[tuple(r[:n])] = tuple(r[n:])

        # Guard 2: never accept a dataset with fewer distinct keys than stored.
        fetched_keys = {tuple(row[c] for c in key_cols) for row in rows}
        if len(fetched_keys) < len(stored):
            raise RuntimeError(
                f"download has {len(fetched_keys)} distinct keys but DB already has "
                f"{len(stored)} — refusing to write a shrinking dataset into {db_path}."
            )

        # Guard 3: keys must be unique WITHIN one download — every row in a run
        # shares one scraped_at, so colliding keys would fail the PK. If this
        # fires, KEY_COLS is missing a distinguishing column (that's exactly how
        # we found `source` belonged in the key). Surface it clearly instead of a
        # raw IntegrityError.
        if len(fetched_keys) < len(rows):
            seen: set[tuple] = set()
            dups = [k for row in rows
                    if (k := tuple(row[c] for c in key_cols)) in seen or seen.add(k)]
            raise RuntimeError(
                f"{len(rows) - len(fetched_keys)} duplicate natural key(s) within one "
                f"download (e.g. {dups[:3]}) — KEY_COLS is missing a distinguishing "
                f"column. Refusing to write {db_path}."
            )

        def norm(c: str, v):
            if c in INT_COLS:
                if v in ("", None):
                    return None
                # pandas serializes int columns with missing values as floats,
                # so counts arrive like "600.0" — round-trip through float.
                return int(float(v))
            return v

        scraped = datetime.now(timezone.utc).isoformat(timespec="microseconds")
        insert_cols = key_cols + value_cols + ["scraped_at"]
        placeholders = ", ".join(["?"] * len(insert_cols))
        collist = ", ".join(_ident(c) for c in insert_cols)
        to_insert = []
        for row in rows:
            k = tuple(row[c] for c in key_cols)
            vals = tuple(norm(c, row.get(c)) for c in value_cols)
            if stored.get(k) == vals:
                continue  # unchanged — no new version
            to_insert.append(
                [norm(c, row.get(c)) for c in key_cols]
                + list(vals)
                + [scraped]
            )

        if to_insert:
            conn.executemany(
                f"INSERT INTO {TABLE} ({collist}) VALUES ({placeholders})", to_insert
            )
            conn.commit()
            conn.execute("VACUUM")
            conn.commit()

        distinct = conn.execute(
            f"SELECT COUNT(*) FROM (SELECT 1 FROM {TABLE} GROUP BY {grp})"
        ).fetchone()[0]
        latest = conn.execute(
            f"SELECT MAX({_ident(DATE_COL)}) FROM {TABLE}"
        ).fetchone()[0]
    finally:
        conn.close()
    return len(to_insert), distinct, latest


def _create_views(conn, key_cols, value_cols):
    """Latest-per-key view + daily aggregates over the latest snapshot."""
    grp = ", ".join(_ident(c) for c in key_cols)
    joinon = " AND ".join(f"t.{_ident(c)} = l.{_ident(c)}" for c in key_cols)
    conn.execute(
        f"CREATE VIEW IF NOT EXISTS {TABLE}_latest AS "
        f"SELECT t.* FROM {TABLE} t "
        f"JOIN (SELECT {grp}, MAX(scraped_at) ms FROM {TABLE} GROUP BY {grp}) l "
        f"ON {joinon} AND t.scraped_at = l.ms"
    )
    # Daily totals (attribute each attack to the date of its time_start).
    conn.execute(
        f"CREATE VIEW IF NOT EXISTS daily_totals AS "
        f"SELECT {_ident(DATE_COL)} AS date, "
        f"       SUM(launched)  AS launched, "
        f"       SUM(destroyed) AS destroyed, "
        f"       COUNT(*)       AS rows "
        f"FROM {TABLE}_latest GROUP BY {_ident(DATE_COL)}"
    )
    conn.execute(
        f"CREATE VIEW IF NOT EXISTS daily_by_model AS "
        f"SELECT {_ident(DATE_COL)} AS date, model, "
        f"       SUM(launched)  AS launched, "
        f"       SUM(destroyed) AS destroyed "
        f"FROM {TABLE}_latest GROUP BY {_ident(DATE_COL)}, model"
    )


# ── main ───────────────────────────────────────────────────────────────────
def main() -> int:
    ap = argparse.ArgumentParser(
        description="Build ru-air-attacks-gsua.db from piterfm's Kaggle dataset."
    )
    ap.add_argument(
        "--out",
        default=os.environ.get(
            "MISSILE_DB_PATH", str(SCRIPT_DIR / "output" / DEFAULT_DB_NAME)
        ),
        help="output SQLite path (default: scripts/missile_attacks/output/%s)" % DEFAULT_DB_NAME,
    )
    ap.add_argument(
        "--csv",
        help="ingest a local CSV instead of downloading from Kaggle (for testing).",
    )
    ap.add_argument(
        "--save-csv",
        metavar="PATH",
        help="write the downloaded CSV to PATH before parsing (so one download can "
        "serve repeated parse iterations / debugging). Saved even if the build fails.",
    )
    args = ap.parse_args()

    if args.csv:
        print(f"==> Reading local CSV {args.csv}")
        text = Path(args.csv).read_text(encoding="utf-8-sig")
    else:
        print(f"==> Downloading {SLUG} :: {CSV_NAME} from Kaggle")
        text = fetch_csv_from_kaggle(SLUG, CSV_NAME)

    if args.save_csv:
        Path(args.save_csv).write_text(text, encoding="utf-8")
        print(f"==> Saved downloaded CSV → {args.save_csv}")

    header, rows = parse_rows(text)
    out = Path(args.out)
    inserted, distinct, latest = build(out, header, rows)
    print(
        f"==> Parsed {len(rows)} rows; inserted {inserted} new/changed versions; "
        f"{distinct} distinct attack-rows (latest {latest}) → {out} "
        f"({out.stat().st_size} bytes)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
