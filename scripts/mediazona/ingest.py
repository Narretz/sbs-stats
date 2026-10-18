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
import statistics
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

# A healthy export has a row for (nearly) every week of the war up to its
# release; one with fewer than half of them is truncated. Scaled to the release
# date because a backfilled 2023 release covers barely a year (55 weeks).
MAX_DROPPED_WEEKS = 2

# `releases` — where each stored release version came from, keyed like the
# weekly rows by (published_at, scraped_at). `source`: `live` (the article, by
# ingest.py), `wayback` (a past bundle, by backfill.py; scraped_at is then its
# capture time) or `csv` (local exports). `archive_url` is the Wayback capture;
# `note` says when a row was filled in after the fact rather than recorded. The
# article pages it came in are in `articles`, by `bundle_url`.
RELEASE_COLS = ["source", "bundle_url", "archive_url", "note"]
# `articles` — the article pages a release was published in: the English one
# (dated per release since 28/03/2025, before that one page updated in place)
# and the Russian zona.media/casualties (updated in place throughout). One row
# per page version (url, captured): a Wayback capture, or the live fetch of a
# run that stored a release; `archive_url` is the Wayback capture (none for a
# live fetch). Linked to `releases` by `bundle_url`, the chart
# bundle the page embeds. `headline` is the page's og:description ("Over 5 801
# deaths confirmed by August 25"), with its date and count parsed out;
# `list_updated` / `estimate_updated` the "Last update to the named list / to
# the Probate Registry estimate" lines (2025 →); `text` the visible article
# text; `html` the whole page, zlib-compressed.
ARTICLES_DDL = """CREATE TABLE IF NOT EXISTS articles (
    url TEXT NOT NULL,
    captured TEXT NOT NULL,
    source TEXT NOT NULL,
    lang TEXT NOT NULL,
    archive_url TEXT,
    bundle_url TEXT,
    url_date TEXT,
    headline TEXT,
    headline_date TEXT,
    headline_count INTEGER,
    list_updated TEXT,
    estimate_updated TEXT,
    title TEXT,
    text TEXT,
    html BLOB NOT NULL,
    PRIMARY KEY (url, captured)
);"""
ARTICLE_COLS = ["source", "lang", "archive_url", "bundle_url", "url_date", "headline", "headline_date",
                "headline_count", "list_updated", "estimate_updated", "title", "text", "html"]
RU_ARTICLE_URL = "https://zona.media/casualties"

_MONTHS = {m: i + 1 for i, m in enumerate(
    "january february march april may june july august september october november december".split())}
_MONTHS.update({m: i + 1 for i, m in enumerate(
    "января февраля марта апреля мая июня июля августа сентября октября ноября декабря".split())})
_MONTH_RE = "|".join(_MONTHS)


def _date_in(text: str, before: str) -> str | None:
    """The first date in `text` — "October 9, 2026", "9 октября 2026 года",
    or one without a year ("August 25", "6 мая"), which gets the latest year
    that puts it on or before `before` (an ISO date)."""
    t = text.lower()
    found = [m for m in (re.search(rf"\b({_MONTH_RE}) (\d{{1,2}})(?!\d)(?:,? (\d{{4}}))?", t),
                         re.search(rf"\b(\d{{1,2}}) ({_MONTH_RE})(?: (\d{{4}}))?", t)) if m]
    if not found:
        return None
    m = min(found, key=lambda m: m.start())
    a, b, year = m.groups()
    month, day = (_MONTHS[a], int(b)) if a in _MONTHS else (_MONTHS[b], int(a))
    limit = date_cls.fromisoformat(before[:10])
    try:
        if year:
            return date_cls(int(year), month, day).isoformat()
        d = date_cls(limit.year, month, day)
        return (d if d <= limit + timedelta(days=1) else date_cls(limit.year - 1, month, day)).isoformat()
    except ValueError:
        return None


