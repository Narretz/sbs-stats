#!/usr/bin/env python3
"""
discover.py — poll ssu.gov.ua for new SBU "Альфа" monthly recap articles and
ingest anything not already in the DB.

The SBU site has no RSS, no sitemap, and its search endpoint is JS-rendered
(returns an empty static HTML). The one usable discovery surface is the
paginated news listing at /novyny, which lists ~12 articles per page in plain
static HTML. This script fetches the first N pages, filters `/novyny/{slug}`
links by tokens shared across the known monthly-recap slugs, and hands each
new candidate off to ingest.store() via the existing browser-mimicking
fetcher.

Slug shape across the three known recaps (Mar/Apr/May 2026):
  alfa-sbu-top1-sered-pidrozdiliv-syl-oborony-ukrainy-tretii-misiats-pospil-video
  voiny-alfy-sbu-top1-sered-pidrozdiliv-syl-oborony-za-rezultatamy-boiovoi-roboty-u-kvitni-video
  alfa-sbu-top1-sered-pidrozdiliv-syl-oborony-ukrainy-za-kilkistiu-urazhenykh-tsilei-u-berezni-video

Common tokens: `alf[ay]` + `top1` + `sered-pidrozdiliv-syl-oborony`. Filter
matches all three. Candidates that don't parse as `monthly_top1` with a valid
`period` are logged but NOT stored, so a slug-shape drift never lands garbage
in the DB — surfaces as a warning for manual review.

No pip deps — reuses the fetch + parse + store from ingest.py.

Usage:
  python3 scripts/sbu_alfa/discover.py --out data/sbu-alfa.db
  python3 scripts/sbu_alfa/discover.py --out data/sbu-alfa.db --pages 5 --dry-run
"""
from __future__ import annotations

import argparse
import os
import re
import sqlite3
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import ingest  # noqa: E402
from parse import extract_text, parse  # noqa: E402

LISTING_URL = "https://ssu.gov.ua/novyny"

# Slug filter: tokens common to every known Alfa monthly-recap slug. Loose
# enough to survive minor wording changes ("alfa-sbu" ↔ "voiny-alfy-sbu"),
# strict enough to reject unrelated daily SBU news (which dominates /novyny).
# Any candidate is still parsed and gated on `report_type == 'monthly_top1'`
# before insertion, so a false-positive slug can't land garbage in the DB.
SLUG_FILTER = re.compile(
    r"/novyny/[a-z0-9-]*alf(?:a|y)[a-z0-9-]*top-?1[a-z0-9-]*sered-pidrozdiliv-syl-oborony[a-z0-9-]*",
    re.IGNORECASE,
)

_HREF_RE = re.compile(r'href=["\']((?:https?://ssu\.gov\.ua)?/novyny/[a-z0-9-]+)["\']')


def _abs(url: str) -> str:
    return url if url.startswith("http") else f"https://ssu.gov.ua{url}"


def scan_pages(pages: int) -> list[str]:
    """Fetch the first `pages` of /novyny and return matching absolute URLs
    (deduped, in first-seen order — pages are newest-first)."""
    seen: set[str] = set()
    out: list[str] = []
    for page in range(1, pages + 1):
        url = LISTING_URL if page == 1 else f"{LISTING_URL}?page={page}"
        try:
            _, raw = ingest._load(url)
        except Exception as e:
            print(f"[warn] page {page} fetch failed: {e!r}", file=sys.stderr)
            continue
        html = raw.decode("utf-8", "replace")
        candidates = [
            _abs(m.group(1)) for m in _HREF_RE.finditer(html)
            if SLUG_FILTER.search(m.group(1))
        ]
        new = [c for c in candidates if c not in seen]
        for c in new:
            seen.add(c)
            out.append(c)
        print(f"[scan] page {page}: {len(candidates)} candidate(s), {len(new)} new")
    return out


def known_urls(db_path: Path) -> set[str]:
    """URLs already stored (any version). Empty set if the DB doesn't exist yet."""
    if not db_path.exists():
        return set()
    conn = sqlite3.connect(db_path)
    try:
        rows = conn.execute("SELECT DISTINCT url FROM reports").fetchall()
    except sqlite3.OperationalError:
        # Fresh DB with no tables yet.
        return set()
    finally:
        conn.close()
    return {r[0] for r in rows}


def ingest_url(url: str, out: Path, dry_run: bool) -> str:
    """Fetch, parse, and (unless --dry-run) store one candidate article. Returns
    a short status string for the summary."""
    _, raw = ingest._load(url)
    body = extract_text(raw.decode("utf-8", "replace"))
    report = parse(body)
    title = ingest._extract_title(raw)
    published_at = ingest._extract_published_at(body)

    tag = f"period={report.period} type={report.report_type} counters={len(report.counters)}"
    if report.report_type != "monthly_top1" or not report.period:
        # Slug matched but content isn't a monthly recap — either a themed
        # article the slug filter mispicked, or the format has drifted. Do
        # NOT store it; surface for manual review.
        print(f"[skip] {url}\n       ({tag}) — not a monthly_top1 recap; needs manual review")
        return "skipped"

    if dry_run:
        print(f"[dry ] {url}\n       ({tag}) title={title!r}")
        return "dry-run"

    status = ingest.store(out, url, raw, report, title, published_at, None)
    print(f"[{status:>8}] {url}\n       ({tag}) title={title!r}")
    return status


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, default=ingest.DEFAULT_DB,
                    help=f"DB path (default: {ingest.DEFAULT_DB})")
    ap.add_argument("--pages", type=int, default=3,
                    help="How many /novyny pages to scan (default: 3, covers ~2 days of SBU news)")
    ap.add_argument("--dry-run", action="store_true",
                    help="Report what would be ingested without writing.")
    args = ap.parse_args(argv)

    urls = scan_pages(args.pages)
    seen = known_urls(args.out)
    new_urls = [u for u in urls if u not in seen]
    print(f"\n[summary] {len(urls)} candidate URL(s) across {args.pages} page(s); "
          f"{len(new_urls)} not yet in DB")

    counters = {"inserted": 0, "updated": 0, "unchanged": 0, "skipped": 0, "dry-run": 0}
    for u in new_urls:
        try:
            status = ingest_url(u, args.out, args.dry_run)
        except Exception as e:
            print(f"[error] {u}: {e!r}")
            counters["skipped"] += 1
            continue
        counters[status] = counters.get(status, 0) + 1
    if new_urls:
        print(f"\n[done] {counters}")

    # Signal to a GitHub Actions caller whether the DB actually changed, so
    # the workflow can skip the R2 upload on no-op runs. SBU Alfa publishes
    # ~once/month while the workflow runs ~16×/month, so ≥94% of runs are
    # no-ops — worth guarding here even though we don't guard the other
    # workflows (their DBs change every run). Always emit the marker (even
    # when no new URLs were found) so the workflow step's outputs are
    # deterministic regardless of scan result.
    changed = counters["inserted"] + counters["updated"] > 0
    gh_out = os.environ.get("GITHUB_OUTPUT")
    if gh_out:
        with open(gh_out, "a", encoding="utf-8") as f:
            f.write(f"changed={'true' if changed else 'false'}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
