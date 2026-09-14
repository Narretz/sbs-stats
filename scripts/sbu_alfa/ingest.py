#!/usr/bin/env python3
"""
ingest.py — build data/sbu-alfa.db from SBU "Альфа" monthly recap articles.

Manual ingest: the SBU news feed isn't a channel we can subscribe to (no API,
no RSS that I can find, and Akamai blocks pagination/sitemap from
ssu.gov.ua/novyny). When a new recap drops, run:

    python3 scripts/sbu_alfa/ingest.py <url-or-file> --out data/sbu-alfa.db

The script fetches with a browser-like UA + headers (the SBU CDN 403s anything
that looks like curl/requests' default), extracts body text, runs parse.py,
and upserts into a (reports, counters) pair of tables.

After a parser FIX, re-read the text already stored instead of re-scraping —
discover.py skips URLs already in the DB, so a re-run would change nothing:

    # Dry run by default — add --apply to write. In CI this is its own manual
    # workflow, .github/workflows/reparse-sbu-alfa-db.yml.
    python3 scripts/sbu_alfa/ingest.py --reparse --out data/sbu-alfa.db

Storage is append-on-edit, mirroring scripts/ru_mod:
    PRIMARY KEY (url, scraped_at) — re-ingesting an EDITED article inserts a
    new versioned row; reads should resolve the latest scraped_at per url.
    If the parsed counters are byte-identical to the latest stored version,
    we skip the insert so unchanged re-runs are no-ops.

stdlib only (urllib + sqlite3 + html.parser).
"""
from __future__ import annotations

import argparse
import hashlib
import os
import re
import sqlite3
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

# Allow running as a script from the repo root or from scripts/sbu_alfa/.
SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))
# Shared diagnostics sink: stderr as before, plus a JSONL record per WARNING
# when $INGEST_LOG is set, which scripts/annotate_log.py turns into GitHub
# annotations. `scripts/` isn't a package, so the parent goes on sys.path too.
if str(SCRIPT_DIR.parent) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR.parent))

from ingest_log import ann, get_logger  # noqa: E402
from parse import Counter, ParsedReport, extract_text, parse  # noqa: E402

log = get_logger("sbu-alfa")

DEFAULT_DB = Path("data/sbu-alfa.db")

UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
BROWSER_HEADERS = {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "uk-UA,uk;q=0.9,en;q=0.8",
    "Accept-Encoding": "identity",  # no gzip — keeps urllib stdlib-only path simple
    "DNT": "1",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
}


# ── schema ──────────────────────────────────────────────────────────────────
# `reports` — one row per (url, scraped_at). Stores the raw extracted body
# alongside the parsed metadata so we can re-parse later without re-fetching
# (which matters: SBU's CDN often refuses bot-y requests, and mirror sites can
# disappear).
#
# `counters` — long-table of parsed numeric values, keyed on (url, scraped_at,
# category) so two scrapes of the same article live independently and the
# latest one wins on read. Mirrors the HUR `reports.json` model
# (scripts/missile_stockpile) with `value`/`value_max`/`bound`/`raw_label`.
SCHEMA = """
CREATE TABLE IF NOT EXISTS reports (
  url              TEXT NOT NULL,
  scraped_at       TEXT NOT NULL,    -- UTC ISO8601
  report_type      TEXT NOT NULL,    -- monthly_top1 | annual | themed | unknown
  period           TEXT,             -- '2026-05' (month) | '2025' (year)
  period_precision TEXT,             -- 'month' | 'year'
  published_at     TEXT,             -- article publication date, when extractable
  title            TEXT,
  body_text        TEXT NOT NULL,
  body_html_hash   TEXT NOT NULL,    -- sha256 of fetched HTML; cheap edit detector
  PRIMARY KEY (url, scraped_at)
);
CREATE INDEX IF NOT EXISTS ix_reports_period ON reports (period);

CREATE TABLE IF NOT EXISTS counters (
  url        TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  category   TEXT NOT NULL,         -- enemy_kia | drones | tanks | …
  value      INTEGER NOT NULL,
  value_max  INTEGER,               -- non-null only for bound='range'
  bound      TEXT NOT NULL,         -- exact | at_least | approx | up_to | range
  raw_label  TEXT,                  -- verbatim Ukrainian phrasing
  PRIMARY KEY (url, scraped_at, category),
  FOREIGN KEY (url, scraped_at) REFERENCES reports (url, scraped_at)
);
CREATE INDEX IF NOT EXISTS ix_counters_category ON counters (category);

-- Latest version per article URL.
CREATE VIEW IF NOT EXISTS reports_latest AS
  SELECT r.* FROM reports r
  JOIN (SELECT url, MAX(scraped_at) AS ms FROM reports GROUP BY url) l
    ON r.url = l.url AND r.scraped_at = l.ms;

-- Latest counters per article URL.
CREATE VIEW IF NOT EXISTS counters_latest AS
  SELECT c.* FROM counters c
  JOIN (SELECT url, MAX(scraped_at) AS ms FROM reports GROUP BY url) l
    ON c.url = l.url AND c.scraped_at = l.ms;
"""