def _count_in(text: str) -> int | None:
    """The headline's count: "5 801", "2099", "135,100", or "5,8 тысяч" (5,800)."""
    m = re.search(r"(\d[\d\s\u00a0\u202f,.]*\d|\d)\s*(тысяч|thousand)?", text)
    if not m:
        return None
    num, thousands = m.group(1), m.group(2)
    if thousands:
        return round(float(re.sub(r"[\s\u00a0\u202f]", "", num).replace(",", ".")) * 1000)
    return int(re.sub(r"\D", "", num))


def parse_article(page: str, url: str, captured: str, source: str,
                  archive_url: str | None = None) -> dict:
    """One article page → an `articles` row (as a dict, `html` compressed)."""
    import html as htmlmod
    import zlib

    def meta(name: str) -> str | None:
        m = re.search(rf'<meta (?:property|name)="{name}" content="([^"]*)"', page)
        return htmlmod.unescape(m.group(1)).strip() if m else None

    bundle = re.search(r"(https://s3\.zona\.media/infographics/bodycount/main\.[a-f0-9]+\.js(?:\.gz|\.br)?)", page)
    start, end = page.find("<h1"), page.find("<footer")
    body = page[start if start >= 0 else 0: end if end > start else len(page)]
    body = re.sub(r"<(script|style|svg)\b.*?</\1>", " ", body, flags=re.S)
    text = re.sub(r"[ \t]+", " ", htmlmod.unescape(re.sub(r"<[^>]+>", " ", re.sub(r"</(p|div|h\d|li)>|<br\s*/?>", "\n", body))))
    text = re.sub(r"\s*\n\s*", "\n", text).strip()
    flat = re.sub(r"\s+", " ", text)
    headline = meta("og:description") or meta("description")
    url_date = re.search(r"/article/(\d{4})/(\d{2})/(\d{2})/", url)
    lu = re.search(r"(?:Last update to the named list|Последнее обновление списка погибших):?\s*([^.]{0,40})", flat)
    eu = re.search(r"(?:Last update to the Probate Registry estimate|Последнее обновление оценки общего числа погибших):?\s*([^.;]{0,40})", flat)
    return {
        "url": url, "captured": captured, "source": source,
        "lang": "ru" if "//zona.media" in url else "en",
        "archive_url": archive_url,
        "bundle_url": bundle.group(1) if bundle else None,
        "url_date": "-".join(url_date.groups()) if url_date else None,
        "headline": headline,
        "headline_date": _date_in(headline, captured) if headline else None,
        "headline_count": _count_in(headline) if headline else None,
        "list_updated": _date_in(lu.group(1), captured) if lu else None,
        "estimate_updated": _date_in(eu.group(1), captured) if eu else None,
        "title": meta("og:title"),
        "text": text,
        "html": zlib.compress(page.encode("utf-8"), 9),
    }


def ensure_articles(conn: sqlite3.Connection) -> None:
    """Create `articles`, or add `archive_url` to one built before it had it."""
    conn.execute(ARTICLES_DDL)
    if "archive_url" not in [r[1] for r in conn.execute("PRAGMA table_info(articles)")]:
        conn.execute("ALTER TABLE articles ADD COLUMN archive_url TEXT")


def store_article(conn: sqlite3.Connection, art: dict) -> bool:
    """Insert one `articles` row unless that page version is stored. True if new."""
    ensure_articles(conn)
    cur = conn.execute(
        f"INSERT OR IGNORE INTO articles (url, captured, {', '.join(ARTICLE_COLS)}) "
        f"VALUES (?, ?, {', '.join('?' * len(ARTICLE_COLS))})",
        [art["url"], art["captured"], *[art[c] for c in ARTICLE_COLS]])
    return cur.rowcount == 1


RELEASES_DDL = """CREATE TABLE IF NOT EXISTS releases (
    published_at TEXT NOT NULL,
    scraped_at TEXT NOT NULL,
    source TEXT NOT NULL,
    bundle_url TEXT,
    archive_url TEXT,
    note TEXT,
    PRIMARY KEY (published_at, scraped_at)
);"""


