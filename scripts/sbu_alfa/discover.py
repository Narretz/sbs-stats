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

Slug shapes of the known recaps (Mar 2026 – Oct 2026):
  alfa-sbu-top1-sered-pidrozdiliv-syl-oborony-ukrainy-tretii-misiats-pospil-video
  voiny-alfy-sbu-top1-sered-pidrozdiliv-syl-oborony-za-rezultatamy-boiovoi-roboty-u-kvitni-video
  alfa-sbu-top1-sered-pidrozdiliv-syl-oborony-ukrainy-za-kilkistiu-urazhenykh-tsilei-u-berezni-video
  visim-misiatsiv-liderstva-alfy-sbu-top1-sered-syl-oborony-video   (October, no "pidrozdiliv")

Common tokens: `alf[ay]` + `top1` + `syl-oborony`. The filter asks for
`alf[ay]` and either of the other two, with the rank optional (`top`, `top3`):
the unit has been TOP-1 every month so far, and a month it isn't, the recap
would still be published — just not under "top1". The filter is the loose
half; the gate behind it is the strict one: a candidate is stored only if it
parses as `monthly_top1` with a valid `period` AND at least MIN_COUNTERS
counters (every recap so far: 13–18), so an ordinary Alfa story that names a
month can't pass for a recap. Anything gated out is logged for manual review.

No pip deps — reuses the fetch + parse + store from ingest.py.

Usage:
  python3 scripts/sbu_alfa/discover.py --out data/sbu-alfa.db
  python3 scripts/sbu_alfa/discover.py --out data/sbu-alfa.db --pages 5 --dry-run
"""
from __future__ import annotations

import argparse
import re
import sqlite3
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import ingest  # noqa: E402
from ingest_log import ann  # noqa: E402
from parse import extract_text, parse  # noqa: E402

# With the trailing slash: since Nov 2026 Akamai 403s `/novyny` itself (and
# `/novyny?page=N`, `/en/novyny`), while `/novyny/` and `/novyny/?page=N` serve
# the same listing. Article pages were never affected.
LISTING_URL = "https://ssu.gov.ua/novyny/"

# Slug filter: "alfa"/"alfy" plus either the ranking ("top", any or no rank
# number) or "syl-oborony" ("of the Defence Forces"). Loose enough to survive
# wording drift ("alfa-sbu" ↔ "voiny-alfy-sbu", "sered-pidrozdiliv-syl-oborony"
# ↔ "sered-syl-oborony") and a month the unit isn't TOP-1, strict enough to
# reject the daily SBU news that dominates /novyny. Every candidate still goes
# through the gate in ingest_url before anything is stored.
SLUG_FILTER = re.compile(
    r"/novyny/(?=[a-z0-9-]*alf(?:a|y))(?=[a-z0-9-]*(?:top-?\d*(?![a-z])|syl-oborony))[a-z0-9-]+",
    re.IGNORECASE,
)

# Fewest parsed counters a monthly recap is believed to have. Every recap so
# far listed 13–18; an ordinary article that happens to name a month and a
# figure or two stays well below.
MIN_COUNTERS = 8

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
            # A warning, not a print: a blocked listing otherwise reads as a
            # quiet "0 candidates" run.
            ingest.log.warning(
                "listing page %d (%s) fetch failed: %r", page, url, e,
                extra=ann(title="sbu-alfa: listing fetch failed"),
            )
            continue
        html = raw.decode("utf-8", "replace")
        candidates = [
            _abs(m.group(1)) for m in _HREF_RE.finditer(html)
            if SLUG_FILTER.search(m.group(1))
        ]
        # Dedupe within the page as well as across pages: the same article on
        # /novyny is linked twice per card (image + title), so a naive
        # `if c not in seen` before updating `seen` would yield both copies.
        new: list[str] = []
        for c in candidates:
            if c in seen:
                continue
            seen.add(c)
            new.append(c)
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
    # Counter line(s) the parser didn't recognise — a new/renamed category or
    # wording drift. We still store what we DID parse (the recognised counters
    # are correct); the warning goes through ingest_log, so in CI it surfaces
    # as a GitHub annotation rather than a buried stderr line.
    ingest.warn_unmatched(url, report)
    if report.report_type != "monthly_top1" or not report.period or len(report.counters) < MIN_COUNTERS:
        # Slug matched but content isn't a monthly recap — either a themed
        # article the slug filter mispicked, or the format has drifted. Do
        # NOT store it; surface for manual review — as a notice, since a
        # mispicked news story is the common case and needs no action.
        ingest.log.warning(
            "%s (%s) — not a monthly recap; skipped, needs manual review if it is one", url, tag,
            extra=ann(level="notice", title="sbu-alfa: discovery candidate skipped"),
        )
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

    # Signal to the workflow whether the DB actually changed, so it can skip
    # the R2 upload on a no-op run. Shared with the reparse path, which has the
    # same need — see ingest._emit_changed for why it's worth guarding here.
    ingest._emit_changed(counters["inserted"] + counters["updated"] > 0)
    return 0


if __name__ == "__main__":
    sys.exit(main())
