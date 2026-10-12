#!/usr/bin/env python3
"""
backfill.py — add Mediazona's past releases to mediazona.db.

The live ingest reads one release: whatever the article shows today. Every
release's chart bundle is still on Mediazona's S3 at its hashed path
(`main.<hash>.js.gz|br`); only the article page moved on. The Wayback Machine
captured most of those paths, so its index is the list of releases, and S3
serves the files themselves (Wayback is the fallback).

    python3 scripts/mediazona/backfill.py --discover          # refresh releases.csv from Wayback
    python3 scripts/mediazona/backfill.py --out data/mediazona.db

`releases.csv` (committed) lists every bundle with its first Wayback capture.
A run parses each one (`ingest.parse_bundle`), dates it by its own data (see
`ingest._published_at`), and stores those **older than the oldest release in
the DB** in release order — each compared with the release before it, so only
weeks that changed get a row, as in a live run. Newer releases are the live
ingest's; one already stored is never re-added. Re-running is a no-op.

A backfilled row's `scraped_at` is the bundle's Wayback capture time — when
that version was seen live — not the backfill's run time. It orders a
release's mid-cycle rebuilds (several bundles, one `published_at`) and keeps
every bundle's rows apart under the (week, scraped_at) key.

Bundles from before Mar 2023 are a different encoding (role totals and
per-region day series, no per-role days) and are skipped; any other bundle that
fails to parse aborts the run before anything is written.

stdlib only.
"""
from __future__ import annotations

import argparse
import csv
import gzip
import os
import re
import sqlite3
import sys
import urllib.request
from pathlib import Path

import ingest

SCRIPT_DIR = Path(__file__).resolve().parent
RELEASES = SCRIPT_DIR / "releases.csv"
CACHE = SCRIPT_DIR / "output" / "bundles"
S3 = "https://s3.zona.media/infographics/bodycount/"
CDX = ("https://web.archive.org/cdx/search/cdx?url=s3.zona.media/infographics/bodycount/"
       "&matchType=prefix&fl=timestamp,original,statuscode&limit=5000")
BUNDLE_RE = re.compile(r"https?://s3\.zona\.media/infographics/bodycount/(main\.[0-9a-f]+\.js(?:\.gz|\.br)?)")
# The first capture of a bundle in the roles-blob encoding. Earlier ones are skipped.
FIRST_DECODED = "20230311"


def discover() -> None:
    """Rewrite releases.csv from the Wayback index: each bundle once, at its
    first clean capture (status 200; the index also holds mangled URLs with
    HTML glued on, which match nothing here)."""
    with urllib.request.urlopen(CDX, timeout=120) as r:
        lines = r.read().decode().splitlines()
    first: dict[str, str] = {}
    for line in lines:
        ts, url, status = line.split(" ")
        m = BUNDLE_RE.fullmatch(url)
        if m and status == "200" and (m.group(1) not in first or ts < first[m.group(1)]):
            first[m.group(1)] = ts
    with RELEASES.open("w", newline="") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["captured", "bundle"])
        for bundle, ts in sorted(first.items(), key=lambda x: x[1]):
            w.writerow([ts, bundle])
    print(f"[discover] {len(first)} bundles -> {RELEASES}")


def bundle_source(name: str, captured: str) -> str:
    """The bundle's JS, from the local cache, S3, or Wayback, in that order."""
    path = CACHE / name
    if not path.exists():
        try:
            raw = ingest._fetch(S3 + name)
        except Exception as e:  # noqa: BLE001 — any S3 failure falls back to Wayback
            print(f"[fetch] {name}: S3 failed ({e}); trying Wayback", file=sys.stderr)
            raw = ingest._fetch(f"https://web.archive.org/web/{captured}id_/{S3}{name}")
        CACHE.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw)
    raw = path.read_bytes()
    if raw[:2] == b"\x1f\x8b":
        raw = gzip.decompress(raw)
    return raw.decode("utf-8")


def captured_iso(ts: str) -> str:
    """Wayback's 20250510120102 → 2025-05-10T12:01:02+00:00, the `scraped_at` form."""
    return f"{ts[:4]}-{ts[4:6]}-{ts[6:8]}T{ts[8:10]}:{ts[10:12]}:{ts[12:14]}+00:00"


def oldest_release(db: Path) -> str | None:
    if not db.exists():
        return None
    conn = sqlite3.connect(db)
    try:
        return conn.execute(
            "SELECT MIN(published_at) FROM (SELECT published_at FROM weekly_roles "
            "UNION ALL SELECT published_at FROM weekly_estimate)").fetchone()[0]
    except sqlite3.OperationalError:  # tables not created yet
        return None
    finally:
        conn.close()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[1])
    ap.add_argument("--discover", action="store_true",
                    help="refresh releases.csv from the Wayback index and exit")
    ap.add_argument("--out", default=os.environ.get(
        "MEDIAZONA_DB_PATH", str(SCRIPT_DIR / "output" / ingest.DEFAULT_DB_NAME)))
    args = ap.parse_args()
    if args.discover:
        discover()
        return 0

    out = Path(args.out)
    before = oldest_release(out)
    with RELEASES.open(newline="") as f:
        listed = [r for r in csv.DictReader(f) if r["captured"] >= FIRST_DECODED]

    # Parse everything first: a bundle that fails aborts before any write.
    parsed = []
    for r in listed:
        print(f"== {r['bundle']} (captured {r['captured']})")
        roles, estimate, published_at = ingest.parse_bundle(bundle_source(r["bundle"], r["captured"]))
        parsed.append((published_at, captured_iso(r["captured"]), roles, estimate, r["bundle"]))
    parsed.sort(key=lambda p: (p[0], p[1]))

    added = []
    for published_at, scraped_at, roles, estimate, bundle in parsed:
        if before is not None and published_at >= before:
            continue
        r, e = ingest.build(out, roles, estimate, scraped_at, published_at)
        added.append({"published_at": published_at, "bundle": bundle,
                      "roles": r["new"] + r["revised"],
                      "estimate": e["new"] + e["revised"] + e["removed"] if estimate is not None else None})
        print(f"[backfill] {published_at} {bundle}: roles +{added[-1]['roles']}, "
              f"estimate {'+' + str(added[-1]['estimate']) if estimate is not None else '(none)'}")

    skipped = len(parsed) - len(added)
    print(f"==> {len(added)} bundles backfilled, {skipped} at or after the oldest "
          f"stored release ({before}); {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