# ── fetch / read ────────────────────────────────────────────────────────────

def _fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers=BROWSER_HEADERS)
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()


def _load(source: str) -> tuple[str, bytes]:
    """Return (url, raw_html_bytes). Source can be a URL or a local file path."""
    if source.startswith(("http://", "https://")):
        return source, _fetch(source)
    p = Path(source)
    if not p.exists():
        raise FileNotFoundError(source)
    return f"file://{p.resolve()}", p.read_bytes()


# ── title / published_at extraction ────────────────────────────────────────

_TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.I | re.S)
# Looks for an explicit "DD месяць YYYY" Ukrainian date stamp.
_UA_DATE_RE = re.compile(
    r"(\d{1,2})\s+(січня|лютого|березня|квітня|травня|червня|липня|серпня|вересня|жовтня|листопада|грудня)\s+(20\d{2})",
    re.I,
)
_UA_MONTH_NOMINATIVE = {
    "січня": 1, "лютого": 2, "березня": 3, "квітня": 4, "травня": 5, "червня": 6,
    "липня": 7, "серпня": 8, "вересня": 9, "жовтня": 10, "листопада": 11, "грудня": 12,
}


def _extract_title(html_bytes: bytes) -> str | None:
    m = _TITLE_RE.search(html_bytes.decode("utf-8", "replace"))
    if not m:
        return None
    import html as _html
    return _html.unescape(re.sub(r"\s+", " ", m.group(1)).strip())


def _extract_published_at(body_text: str) -> str | None:
    """First plausible Ukrainian date in the body — used as article date."""
    m = _UA_DATE_RE.search(body_text)
    if not m:
        return None
    day, month_word, year = m.groups()
    month = _UA_MONTH_NOMINATIVE.get(month_word.lower())
    if not month:
        return None
    return f"{int(year):04d}-{month:02d}-{int(day):02d}"


# ── storage ────────────────────────────────────────────────────────────────

def _counters_signature(counters: list[Counter]) -> tuple:
    """Stable, hashable shape used to detect whether re-ingest changed anything."""
    return tuple(sorted(
        (c.category, c.value, c.value_max, c.bound) for c in counters
    ))


def store(
    db_path: Path,
    url: str,
    raw_html: bytes,
    report: ParsedReport,
    title: str | None,
    published_at: str | None,
    report_type_override: str | None = None,
) -> str:
    """Upsert. Returns 'inserted', 'unchanged', or 'updated'."""
    db_path.parent.mkdir(parents=True, exist_ok=True)
    body_text = extract_text(raw_html.decode("utf-8", "replace"))
    body_html_hash = hashlib.sha256(raw_html).hexdigest()
    scraped_at = datetime.now(timezone.utc).isoformat(timespec="microseconds")
    report_type = report_type_override or report.report_type

    conn = sqlite3.connect(db_path)
    try:
        conn.executescript(SCHEMA)

        prior = conn.execute(
            "SELECT scraped_at FROM reports WHERE url = ? "
            "ORDER BY scraped_at DESC LIMIT 1",
            (url,),
        ).fetchone()

        if prior:
            prior_sig = tuple(sorted(conn.execute(
                "SELECT category, value, value_max, bound FROM counters "
                "WHERE url = ? AND scraped_at = ?",
                (url, prior[0]),
            ).fetchall()))
            new_sig = _counters_signature(report.counters)
            if prior_sig == new_sig:
                return "unchanged"
            status = "updated"
        else:
            status = "inserted"

        _write_version(conn, url, scraped_at, report, title, published_at,
                       body_text, body_html_hash, report_type)
        conn.commit()
        return status
    finally:
        conn.close()


