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

Each stored version gets a `releases` row (source `wayback`, the bundle's S3
and Wayback URLs), and a run also fills in that table for versions stored
before it existed (`fill_releases`; see the README's Rebuild semantics).

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
import hashlib
import os
import re
import sqlite3
import sys
import time
import urllib.request
from datetime import date, datetime
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


ARTICLE_CACHE = SCRIPT_DIR / "output" / "articles"
CDX_EN = ("https://web.archive.org/cdx/search/cdx?url=en.zona.media/article/&matchType=prefix"
          "&fl=timestamp,original,statuscode&filter=original:.*casualties.*&limit=20000")
CDX_RU = ("https://web.archive.org/cdx/search/cdx?url=zona.media/casualties"
          "&fl=timestamp,original,statuscode&limit=20000")
EN_ARTICLE_RE = re.compile(r"https?://(?:www\.)?(en\.zona\.media/article/\d{4}/\d{2}/\d{2}/casualties_eng(?:-trl)?)/?")
ARTICLE_FIELDS = ["article_en", "article_en_captured", "article_ru", "article_ru_captured"]


def _get(url: str, tries: int = 4) -> bytes:
    """Wayback is slow and drops connections; retry with backoff."""
    for i in range(tries):
        try:
            return ingest._fetch(url)
        except Exception:  # noqa: BLE001
            if i == tries - 1:
                raise
            time.sleep(3 + 5 * i)
    raise AssertionError


def article_page(ts: str, url: str) -> str:
    """An archived article page, decoded (Wayback serves some captures still
    gzipped), cached in output/articles/."""
    path = ARTICLE_CACHE / f"{ts}_{hashlib.sha1(url.encode()).hexdigest()[:10]}.html"
    if not path.exists():
        raw = _get(f"https://web.archive.org/web/{ts}id_/{url}")
        if raw[:2] == b"\x1f\x8b":
            raw = gzip.decompress(raw)
        ARTICLE_CACHE.mkdir(parents=True, exist_ok=True)
        path.write_text(raw.decode("utf-8", errors="replace"), encoding="utf-8")
    return path.read_text(encoding="utf-8")


def article_captures() -> dict[str, list[tuple[str, str]]]:
    """Every clean 200 capture of the English and the Russian article."""
    en, ru = [], []
    for line in _get(CDX_EN).decode().splitlines():
        ts, url, status = line.split(" ")
        m = EN_ARTICLE_RE.fullmatch(url.split("?")[0])
        if m and status == "200":
            en.append((ts, "https://" + m.group(1)))
    for line in _get(CDX_RU).decode().splitlines():
        ts, url, status = line.split(" ")
        if status == "200":
            ru.append((ts, ingest.RU_ARTICLE_URL))
    return {"en": en, "ru": ru}


def match_article(bundle: str, captured: str, pool: list[tuple[str, str]]) -> tuple[str, str]:
    """The article capture that embeds `bundle`: of the five captures nearest
    the bundle's own (within three weeks), the first whose page names it."""
    when = datetime.strptime(captured, "%Y%m%d%H%M%S")
    near = sorted((abs((datetime.strptime(ts, "%Y%m%d%H%M%S") - when).total_seconds()), ts, url)
                  for ts, url in pool
                  if abs((datetime.strptime(ts, "%Y%m%d%H%M%S") - when).days) <= 21)
    token = bundle.split(".")[1]
    for _, ts, url in near[:5]:
        try:
            if token in article_page(ts, url):
                return url, ts
        except Exception as e:  # noqa: BLE001
            print(f"[discover] {url} @ {ts}: {e}", file=sys.stderr)
    return "", ""


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
    # Keep matches already made: only new bundles, or ones not matched yet,
    # cost Wayback fetches.
    known = {}
    if RELEASES.exists():
        with RELEASES.open(newline="") as f:
            known = {r["bundle"]: r for r in csv.DictReader(f)}
    pools = article_captures()
    rows = []
    for bundle, ts in sorted(first.items(), key=lambda x: x[1]):
        row = {"captured": ts, "bundle": bundle, **{k: (known.get(bundle) or {}).get(k, "") for k in ARTICLE_FIELDS}}
        for lang in ("en", "ru"):
            if not row[f"article_{lang}"]:
                row[f"article_{lang}"], row[f"article_{lang}_captured"] = match_article(bundle, ts, pools[lang])
        print(f"[discover] {bundle}: en {row['article_en_captured'] or '-'}, ru {row['article_ru_captured'] or '-'}")
        rows.append(row)
    with RELEASES.open("w", newline="") as f:
        w = csv.DictWriter(f, ["captured", "bundle", *ARTICLE_FIELDS], lineterminator="\n")
        w.writeheader()
        w.writerows(rows)
    print(f"[discover] {len(rows)} bundles, {sum(1 for r in rows if r['article_en'])} with the English "
          f"article, {sum(1 for r in rows if r['article_ru'])} with the Russian -> {RELEASES}")


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


def captured_ts(iso: str) -> str:
    """captured_iso's inverse: 2025-05-10T12:01:02+00:00 → 20250510120102."""
    return re.sub(r"\D", "", iso[:19])


def archive_url(ts: str, bundle: str) -> str:
    return f"https://web.archive.org/web/{ts}/{S3}{bundle}"


def fill_releases(db: Path, bundles: list[tuple[str, str, str]]) -> int:
    """Give every stored release version without a `releases` row one, after
    the fact. `bundles` = (published_at, scraped_at-form capture time, bundle)
    for every listed bundle.

    A backfilled version's scraped_at IS its bundle's capture time, so it
    matches exactly. One stored by the live ingest before `releases` existed
    (22/05/2026 →) has no record of its bundle; it gets the listed bundle with
    the same release date (±1 day — the first one came from a CSV export dated
    a day before its bundle), the last one captured by its ingest, and a note
    saying it was matched, not recorded. None found → source `unknown`.
    """
    if not db.exists():
        return 0
    bundles = [(p, captured_ts(cap), b) for p, cap, b in bundles]
    by_capture = {captured_iso(cap): (p, b) for p, cap, b in bundles}
    conn = sqlite3.connect(db)
    try:
        ingest.ensure_releases(conn)
        missing = conn.execute("""
            SELECT DISTINCT published_at, scraped_at FROM (
              SELECT published_at, scraped_at FROM weekly_roles
              UNION SELECT published_at, scraped_at FROM weekly_estimate)
            WHERE (published_at, scraped_at) NOT IN (SELECT published_at, scraped_at FROM releases)
            ORDER BY published_at, scraped_at""").fetchall()
        for pub, scraped in missing:
            if scraped in by_capture:
                b = by_capture[scraped][1]
                row = {"source": "wayback", "bundle_url": S3 + b,
                       "archive_url": archive_url(captured_ts(scraped), b),
                       "note": "filled in from releases.csv by capture time"}
            else:
                row = match_live(pub, scraped, bundles)
            conn.execute(
                f"INSERT INTO releases (published_at, scraped_at, {', '.join(ingest.RELEASE_COLS)}) "
                f"VALUES (?, ?, {', '.join('?' * len(ingest.RELEASE_COLS))})",
                [pub, scraped, *[row.get(c) for c in ingest.RELEASE_COLS]])
        conn.commit()
        return len(missing)
    except sqlite3.OperationalError:  # no weekly tables yet: nothing stored
        return 0
    finally:
        conn.close()


def match_live(pub: str, scraped: str, bundles: list[tuple[str, str, str]]) -> dict:
    """The `releases` row for a version the live ingest stored before the table
    existed: the listed bundle with its release date — the last one captured
    before that ingest, else the first captured after it (Wayback can lag the
    ingest by minutes). Only a bundle dated a day off → `unknown`, naming it:
    the first release (22/05/2026) came from CSV exports, a day before its
    bundle's date."""
    at = captured_ts(scraped)  # bundles carry Wayback timestamps

    def pick(cands):
        before = [c for c in cands if c[1] <= at]
        return max(before, key=lambda c: c[1]) if before else min(cands, key=lambda c: c[1])
    exact = [c for c in bundles if c[0] == pub]
    if exact:
        p, cap, b = pick(exact)
        return {"source": "live", "bundle_url": S3 + b, "archive_url": archive_url(cap, b),
                "note": "bundle matched by release date, not recorded at ingest"}
    near = [c for c in bundles if abs((date.fromisoformat(c[0]) - date.fromisoformat(pub)).days) == 1]
    if near:
        p, cap, b = pick(near)
        return {"source": "unknown", "bundle_url": S3 + b, "archive_url": archive_url(cap, b),
                "note": f"not recorded at ingest; probably this bundle (dated {p}), "
                        f"or the CSV exports it was published as"}
    return {"source": "unknown", "note": "not recorded at ingest; no listed bundle with this release date"}


def fill_articles(db: Path, listed: list[dict]) -> int:
    """Store the archived article pages `releases.csv` matched to each bundle
    (`articles`). Pages come from output/articles/ or Wayback. Skips page
    versions already stored."""
    if not db.exists():
        return 0
    conn = sqlite3.connect(db)
    added = 0
    try:
        conn.execute(ingest.ARTICLES_DDL)
        have = set(conn.execute("SELECT url, captured FROM articles").fetchall())
        for r in listed:
            for lang in ("en", "ru"):
                url, ts = r.get(f"article_{lang}"), r.get(f"article_{lang}_captured")
                if not url or (url, captured_iso(ts)) in have:
                    continue
                art = ingest.parse_article(article_page(ts, url), url, captured_iso(ts), "wayback")
                added += ingest.store_article(conn, art)
        conn.commit()
        return added
    finally:
        conn.close()


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
        r, e = ingest.build(out, roles, estimate, scraped_at, published_at, {
            "source": "wayback", "bundle_url": S3 + bundle,
            "archive_url": archive_url(captured_ts(scraped_at), bundle)})
        added.append({"published_at": published_at, "bundle": bundle,
                      "roles": r["new"] + r["revised"],
                      "estimate": e["new"] + e["revised"] + e["removed"] if estimate is not None else None})
        print(f"[backfill] {published_at} {bundle}: roles +{added[-1]['roles']}, "
              f"estimate {'+' + str(added[-1]['estimate']) if estimate is not None else '(none)'}")

    filled = fill_releases(out, [(p[0], p[1], p[4]) for p in parsed])
    with RELEASES.open(newline="") as f:
        articles = fill_articles(out, list(csv.DictReader(f)))
    skipped = len(parsed) - len(added)
    print(f"==> {len(added)} bundles backfilled, {skipped} at or after the oldest "
          f"stored release ({before}); {filled} releases rows filled in; "
          f"{articles} article pages stored; {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