def ensure_releases(conn: sqlite3.Connection) -> None:
    """Create `releases`, or bring an older one up to date: until 18/10/2026 it
    had an `article_url`, which the `articles` table now holds."""
    conn.execute(RELEASES_DDL)
    if "article_url" in [r[1] for r in conn.execute("PRAGMA table_info(releases)")]:
        conn.execute("ALTER TABLE releases DROP COLUMN article_url")


def min_rows(published_at: str) -> int:
    days = (date_cls.fromisoformat(published_at) - date_cls(2022, 2, 24)).days
    return days // 14

# ── Article-fetch mode (--from-article) ───────────────────────────────────────
# Mediazona republishes the same casualty count under a new date-coded URL
# every ~2 weeks. The URL below is a known release; if Mediazona rotates it,
# they have historically kept old URLs alive (and the new release just lives
# at a fresher path), so the workflow should be re-pointed when that changes.
DEFAULT_ARTICLE_URL = "https://en.zona.media/article/2026/08/14/casualties_eng-trl"

# Week-1 anchor for the roles series — same as the CSV's `week_start` anchor.
WAR_START = date_cls(2022, 2, 24)

# Blob 5 inside the bundle keys per-day deaths by role index '0'..'N-1' (see
# _find_roles_blob for the two encodings it has shipped in). Indices 0..15
# follow the chart's display order; 16..20 are a slightly different ordering of
# the last 5 cells than our CSV layout. Verified by matching blob 5's per-index
# sums against blob 3's per-Russian-name totals (see _check_blob5_drift below);
# re-verified against blob 3 and against the stored weeks after the Aug-2026
# re-encoding, which left the index order intact. If upstream re-shuffles, the
# drift check fires and the build aborts.
BLOB5_COLUMN_MAP = [
    "nguard", "rifle", "air", "pilot", "seaman", "marine",
    "tank", "art", "eng", "other", "nd", "special",
    "vol", "mob", "signal", "airdef",
    "groundavia", "pmc", "fsb", "chem", "inmates",
]

# Releases from Mar 2023 to 06/12/2024 carry 20 roles: "ground aviation
# services" didn't exist yet (its people sat under `other`), the rest in the
# same order. Selected by the blob's role count; `groundavia` is 0 there.
BLOB5_COLUMN_MAP_20 = [c for c in BLOB5_COLUMN_MAP if c != "groundavia"]

# Each role's category in the summary blob, which `_check_blob5_drift` holds
# the roles blob to. `other` is "другие войска" plus every "(другие войска)"
# subcategory not listed here. The names have been identical in every release
# since Mar 2023.
SUMMARY_NAMES = {
    "nguard": "нацгвардия", "rifle": "мотострелковые войска", "air": "ВДВ",
    "pilot": "военные пилоты", "seaman": "моряки", "marine": "морпехи",
    "tank": "танковые войска", "art": "артиллерия", "eng": "инженерные войска",
    "nd": "нет данных", "special": "спецназ", "vol": "добровольцы",
    "mob": "мобилизованные", "signal": "войска связи (другие войска)",
    "airdef": "войсковая ПВО (другие войска)",
    "groundavia": "наземные авиаслужбы (другие войска)", "pmc": "ЧВК",
    "fsb": "ФСБ (другие войска)", "chem": "РХБЗ (другие войска)",
    "inmates": "заключенные",
}


def column_map(daily: dict[str, list[int]]) -> list[str]:
    """The role-column order for a roles blob, by its number of roles."""
    for cmap in (BLOB5_COLUMN_MAP, BLOB5_COLUMN_MAP_20):
        if len(daily) == len(cmap):
            return cmap
    raise RuntimeError(
        f"roles blob has {len(daily)} roles; known layouts have "
        f"{len(BLOB5_COLUMN_MAP)} or {len(BLOB5_COLUMN_MAP_20)} — re-validate "
        f"the column mapping.")


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


# Cloudflare in front of en.zona.media 403s bare urllib and also custom UA
# hints like "(sbs-stats-ingest)"; use a full browser-shaped UA.
_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
}


def _fetch(url: str) -> bytes:
    return _fetch_final(url)[0]