def _write_version(
    conn: sqlite3.Connection,
    url: str,
    scraped_at: str,
    report: ParsedReport,
    title: str | None,
    published_at: str | None,
    body_text: str,
    body_html_hash: str,
    report_type: str,
) -> None:
    """Insert one (url, scraped_at) version — the report row plus its counters.

    Shared by the scrape path (store()) and the reparse path, which differ only
    in where `body_text` comes from: a fresh fetch vs. the text already stored.
    """
    conn.execute(
        "INSERT INTO reports "
        "(url, scraped_at, report_type, period, period_precision, "
        "published_at, title, body_text, body_html_hash) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (url, scraped_at, report_type, report.period, report.period_precision,
         published_at, title, body_text, body_html_hash),
    )
    for c in report.counters:
        conn.execute(
            "INSERT INTO counters "
            "(url, scraped_at, category, value, value_max, bound, raw_label) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (url, scraped_at, c.category, c.value, c.value_max, c.bound, c.raw_label),
        )


# ── drift reporting ────────────────────────────────────────────────────────

def warn_unmatched(url: str, report: ParsedReport) -> None:
    """Surface counter lines the parser recognised as counters but no category
    claimed — a new category, or a case ending we haven't seen (the recap's
    endings shift with the preceding numeral, which is how Aug 2026's "вузол"
    and "бойові броньовані машини" lines went missing).

    Routed through ingest_log so the finding becomes a GitHub annotation in CI
    instead of a stderr line nobody opens the log to read, and is raised in one
    place for both callers (this module's CLI and discover.py). The recognised
    counters are still stored — a miss costs one category, not the report.
    """
    if not report.unmatched:
        return
    log.warning(
        f"{len(report.unmatched)} counter line(s) matched no category "
        f"(new or renamed?) — add a pattern in CATEGORIES: "
        f"{'; '.join(report.unmatched)} — {url}",
        extra=ann(
            title="sbu-alfa: unrecognised counter line",
            file="scripts/sbu_alfa/parse.py",
        ),
    )


# ── reparse ────────────────────────────────────────────────────────────────
#
# The other half of the parser-fix loop. A widened scan only helps for recaps
# the discovery filter or the report-type gate DROPPED — a recap already in the
# DB is skipped by discover.py on URL, so a re-run after a parser fix changes
# nothing. When a fix changes how already-stored text is READ (Aug 2026: two
# counter lines whose case endings no regex covered), the stored rows need
# re-parsing instead. That's this: `reports.body_text` holds the extracted
# article text precisely so this never needs a re-fetch — which matters, since
# SBU's CDN 403s a large share of automated requests.

def _delta(prior: list[tuple], counters: list[Counter]) -> list[str]:
    """Per-category diff, prior → re-parsed, for the dry run's report."""
    old = {c: (v, vm, b) for c, v, vm, b in prior}
    new = {c.category: (c.value, c.value_max, c.bound) for c in counters}
    lines = []
    for cat in sorted(set(old) | set(new)):
        if cat not in old:
            lines.append(f"+ {cat} = {new[cat][0]} ({new[cat][2]})")
        elif cat not in new:
            lines.append(f"- {cat} (was {old[cat][0]})")
        elif old[cat] != new[cat]:
            lines.append(f"~ {cat}: {old[cat][0]} ({old[cat][2]}) → "
                         f"{new[cat][0]} ({new[cat][2]})")
    return lines


