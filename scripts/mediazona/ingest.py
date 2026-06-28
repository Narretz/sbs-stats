#!/usr/bin/env python3
"""
ingest.py — build mediazona.db from Mediazona/Meduza's two weekly CSV exports.

Source: Mediazona + Meduza's count of Russian war dead, published as periodic
articles (see scripts/mediazona/README.md). Two distinct weekly series:

  1. confirmed_losses_per_week.csv  — CONFIRMED, individually-NAMED deaths, broken
     down by branch/role. Bucketed by *date of death*; recent weeks are right-
     censored (deaths not yet identified). → table `weekly_roles`.

  2. probate_registry_estimate.csv  — the probate-registry-based estimate.
     Columns:
       real  — documented/named deaths by week (cumulative ≈ 217,808)
       rnd   — the "estimate of actual losses" topline (cum. ≈ 352,000)
     → table `weekly_estimate` (documented = real, estimate = rnd).

The two CSVs use different week anchors (roles = Thursday from war start;
estimate = Monday) and are different snapshots; the frontend charts them
separately. See README for the full data model.

APPEND-ONLY / EDIT-VERSIONED. Mirrors the ru_losses / gsua model. A stored row
is never mutated or deleted. Each row in either table is one *version* of that
week's numbers, tagged with `scraped_at` (ingest UTC) and `published_at` (the
Mediazona article's publication date — passed in via --published-at, analogous
to ru_losses' `reported_at`). On each run we compare fetched values against the
latest stored version per week and INSERT a NEW row only when they differ (or
the week is new). The frontend reads the latest snapshot per week.

This shape matters here: Mediazona publishes infrequently (the May-22-2026
article was the only public source at the time of writing) and revises prior
weeks each release as more probate filings complete. Append-versioned storage
preserves the full historical development across releases — a fresh release
ingested with --published-at 2026-11-DD will leave the May-22-2026 numbers
intact and add new rows where the values changed.

A row-count floor + a no-shrink guard abort the build (without writing) if the
fetch looks broken, so a partial/empty CSV leaves the DB untouched.

stdlib only (csv + sqlite3) — no extra dependencies.
"""

from __future__ import annotations

import argparse
import csv
import gzip
import json
import os
import re
import sqlite3
import sys
import urllib.request
from datetime import date as date_cls, datetime, timedelta, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_SOURCE = SCRIPT_DIR / "source"
DEFAULT_DB_NAME = os.environ.get("MEDIAZONA_DB_NAME", "mediazona.db")

# weekly_roles columns ← raw CSV headers. We store every role column verbatim
# (plus `total`) and leave grouping to the frontend (MEDIAZONA_ROLE_GROUPS in
# src/types/index.ts), so the bucketing can change without a re-ingest.
ROLE_COLS = [
    "total", "nguard", "rifle", "air", "pilot", "seaman", "marine", "tank",
    "art", "eng", "other", "nd", "special", "vol", "mob", "signal", "airdef",
    "chem", "pmc", "fsb", "groundavia", "inmates",
]

# A war that started 2022-02-24 yields ~200 weeks by 2026 — a healthy CSV has
# well over a year of rows. Far below this means a truncated/empty export.
MIN_ROWS_FLOOR = 100

# ── Article-fetch mode (--from-article) ───────────────────────────────────────
# Mediazona republishes the same casualty count under a new date-coded URL
# every ~2 weeks. The URL below is a known release; if Mediazona rotates it,
# they have historically kept old URLs alive (and the new release just lives
# at a fresher path), so the workflow should be re-pointed when that changes.
DEFAULT_ARTICLE_URL = "https://en.zona.media/article/2026/06/19/casualties_eng-trl"

# Week-1 anchor for the roles series — same as the CSV's `week_start` anchor.
WAR_START = date_cls(2022, 2, 24)

# Blob 5 inside the bundle is a dict {'0'..'N-1': [int, …]} of per-day deaths
# per role. Indices 0..15 follow the chart's display order; 16..20 are a
# slightly different ordering of the last 5 cells than our CSV layout. Verified
# by matching blob 5's per-index sums against blob 3's per-Russian-name totals
# (see _check_blob5_drift below). If upstream re-shuffles, the drift check
# fires and the build aborts.
BLOB5_COLUMN_MAP = [
    "nguard", "rifle", "air", "pilot", "seaman", "marine",
    "tank", "art", "eng", "other", "nd", "special",
    "vol", "mob", "signal", "airdef",
    "groundavia", "pmc", "fsb", "chem", "inmates",
]