def _fetch_final(url: str) -> tuple[bytes, str]:
    """`_fetch`, plus the URL it ended up at after redirects: the dated article
    URL the workflow points at redirects to the current release's."""
    req = urllib.request.Request(url, headers=_HEADERS)
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read(), r.geturl()


def fetch_bundle(article_url: str) -> tuple[str, dict]:
    """Resolve the bodycount JS bundle URL from the article HTML and return
    its decoded source, plus its provenance for the `releases` table: the
    article URL after redirects and the bundle URL.

    The article HTML embeds the bundle via a hashed S3 path
    (`.../main.<hash>.js.<gz|br>`); the hash changes with each release, so we
    discover it dynamically. Historically the .gz variant was served with the
    raw compressed body regardless of Accept-Encoding, so we decompressed on
    the gzip magic bytes. As of mid-2026 Mediazona ships a .br variant and
    Cloudflare transparently decompresses it server-side when we don't send
    `Accept-Encoding: br` — so the response is already plain JS. Detect
    either case: decompress iff the payload looks compressed.
    """
    raw_html, final_url = _fetch_final(article_url)
    html = raw_html.decode("utf-8", errors="replace")
    m = re.search(
        r'(https://s3\.zona\.media/infographics/bodycount/main\.[a-f0-9]+\.js\.(?:gz|br))',
        html,
    )
    if not m:
        raise RuntimeError(f"no bodycount bundle URL found in {article_url}")
    bundle_url = m.group(1)
    print(f"[fetch] article {final_url}\n         -> bundle {bundle_url}")
    raw = _fetch(bundle_url)
    if raw[:2] == b"\x1f\x8b":  # gzip magic
        raw = gzip.decompress(raw)
    return raw.decode("utf-8"), {"source": "live", "article_url": final_url,
                                 "bundle_url": bundle_url, "article_html": html}


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


def _decode_rle(seq: list[int], n_days: int) -> list[int]:
    """Expand one sparse day series to `n_days` per-day counts.

    Mediazona's wrapped encoding stores a non-negative value as that day's
    count and a negative value `-n` as a run of `n` zero days. Every series in
    the bundle expands to exactly `days` entries, so a length mismatch means
    the encoding — not just the wrapper — changed, and we abort.
    """
    out: list[int] = []
    for x in seq:
        if not isinstance(x, int):
            raise RuntimeError(f"non-int value {x!r} in a roles day series")
        if x < 0:
            out.extend([0] * -x)
        else:
            out.append(x)
    if len(out) != n_days:
        raise RuntimeError(
            f"roles day series expands to {len(out)} days, expected {n_days}")
    return out


def _roles_from_wrapped(b: dict) -> dict[str, list[int]]:
    """Flatten the wrapped roles blob into the flat per-role day series.

    Since the Aug-2026 release each role's value is a *list* of run-length-
    encoded series, one per entry in the blob's `years` — a cohort breakdown by
    the year each death was identified (each cohort is still bucketed by date of
    death, so it spans the whole war but stops at that year's end). The cohorts
    partition the dataset rather than nesting, so their elementwise sum is the
    all-time daily series the flat encoding used to carry: summing reproduces
    both the summary blob's per-category totals and the previously stored weeks.
    """
    n_days, years = b["days"], b["years"]
    daily: dict[str, list[int]] = {}
    for k, cohorts in b["dates"].items():
        if len(cohorts) != len(years):
            raise RuntimeError(
                f"roles index {k} has {len(cohorts)} cohorts but the blob "
                f"declares {len(years)} years — re-validate the roles blob.")
        expanded = [_decode_rle(c, n_days) for c in cohorts]
        daily[k] = [sum(day) for day in zip(*expanded)]
    return daily