def run_reparse(db_path: Path, apply: bool = False) -> int:
    """Re-run the current parser over every stored report's `body_text`.

    Dry-run unless `apply` — same default as scripts/rubikon/ingest.py
    --reparse and reparse-gsua-db.yml, whose `dry_run` input is on: read the
    diff first, then commit to it. A changed row is APPENDED as a new
    (url, scraped_at) version, never overwritten, like every other write here.
    """
    if not db_path.exists():
        log.error(f"{db_path} does not exist — pull it from R2 first")
        return 1
    conn = sqlite3.connect(db_path)
    try:
        rows = conn.execute(
            "SELECT url, report_type, period, published_at, title, body_text, "
            "body_html_hash FROM reports_latest ORDER BY period, url"
        ).fetchall()
        scraped_at = datetime.now(timezone.utc).isoformat(timespec="microseconds")
        changed = unchanged = skipped = 0
        for url, report_type, period, published_at, title, body_text, body_hash in rows:
            report = parse(body_text)
            warn_unmatched(url, report)
            if report.report_type != report_type or not report.period:
                # The parser no longer recognises what this row was stored as.
                # Either a regression, or the row carries a manual
                # --report-type / --period override that parse() can't
                # reproduce. Leave it alone either way — a reparse must not
                # quietly downgrade a row a human curated.
                log.warning(
                    f"stored {period or '?'} report parses as "
                    f"{report.report_type}/{report.period} but is stored as "
                    f"{report_type}/{period} — left untouched: {url}",
                    extra=ann(title="sbu-alfa: reparse skipped a stored report"),
                )
                skipped += 1
                continue

            prior = conn.execute(
                "SELECT category, value, value_max, bound FROM counters_latest "
                "WHERE url = ?", (url,),
            ).fetchall()
            delta = _delta(prior, report.counters)
            if not delta and report.period == period:
                unchanged += 1
                print(f"  unchanged  {period}  {len(report.counters)} counters")
                continue

            changed += 1
            verb = "updated   " if apply else "would update"
            print(f"  {verb} {period}  {len(prior)} → {len(report.counters)} counters")
            if report.period != period:
                print(f"      ~ period: {period} → {report.period}")
            for line in delta:
                print(f"      {line}")
            if apply:
                _write_version(conn, url, scraped_at, report, title, published_at,
                               body_text, body_hash, report.report_type)
        if apply:
            conn.commit()
        print(f"\nreparsed {len(rows)} stored report(s); {changed} changed, "
              f"{unchanged} unchanged, {skipped} skipped"
              + ("" if apply else " (dry run — nothing written; re-run with --apply)"))
        _emit_changed(apply and changed > 0)
        return 0
    finally:
        conn.close()


def _emit_changed(changed: bool) -> None:
    """Tell a GitHub Actions caller whether the DB actually changed, so the
    workflow can skip the R2 upload on a no-op run. SBU Alfa publishes ~once a
    month while the workflow runs ~16×/month, so ≥94% of runs are no-ops and
    must not bust the CDN cache. Always emitted, so the step's outputs are
    deterministic regardless of what the run found."""
    gh_out = os.environ.get("GITHUB_OUTPUT")
    if gh_out:
        with open(gh_out, "a", encoding="utf-8") as f:
            f.write(f"changed={'true' if changed else 'false'}\n")


# ── CLI ────────────────────────────────────────────────────────────────────

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("source", nargs="?", help="article URL or local HTML file path")
    ap.add_argument("--out", type=Path, default=DEFAULT_DB, help=f"DB path (default: {DEFAULT_DB})")
    ap.add_argument("--report-type", choices=["monthly_top1", "annual", "themed"],
                    help="override the auto-detected report type")
    ap.add_argument("--period", help="override detected period (e.g. '2026-05' or '2025')")
    ap.add_argument("--published-at", help="article publication date (YYYY-MM-DD)")
    ap.add_argument("--dry-run", action="store_true", help="parse + print, don't write DB")
    ap.add_argument("--reparse", action="store_true",
                    help="re-run the parser over the text already stored in --out "
                         "(no fetch); use after a parser fix. Dry run unless --apply")
    ap.add_argument("--apply", action="store_true",
                    help="with --reparse: actually write the re-parsed rows (default: dry run)")
    args = ap.parse_args(argv)

    if args.reparse:
        if args.source:
            ap.error("--reparse reads the stored text; it takes no source argument")
        return run_reparse(args.out, args.apply)
    if args.apply:
        ap.error("--apply only applies to --reparse")
    if not args.source:
        ap.error("a source (article URL or HTML file) is required unless --reparse")

    url, raw_html = _load(args.source)
    body_text = extract_text(raw_html.decode("utf-8", "replace"))
    report = parse(body_text)
    if args.period:
        report.period = args.period
        report.period_precision = "month" if len(args.period) == 7 else "year"
    title = _extract_title(raw_html)
    published_at = args.published_at or _extract_published_at(body_text)

    print(f"url:          {url}")
    print(f"title:        {title!r}")
    print(f"report_type:  {args.report_type or report.report_type}")
    print(f"period:       {report.period} ({report.period_precision})")
    print(f"published_at: {published_at}")
    print(f"counters:     {len(report.counters)}")
    for c in report.counters:
        bracket = f" [{c.bound}]" if c.bound != "exact" else ""
        print(f"  {c.category:22s} {c.value:>8d}{bracket}")
    warn_unmatched(url, report)

    if args.dry_run:
        print("(dry-run; not writing)")
        return 0

    status = store(args.out, url, raw_html, report, title, published_at, args.report_type)
    print(f"-> {status} ({args.out})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