def iso(ddmmyyyy: str) -> str:
    """'24.02.2022' → '2022-02-24'."""
    d, m, y = (int(x) for x in ddmmyyyy.strip().strip('"').split("."))
    return date_cls(y, m, d).isoformat()


def to_int(v: str) -> int | None:
    v = v.strip()
    return int(v) if v else None


def to_float(v: str) -> float | None:
    v = v.strip()
    return float(v) if v else None


def parse_roles(path: Path) -> list[tuple]:
    """Return [(week_iso, *ROLE_COLS values)]. Blank cells → 0 (meaningful 0 for a
    stacked composition). Rows whose `total` is blank (a not-yet-filled trailing
    week) are skipped entirely."""
    rows: list[tuple] = []
    with path.open(newline="", encoding="utf-8") as f:
        for rec in csv.DictReader(f):
            if not (rec.get("week_start") or "").strip():
                continue
            if not (rec.get("total") or "").strip():
                continue
            week = iso(rec["week_start"])
            vals = [to_int(rec.get(c, "")) or 0 for c in ROLE_COLS]
            rows.append((week, *vals))
    return rows


def _fetch(url: str) -> bytes:
    req = urllib.request.Request(
        url, headers={"User-Agent": "Mozilla/5.0 (sbs-stats-ingest)"},
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def fetch_bundle(article_url: str) -> str:
    """Resolve the bodycount JS bundle URL from the article HTML and return
    its decoded source.

    The article HTML embeds the bundle via a hashed S3 path
    (`.../main.<hash>.js.gz`); the hash changes with each release, so we
    discover it dynamically. The .js.gz is served gzip-compressed regardless
    of Accept-Encoding, so we decompress unconditionally on the magic bytes.
    """
    html = _fetch(article_url).decode("utf-8", errors="replace")
    m = re.search(
        r'(https://s3\.zona\.media/infographics/bodycount/main\.[a-f0-9]+\.js\.gz)',
        html,
    )
    if not m:
        raise RuntimeError(f"no bodycount bundle URL found in {article_url}")
    bundle_url = m.group(1)
    print(f"[fetch] article {article_url}\n         -> bundle {bundle_url}")
    raw = _fetch(bundle_url)
    if raw[:2] == b"\x1f\x8b":  # gzip magic
        raw = gzip.decompress(raw)
    return raw.decode("utf-8")


def _extract_json_blobs(bundle: str) -> list[object]:
    """Mediazona inlines all chart data as JSON.parse('…') literals in the
    bundle — there are no XHR/fetch calls. Pull every such literal out."""
    out: list[object] = []
    for m in re.finditer(r"JSON\.parse\('((?:\\.|[^\\'])*)'\)", bundle, re.DOTALL):
        body = m.group(1).encode("utf-8").decode("unicode_escape")
        try:
            out.append(json.loads(body))
        except Exception as e:
            print(f"[warn] JSON.parse blob at offset {m.start()} failed: {e!r}",
                  file=sys.stderr)
    return out


def _find_estimate_blob(blobs: list[object]) -> list[dict]:
    """Probate estimate: list of dicts whose keys are exactly {w, rnd, real}.
    Identified by shape so a reordering of blobs in the bundle doesn't break us."""
    for b in blobs:
        if (isinstance(b, list) and b and isinstance(b[0], dict)
                and set(b[0]) == {"w", "rnd", "real"}):
            return b
    raise RuntimeError("no probate-estimate blob ({w,rnd,real} list) in bundle")


def _find_roles_blob(blobs: list[object]) -> dict[str, list[int]]:
    """Roles daily series: dict of equal-length int lists."""
    for b in blobs:
        if (isinstance(b, dict) and len(b) >= 10
                and all(isinstance(v, list) for v in b.values())
                and len(set(len(v) for v in b.values())) == 1
                and all(isinstance(x, int) for x in next(iter(b.values()))[:20])):
            return b
    raise RuntimeError("no roles blob (dict of equal-length int lists) in bundle")


def _find_roles_summary_blob(blobs: list[object]) -> list[dict]:
    """Per-category summary: list of {k:str, o:int, v:int}. Cross-validates
    blob 5 in _check_blob5_drift."""
    for b in blobs:
        if (isinstance(b, list) and b and isinstance(b[0], dict)
                and set(b[0]) == {"k", "o", "v"}):
            return b
    raise RuntimeError("no roles-summary blob ({k,o,v} list) in bundle")


def _check_blob5_drift(daily: dict[str, list[int]], summary: list[dict]) -> None:
    """Guard: each blob 5 index's all-time sum should match the per-category
    `v` of some entry in blob 3, within 10%. If not, the column taxonomy or
    ordering drifted and BLOB5_COLUMN_MAP is no longer trustworthy — abort
    rather than write a silently-shuffled dataset.

    A single tolerated miss (currently: index 10 = 'nd' / "нет данных", where
    blob 5 omits a residual bucket present in blob 3 — ~21% gap) is allowed;
    more than that means real drift.
    """
    summary_totals = sorted(r["v"] for r in summary)
    misses = []
    for k in sorted(daily.keys(), key=int):
        s = sum(daily[k])
        if not any(abs(s - v) <= max(10, 0.10 * max(s, v)) for v in summary_totals):
            misses.append((k, s))
    if len(misses) > 1:
        msg = (f"blob 5 / blob 3 drift: {len(misses)} indices have no within-10% "
               f"match in the summary blob ({misses}). The role taxonomy or "
               f"ordering changed upstream — re-validate BLOB5_COLUMN_MAP "
               f"before re-running.")
        raise RuntimeError(msg)
    if misses:
        print(f"[check] tolerated drift on 1 blob 5 index (expected for nd): {misses}")


def _aggregate_roles_blob_to_rows(daily: dict[str, list[int]]) -> list[tuple]:
    """Daily per-role → tuples in the shape `parse_roles()` would produce —
    `(week_iso, *ROLE_COLS values)`, Thursday-anchored from 2022-02-24."""
    keys = sorted(daily.keys(), key=int)
    if len(keys) != len(BLOB5_COLUMN_MAP):
        raise RuntimeError(
            f"blob 5 has {len(keys)} keys but BLOB5_COLUMN_MAP has "
            f"{len(BLOB5_COLUMN_MAP)} — re-validate the column mapping.")
    n_days = len(next(iter(daily.values())))
    rows: list[tuple] = []
    for wi in range(0, n_days, 7):
        wend = min(wi + 7, n_days)
        per_col = {col: sum(daily[k][wi:wend]) for col, k in zip(BLOB5_COLUMN_MAP, keys)}
        per_col["total"] = sum(per_col.values())
        week_iso = (WAR_START + timedelta(days=wi)).isoformat()
        rows.append((week_iso, *[per_col[c] for c in ROLE_COLS]))
    return rows


def _estimate_blob_to_rows(blob: list[dict]) -> list[tuple]:
    """Probate estimate blob → tuples matching `parse_estimate()`'s shape.
    Skip the 4 metadata rows ({last_date, current_date, last_total,
    current_total}) — they aren't weekly observations."""
    rows: list[tuple] = []
    for rec in blob:
        w = str(rec.get("w", ""))
        if not re.fullmatch(r"\d{2}\.\d{2}\.\d{4}", w):
            continue
        documented = int(rec["real"]) if rec.get("real") is not None else None
        estimate = float(rec["rnd"]) if rec.get("rnd") is not None else None
        if documented is None and estimate is None:
            continue
        rows.append((iso(w), documented, estimate))
    return rows


def _published_at_from_blob(blob: list[dict]) -> str:
    """Derive the article's publication date from the estimate blob's
    `current_date` metadata row (the `real` field is the article date in
    DD.MM.YYYY)."""
    for rec in blob:
        if rec.get("w") == "current_date":
            return iso(rec["real"])
    raise RuntimeError("estimate blob missing the `current_date` metadata row")


def fetch_from_article(article_url: str) -> tuple[list[tuple], list[tuple], str]:
    """End-to-end: article URL → (roles_rows, estimate_rows, published_at_iso).

    `roles_rows` and `estimate_rows` are in the same shape as `parse_roles()`
    and `parse_estimate()` return, so they drop straight into build().
    """
    bundle = fetch_bundle(article_url)
    blobs = _extract_json_blobs(bundle)
    estimate_blob = _find_estimate_blob(blobs)
    roles_blob = _find_roles_blob(blobs)
    summary_blob = _find_roles_summary_blob(blobs)
    print(f"[parse] {len(blobs)} JSON blobs; roles={len(roles_blob)} cats × "
          f"{len(next(iter(roles_blob.values())))} days; "
          f"estimate={len(estimate_blob)} rows; summary={len(summary_blob)} cats")
    _check_blob5_drift(roles_blob, summary_blob)
    return (
        _aggregate_roles_blob_to_rows(roles_blob),
        _estimate_blob_to_rows(estimate_blob),
        _published_at_from_blob(estimate_blob),
    )


def parse_estimate(path: Path) -> list[tuple]:
    """Return [(week_iso, documented:int|None, estimate:float|None)] from the
    probate file's (week, real, rnd) columns. Rows with neither value are skipped."""
    rows: list[tuple] = []
    with path.open(newline="", encoding="utf-8") as f:
        for rec in csv.DictReader(f):
            if not (rec.get("week") or "").strip():
                continue
            documented = to_int(rec.get("real", ""))
            estimate = to_float(rec.get("rnd", ""))
            if documented is None and estimate is None:
                continue
            rows.append((iso(rec["week"]), documented, estimate))
    return rows


def build(
    db_path: Path,
    roles: list[tuple],
    estimate: list[tuple],
    scraped_at: str,
    published_at: str,
) -> tuple[dict, dict]:
    """Append changed/new week-versions into db_path. Never mutates/deletes rows.

    Returns (roles_summary, estimate_summary), each a dict with:
        new       — count of weeks not in DB before this run
        revised   — count of pre-existing weeks whose values differ from prior
        unchanged — count of pre-existing weeks whose values match prior (skipped)
        distinct  — total distinct weeks in the table after the run
    new + revised = number of rows actually inserted. Aborts (raises) without
    writing if either payload looks broken or would shrink an existing dataset.
    """
    # Guard 1: absolute floor.
    if len(roles) < MIN_ROWS_FLOOR:
        raise RuntimeError(
            f"roles CSV parsed only {len(roles)} weeks (< floor {MIN_ROWS_FLOOR}) — "
            f"refusing to write {db_path}; the export is probably truncated."
        )
    if len(estimate) < MIN_ROWS_FLOOR:
        raise RuntimeError(
            f"estimate CSV parsed only {len(estimate)} weeks (< floor {MIN_ROWS_FLOOR}) — "
            f"refusing to write {db_path}; the export is probably truncated."
        )

    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    try:
        role_cols_sql = ", ".join(f"{c} INTEGER NOT NULL DEFAULT 0" for c in ROLE_COLS)
        conn.executescript(
            f"""
            CREATE TABLE IF NOT EXISTS weekly_roles (
                week TEXT NOT NULL,
                scraped_at TEXT NOT NULL,
                published_at TEXT,
                {role_cols_sql},
                PRIMARY KEY (week, scraped_at)
            );
            CREATE TABLE IF NOT EXISTS weekly_estimate (
                week TEXT NOT NULL,
                scraped_at TEXT NOT NULL,
                published_at TEXT,
                documented INTEGER,
                estimate REAL,
                PRIMARY KEY (week, scraped_at)
            );
            """
        )

        # Latest stored version per week, for change detection. Mirrors
        # ru_losses' LATEST_PER_DATE pattern.
        role_metric_cols = ", ".join(ROLE_COLS)
        latest_roles = {
            r[0]: tuple(r[1:])
            for r in conn.execute(
                f"""
                SELECT d.week, {role_metric_cols}
                FROM weekly_roles d
                JOIN (SELECT week, MAX(scraped_at) AS ms FROM weekly_roles GROUP BY week) l
                  ON d.week = l.week AND d.scraped_at = l.ms
                """
            ).fetchall()
        }
        latest_estimate = {
            r[0]: (r[1], r[2])
            for r in conn.execute(
                """
                SELECT d.week, documented, estimate
                FROM weekly_estimate d
                JOIN (SELECT week, MAX(scraped_at) AS ms FROM weekly_estimate GROUP BY week) l
                  ON d.week = l.week AND d.scraped_at = l.ms
                """
            ).fetchall()
        }

        # Guard 2: shrink — a new export should never have fewer distinct weeks
        # than what's already stored. Catches a half-empty CSV that passed Guard 1.
        if len(roles) < len(latest_roles):
            raise RuntimeError(
                f"parsed {len(roles)} role-weeks but DB already has {len(latest_roles)} — "
                f"refusing to write a shrinking dataset into {db_path}."
            )
        if len(estimate) < len(latest_estimate):
            raise RuntimeError(
                f"parsed {len(estimate)} estimate-weeks but DB already has "
                f"{len(latest_estimate)} — refusing to write a shrinking dataset."
            )

        # Split the comparison into new vs revised vs unchanged so the CLI can
        # report a useful breakdown — a 200-row insert against an empty table
        # and a 200-row revision against a populated one look identical in a
        # single "inserted" counter, hiding both surprising backfills and the
        # cadence of Mediazona's revisions.
        roles_to_insert: list[list] = []
        roles_new = roles_revised = roles_unchanged = 0
        for week, *vals in roles:
            prior = latest_roles.get(week)
            if prior is None:
                roles_new += 1
                roles_to_insert.append([week, scraped_at, published_at, *vals])
            elif prior != tuple(vals):
                roles_revised += 1
                roles_to_insert.append([week, scraped_at, published_at, *vals])
            else:
                roles_unchanged += 1

        estimate_to_insert: list[list] = []
        est_new = est_revised = est_unchanged = 0
        for week, documented, estimate_val in estimate:
            prior = latest_estimate.get(week)
            if prior is None:
                est_new += 1
                estimate_to_insert.append([week, scraped_at, published_at, documented, estimate_val])
            elif prior != (documented, estimate_val):
                est_revised += 1
                estimate_to_insert.append([week, scraped_at, published_at, documented, estimate_val])
            else:
                est_unchanged += 1

        if roles_to_insert:
            ph = ", ".join(["?"] * (3 + len(ROLE_COLS)))
            cols = ", ".join(["week", "scraped_at", "published_at"] + ROLE_COLS)
            conn.executemany(
                f"INSERT INTO weekly_roles ({cols}) VALUES ({ph})",
                roles_to_insert,
            )
        if estimate_to_insert:
            conn.executemany(
                "INSERT INTO weekly_estimate "
                "(week, scraped_at, published_at, documented, estimate) "
                "VALUES (?, ?, ?, ?, ?)",
                estimate_to_insert,
            )
        if roles_to_insert or estimate_to_insert:
            conn.commit()
            conn.execute("VACUUM")
            conn.commit()

        roles_distinct = conn.execute("SELECT COUNT(DISTINCT week) FROM weekly_roles").fetchone()[0]
        est_distinct = conn.execute("SELECT COUNT(DISTINCT week) FROM weekly_estimate").fetchone()[0]
    finally:
        conn.close()
    return (
        {"new": roles_new, "revised": roles_revised, "unchanged": roles_unchanged, "distinct": roles_distinct},
        {"new": est_new, "revised": est_revised, "unchanged": est_unchanged, "distinct": est_distinct},
    )


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Append-version mediazona.db from the live article (default) "
        "or from local CSV exports (--roles/--estimate).",
    )
    ap.add_argument(
        "--from-article", nargs="?", const=DEFAULT_ARTICLE_URL, default=None,
        metavar="URL",
        help=("fetch & parse the live Mediazona article bundle; pass with no value "
              "to use the default URL (%s)" % DEFAULT_ARTICLE_URL),
    )
    ap.add_argument("--roles", default=str(DEFAULT_SOURCE / "confirmed_losses_per_week.csv"),
                    help="(local CSV mode) path to the confirmed-losses-by-role CSV")
    ap.add_argument("--estimate", default=str(DEFAULT_SOURCE / "probate_registry_estimate.csv"),
                    help="(local CSV mode) path to the probate-registry-estimate CSV")
    ap.add_argument("--published-at", default=None,
                    help="Mediazona article publication date (YYYY-MM-DD). Required in "
                         "local CSV mode; auto-derived from the bundle in --from-article mode "
                         "unless overridden.")
    ap.add_argument("--out", default=os.environ.get(
        "MEDIAZONA_DB_PATH", str(SCRIPT_DIR / "output" / DEFAULT_DB_NAME)),
        help="output SQLite path (default: scripts/mediazona/output/%s)" % DEFAULT_DB_NAME)
    args = ap.parse_args()

    if args.from_article:
        roles, estimate, derived_published_at = fetch_from_article(args.from_article)
        published_at = args.published_at or derived_published_at
    else:
        if not args.published_at:
            raise SystemExit("--published-at is required in local CSV mode")
        roles = parse_roles(Path(args.roles))
        estimate = parse_estimate(Path(args.estimate))
        published_at = args.published_at

    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", published_at):
        raise SystemExit(f"published_at must be YYYY-MM-DD, got {published_at!r}")

    scraped_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    out = Path(args.out)
    r, e = build(out, roles, estimate, scraped_at, published_at)
    fmt = lambda s: (
        f"{s['new']:>4} new, {s['revised']:>4} revised, {s['unchanged']:>4} unchanged "
        f"-> {s['new'] + s['revised']} inserted; {s['distinct']} distinct weeks"
    )
    print(
        f"==> roles:    {fmt(r)}\n"
        f"==> estimate: {fmt(e)}\n"
        f"==> published_at={published_at}  scraped_at={scraped_at}\n"
        f"==> {out} ({out.stat().st_size} bytes)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