def _find_roles_blob(blobs: list[object]) -> dict[str, list[int]]:
    """Roles daily series, normalised to {role index: [per-day deaths]}.

    Two encodings have shipped. Up to Aug 2026 the blob was flat — a dict of
    equal-length int lists, one per role. The Aug-2026 bundle wraps it as
    `{years: [...], days: N, dates: {index: [cohort series, ...]}}` with the
    day series run-length encoded (see `_roles_from_wrapped`). Accept either.
    """
    for b in blobs:
        if not isinstance(b, dict):
            continue
        if (len(b) >= 10
                and all(isinstance(v, list) for v in b.values())
                and len(set(len(v) for v in b.values())) == 1
                and all(isinstance(x, int) for x in next(iter(b.values()))[:20])):
            return b
        if (isinstance(b.get("days"), int) and isinstance(b.get("years"), list)
                and isinstance(b.get("dates"), dict) and len(b["dates"]) >= 10
                and all(isinstance(v, list) and v and all(isinstance(c, list) for c in v)
                        for v in b["dates"].values())):
            return _roles_from_wrapped(b)
    raise RuntimeError(
        "no roles blob (flat dict of equal-length int lists, or a "
        "{years, days, dates} wrapper) in bundle")


def _find_roles_summary_blob(blobs: list[object]) -> list[dict]:
    """Per-category summary: list of {k:str, o:int, v:int}. Cross-validates
    blob 5 in _check_blob5_drift."""
    for b in blobs:
        if (isinstance(b, list) and b and isinstance(b[0], dict)
                and set(b[0]) == {"k", "o", "v"}):
            return b
    raise RuntimeError("no roles-summary blob ({k,o,v} list) in bundle")


def _summary_name(k: str) -> str:
    """A summary category name as Russian text. `_extract_json_blobs` reads the
    bundle's raw UTF-8 as Latin-1 (`unicode_escape`), so the names arrive as
    mojibake; undo that, and leave an already-clean name alone."""
    try:
        return k.encode("latin-1").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return k


def _check_blob5_drift(daily: dict[str, list[int]], summary: list[dict]) -> None:
    """Guard: hold each role's all-time sum to its own category in the summary
    blob, matched by name (`SUMMARY_NAMES`). If they disagree, the column
    taxonomy or ordering drifted and the column map is no longer trustworthy —
    abort rather than write a silently-shuffled dataset.

    The roles blob counts only deaths with a known date, the summary every
    name, so a role is compared to its summary total times the release's
    *dated share* — the median of the per-role ratios. That share has risen
    from ~0.82 (2023) to ~0.97 (2026); a fixed tolerance against the raw
    totals rejected every release before 2026. Per-role ratios to the median
    stay within 0.74–1.14 across every release since Mar 2023, except `nd`
    ("нет данных"), whose undated share is larger (0.64–0.86); a shuffled
    column lands far outside either band. Roles under 100 in the summary are
    too small for a ratio and are held to an absolute margin instead.
    """
    cmap = column_map(daily)
    totals = {_summary_name(r["k"]): r["v"] for r in summary}
    named = {SUMMARY_NAMES[c] for c in cmap if c in SUMMARY_NAMES}
    missing = sorted(named - totals.keys())
    if missing:
        raise RuntimeError(
            f"summary blob lacks the categories {missing} — the role taxonomy "
            f"changed upstream; re-validate the column map and SUMMARY_NAMES.")
    expected = {c: totals[SUMMARY_NAMES[c]] for c in cmap if c in SUMMARY_NAMES}
    expected["other"] = sum(v for k, v in totals.items() if k not in named)
    sums = {c: sum(daily[k]) for c, k in zip(cmap, sorted(daily, key=int))}
    share = statistics.median(
        sums[c] / expected[c] for c in cmap if expected[c] >= 100)

    misses = []
    for c in cmap:
        want = share * expected[c]
        if expected[c] < 100:
            ok = abs(sums[c] - want) <= 40
        else:
            lo, hi = (0.5, 1.1) if c == "nd" else (0.65, 1.35)
            ok = lo <= sums[c] / want <= hi
        if not ok:
            misses.append((c, sums[c], expected[c]))
    if misses:
        raise RuntimeError(
            f"roles blob / summary drift: {len(misses)} roles off their summary "
            f"category at a dated share of {share:.2f} ({misses}). The role "
            f"taxonomy or ordering changed upstream — re-validate the column "
            f"map before re-running.")
    print(f"[check] roles match the summary by name; dated share {share:.2f}")


def _aggregate_roles_blob_to_rows(daily: dict[str, list[int]]) -> list[tuple]:
    """Daily per-role → tuples in the shape `parse_roles()` would produce —
    `(week_iso, *ROLE_COLS values)`, Thursday-anchored from 2022-02-24. A role
    the release's layout lacks (`groundavia` before 12/2024) is 0."""
    cmap = column_map(daily)
    keys = sorted(daily.keys(), key=int)
    n_days = len(next(iter(daily.values())))
    rows: list[tuple] = []
    for wi in range(0, n_days, 7):
        wend = min(wi + 7, n_days)
        per_col = {col: sum(daily[k][wi:wend]) for col, k in zip(cmap, keys)}
        per_col["total"] = sum(per_col.values())
        week_iso = (WAR_START + timedelta(days=wi)).isoformat()
        rows.append((week_iso, *[per_col.get(c, 0) for c in ROLE_COLS]))
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


def _published_at(estimate_blob: list[dict] | None, n_days: int) -> str:
    """The release date: the estimate blob's `current_date` metadata row (DD.MM.YYYY
    in its `real` field), checked against the roles series, which runs from the
    war's start to the release day — `WAR_START + n_days` matches `current_date`
    to within a day on every release that has both.

    The series wins when they disagree by more, and is the only source before
    Apr 2024, when there was no metadata row (nor, before 24/02/2024, an
    estimate blob). A disagreement is a bundle rebuilt mid-cycle: Mediazona
    sometimes extends the data without touching `current_date` (13/05/2025
    shipped data to 10/05 under the 25/04 date), and taking the stale date
    would order that newer version before the release it follows.
    """
    derived = (WAR_START + timedelta(days=n_days)).isoformat()
    meta = next((iso(r["real"]) for r in estimate_blob or []
                 if r.get("w") == "current_date"), None)
    if meta is None:
        return derived
    gap = abs((date_cls.fromisoformat(meta) - date_cls.fromisoformat(derived)).days)
    if gap <= 1:
        return meta
    print(f"[warn] bundle dated {meta} carries data to {derived}; using {derived}",
          file=sys.stderr)
    return derived


def parse_bundle(bundle: str) -> tuple[list[tuple], list[tuple] | None, str]:
    """A bundle's source → (roles_rows, estimate_rows, published_at_iso).

    `roles_rows` and `estimate_rows` are in the same shape as `parse_roles()`
    and `parse_estimate()` return, so they drop straight into build().
    `estimate_rows` is None for a release from before the probate estimate
    (24/02/2024).
    """
    blobs = _extract_json_blobs(bundle)
    try:
        estimate_blob = _find_estimate_blob(blobs)
    except RuntimeError:
        estimate_blob = None
    roles_blob = _find_roles_blob(blobs)
    summary_blob = _find_roles_summary_blob(blobs)
    n_days = len(next(iter(roles_blob.values())))
    print(f"[parse] {len(blobs)} JSON blobs; roles={len(roles_blob)} cats × "
          f"{n_days} days; estimate="
          f"{len(estimate_blob) if estimate_blob else 'none'} rows; "
          f"summary={len(summary_blob)} cats")
    _check_blob5_drift(roles_blob, summary_blob)
    return (
        _aggregate_roles_blob_to_rows(roles_blob),
        _estimate_blob_to_rows(estimate_blob) if estimate_blob else None,
        _published_at(estimate_blob, n_days),
    )


def fetch_from_article(article_url: str) -> tuple[list[tuple], list[tuple], str, dict]:
    """End-to-end: article URL → (roles_rows, estimate_rows, published_at_iso,
    provenance). The live article always carries the estimate; a bundle without
    one is broken."""
    bundle, provenance = fetch_bundle(article_url)
    roles, estimate, published_at = parse_bundle(bundle)
    if estimate is None:
        raise RuntimeError(f"no probate-estimate blob in {article_url}'s bundle")
    return roles, estimate, published_at, provenance


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


def latest_per_week(table: str, as_of: tuple[str, str] | None = None) -> str:
    """SQL for the latest version of every week in `table`: the one from the
    newest release (`published_at`), then the newest ingest (`scraped_at`) —
    a release rebuilt mid-cycle, or a parser fix re-reading the same release.
    Ordered by release rather than by ingest because releases are not ingested
    in order: `backfill.py` adds old ones after newer ones are stored.

    `as_of` = (published_at, scraped_at) limits it to the versions up to and
    including that point, for comparing a release with the one before it.
    """
    where = "WHERE (published_at, scraped_at) <= (?, ?)" if as_of else ""
    return f"""(
      SELECT * FROM (
        SELECT d.*, ROW_NUMBER() OVER (
          PARTITION BY week ORDER BY published_at DESC, scraped_at DESC) AS rn
        FROM {table} d {where}
      ) WHERE rn = 1
    )"""


def build(
    db_path: Path,
    roles: list[tuple],
    estimate: list[tuple] | None,
    scraped_at: str,
    published_at: str,
    provenance: dict | None = None,
) -> tuple[dict, dict]:
    """Append changed/new week-versions into db_path. Never mutates/deletes rows.

    A run that stores anything also records where it came from in `releases`
    (one row per stored (published_at, scraped_at)): `provenance` gives the
    `source` and URLs, as `RELEASE_COLS` names them.

    A week's values are compared with its latest version *as of this release*
    — so a release older than what is stored (a backfill) is compared with the
    release before it, not with a newer one. `estimate` is None for a release
    from before the probate estimate existed; that table is then left alone.

    Returns (roles_summary, estimate_summary), each a dict with:
        new       — count of weeks not in DB before this run
        revised   — count of pre-existing weeks whose values differ from prior
        unchanged — count of pre-existing weeks whose values match prior (skipped)
        distinct  — total distinct weeks in the table after the run
        removed   — (estimate only) weeks the release no longer has, each stored
                    as an empty row
    new + revised (+ removed) = number of rows actually inserted. Aborts (raises) without
    writing if either payload looks broken or would shrink an existing dataset.
    """
    # Guard 1: a floor of half the war's weeks at the release.
    floor = min_rows(published_at)
    if len(roles) < floor:
        raise RuntimeError(
            f"roles CSV parsed only {len(roles)} weeks (< floor {floor}) — "
            f"refusing to write {db_path}; the export is probably truncated."
        )
    if estimate is not None and len(estimate) < floor:
        raise RuntimeError(
            f"estimate CSV parsed only {len(estimate)} weeks (< floor {floor}) — "
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

        ensure_releases(conn)

        # Latest stored version per week as of this release, for change
        # detection. Mirrors ru_losses' LATEST_PER_DATE pattern.
        as_of = (published_at, scraped_at)
        role_metric_cols = ", ".join(ROLE_COLS)
        latest_roles = {
            r[0]: tuple(r[1:])
            for r in conn.execute(
                f"SELECT week, {role_metric_cols} FROM {latest_per_week('weekly_roles', as_of)}",
                as_of,
            ).fetchall()
        }
        latest_estimate = {
            r[0]: (r[1], r[2])
            for r in conn.execute(
                f"SELECT week, documented, estimate FROM {latest_per_week('weekly_estimate', as_of)}",
                as_of,
            ).fetchall()
        }

        # Guard 2: shrink — a new export should never have fewer distinct weeks
        # than what's already stored. Catches a half-empty CSV that passed Guard 1.
        if len(roles) < len(latest_roles):
            raise RuntimeError(
                f"parsed {len(roles)} role-weeks but DB already has {len(latest_roles)} — "
                f"refusing to write a shrinking dataset into {db_path}."
            )
        # The estimate may lose a week or two: the 24/04/2026 release dropped
        # its trailing partial week (2025-08-18), which the release before had
        # shown. More than that is a broken export.
        live_estimate = {w for w, v in latest_estimate.items() if v != (None, None)}
        if estimate is not None and len(estimate) < len(live_estimate) - MAX_DROPPED_WEEKS:
            raise RuntimeError(
                f"parsed {len(estimate)} estimate-weeks but DB already has "
                f"{len(live_estimate)} — refusing to write a shrinking dataset."
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
        for week, documented, estimate_val in estimate or []:
            prior = latest_estimate.get(week)
            if prior is None:
                est_new += 1
                estimate_to_insert.append([week, scraped_at, published_at, documented, estimate_val])
            elif prior != (documented, estimate_val):
                est_revised += 1
                estimate_to_insert.append([week, scraped_at, published_at, documented, estimate_val])
            else:
                est_unchanged += 1
        # A week the release no longer has gets an empty row, so the latest
        # version of it is "gone" rather than the last release that showed it.
        # The frontend skips empty rows.
        est_removed = 0
        if estimate is not None:
            for week in sorted(live_estimate - {w for w, *_ in estimate}):
                est_removed += 1
                estimate_to_insert.append([week, scraped_at, published_at, None, None])

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
            prov = provenance or {"source": "csv"}
            conn.execute(
                f"INSERT OR REPLACE INTO releases (published_at, scraped_at, {', '.join(RELEASE_COLS)}) "
                f"VALUES (?, ?, {', '.join('?' * len(RELEASE_COLS))})",
                [published_at, scraped_at, *[prov.get(c) for c in RELEASE_COLS]],
            )
            conn.commit()
            conn.execute("VACUUM")
            conn.commit()

        roles_distinct = conn.execute("SELECT COUNT(DISTINCT week) FROM weekly_roles").fetchone()[0]
        est_distinct = conn.execute("SELECT COUNT(DISTINCT week) FROM weekly_estimate").fetchone()[0]
    finally:
        conn.close()
    return (
        {"new": roles_new, "revised": roles_revised, "unchanged": roles_unchanged, "distinct": roles_distinct},
        {"new": est_new, "revised": est_revised, "unchanged": est_unchanged,
         "removed": est_removed, "distinct": est_distinct},
    )


def store_live_articles(db: Path, provenance: dict, scraped_at: str) -> None:
    """A run that stored a release keeps the pages it came in: the English
    article it fetched, and the Russian one (fetched now; a failure there is
    reported, not fatal — the numbers are stored)."""
    pages = [(provenance["article_url"], provenance["article_html"])]
    try:
        raw, ru_url = _fetch_final(RU_ARTICLE_URL)
        pages.append((ru_url, raw.decode("utf-8", errors="replace")))
    except Exception as e:  # noqa: BLE001
        print(f"[warn] Russian article not stored: {e}", file=sys.stderr)
    conn = sqlite3.connect(db)
    try:
        for url, page in pages:
            store_article(conn, parse_article(page, url, scraped_at, "live"))
        conn.commit()
    finally:
        conn.close()


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
        roles, estimate, derived_published_at, provenance = fetch_from_article(args.from_article)
        published_at = args.published_at or derived_published_at
    else:
        if not args.published_at:
            raise SystemExit("--published-at is required in local CSV mode")
        roles = parse_roles(Path(args.roles))
        estimate = parse_estimate(Path(args.estimate))
        published_at = args.published_at
        provenance = {"source": "csv"}

    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", published_at):
        raise SystemExit(f"published_at must be YYYY-MM-DD, got {published_at!r}")

    scraped_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    out = Path(args.out)
    r, e = build(out, roles, estimate, scraped_at, published_at, provenance)
    if provenance.get("article_html") and (r["new"] + r["revised"] + e["new"] + e["revised"] + e["removed"]):
        store_live_articles(out, provenance, scraped_at)
    fmt = lambda s: (
        f"{s['new']:>4} new, {s['revised']:>4} revised, {s['unchanged']:>4} unchanged "
        + (f", {s['removed']} removed" if s.get('removed') else "")
        + f" -> {s['new'] + s['revised'] + s.get('removed', 0)} inserted; {s['distinct']} distinct weeks"
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
