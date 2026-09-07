#!/usr/bin/env python3
"""
ingest.py — build data/rubikon.db from «Рубикон» monthly recap Telegram posts.

Source: @icpbtrubicon, the channel of the Russian UAV unit Центр «Рубикон».
TWO independent monthly series are stored, distinguished by `reports.report_type`:

  'monthly'        parse.py        — the General-Staff-plan recap posted on the
                                     3rd–4th ("Применение … по плану начальника
                                     Генерального Штаба"). Targets ENGAGED.
  'monthly_digest' parse_digest.py — the «Итоги <месяца>» post at month end.
                                     Strike videos the channel PUBLISHED.

They are NOT two formats of one thing: both exist for Jan/Feb/Mar 2026 and
disagree by ~4× because one counts claims and the other counts publications.
See parse_digest.py's docstring for the evidence. Same DB, different `kind`,
different page — never the same axis.

Backend: the public **t.me/s web preview** — plain HTTP + HTML, no Telegram API
account, stdlib only. Same approach as scripts/ru_mod. (TELEGRAM_API_ID/HASH
are NOT needed: everything this script reads is on the public preview page.)

Typical use:

    # incremental — what CI runs; a couple of pages covers the last ~2 weeks
    python3 scripts/rubikon/ingest.py --out data/rubikon.db

    # historical backfill — the series starts with the 2026-01 recap
    python3 scripts/rubikon/ingest.py --out data/rubikon.db --backfill

    # re-parse already-stored post text after a parser fix (no re-fetch).
    # Dry run by default — add --apply to write, same as reparse-gsua-db.yml.
    python3 scripts/rubikon/ingest.py --out data/rubikon.db --reparse

Storage is append-on-change, mirroring scripts/sbu_alfa and scripts/ru_mod:
PRIMARY KEY (post_id, scraped_at). A post the channel later EDITS inserts a new
versioned row instead of overwriting; reads resolve the latest scraped_at per
post via the `reports_latest` / `counters_latest` views. If a re-scrape parses
to exactly the same counters, nothing is inserted at all.

The channel posts ~250 times a month and we want 1 of them, so `--backfill`
walks a lot of pages. `--max-pages` bounds it; the default incremental run
stops as soon as it pages past a post id it already has.
"""
from __future__ import annotations

import argparse
import calendar
import hashlib
import os
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import parse_digest  # noqa: E402
from parse import parse  # noqa: E402

CHANNEL = os.environ.get("RUBIKON_CHANNEL", "icpbtrubicon")
DEFAULT_DB = Path("data") / os.environ.get("RUBIKON_DB_NAME", "rubikon.db")
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

# Incremental default: the recap lands on the 3rd–4th and CI polls daily across
# that window, so two pages (~40 posts, ~2 days of this channel) is plenty.
DEFAULT_PAGES = 3
# Backfill default: enough to walk back past the first recap (2026-01, post
# 1016) from the present day at ~20 posts/page.
DEFAULT_BACKFILL_PAGES = 150


# ── schema ──────────────────────────────────────────────────────────────────
# `reports.body_text` keeps the raw post text so a later parser fix can be
# applied with `--reparse` instead of re-scraping (CLAUDE.md: a re-scrape
# re-ingests identical text and changes nothing).
SCHEMA = """
CREATE TABLE IF NOT EXISTS reports (
  post_id      INTEGER NOT NULL,
  scraped_at   TEXT NOT NULL,     -- UTC ISO8601, our ingest timestamp
  posted_at    TEXT NOT NULL,     -- UTC ISO8601, the Telegram post timestamp
  report_type  TEXT NOT NULL,     -- 'monthly' (GS recap) | 'monthly_digest'
  period       TEXT,              -- 'YYYY-MM' — the month the report covers
  period_start TEXT,              -- 'YYYY-MM-DD'
  period_end   TEXT,              -- 'YYYY-MM-DD'
  url          TEXT NOT NULL,     -- https://t.me/<channel>/<post_id>
  body_text    TEXT NOT NULL,
  text_hash    TEXT NOT NULL,     -- sha256 of body_text; cheap edit detector
  PRIMARY KEY (post_id, scraped_at)
);
CREATE INDEX IF NOT EXISTS ix_reports_period ON reports (period);

CREATE TABLE IF NOT EXISTS counters (
  post_id    INTEGER NOT NULL,
  scraped_at TEXT NOT NULL,
  category   TEXT NOT NULL,       -- personnel | tanks | … (see the two parsers;
                                  -- the digest series has its own namespace)
  kind       TEXT NOT NULL,       -- recap:  sorties | engaged | ew_suppressed
                                  -- digest: published_total | published_episodes
  value      INTEGER NOT NULL,
  -- 'exact', or 'at_least' where the source says "превысило N" (a floor).
  -- Only the digest series uses at_least so far; recap numbers are all bare.
  bound      TEXT NOT NULL DEFAULT 'exact',
  raw_label  TEXT,                -- verbatim Russian phrasing
  PRIMARY KEY (post_id, scraped_at, category),
  FOREIGN KEY (post_id, scraped_at) REFERENCES reports (post_id, scraped_at)
);
CREATE INDEX IF NOT EXISTS ix_counters_category ON counters (category);

-- Latest stored version of each post.
CREATE VIEW IF NOT EXISTS reports_latest AS
  SELECT r.* FROM reports r
  JOIN (SELECT post_id, MAX(scraped_at) AS ms FROM reports GROUP BY post_id) l
    ON r.post_id = l.post_id AND r.scraped_at = l.ms;

CREATE VIEW IF NOT EXISTS counters_latest AS
  SELECT c.* FROM counters c
  JOIN (SELECT post_id, MAX(scraped_at) AS ms FROM reports GROUP BY post_id) l
    ON c.post_id = l.post_id AND c.scraped_at = l.ms;
"""


# ── web backend (t.me/s preview) ────────────────────────────────────────────
# Same shape as scripts/ru_mod/ingest.py's parser. Kept local rather than
# imported so the two scrapers can drift independently — this one MUST keep
# <br> as "\n" because parse.py reads the "Поражены:" block line by line.
class _TgParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.posts: list[dict] = []
        self.cur: dict | None = None
        self._cap = 0
        self.next_before: str | None = None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        cls = a.get("class", "")
        if tag == "div" and a.get("data-post") and "tgme_widget_message" in cls:
            self.cur = {"id": a["data-post"].split("/")[-1], "dt": None, "text": []}
            self.posts.append(self.cur)
        if tag == "div" and "tgme_widget_message_text" in cls:
            self._cap = 1
            return
        if self._cap:
            if tag == "div":
                self._cap += 1
            elif tag == "br" and self.cur:
                self.cur["text"].append("\n")
        if tag == "time" and self.cur and self.cur["dt"] is None and a.get("datetime"):
            self.cur["dt"] = a["datetime"]
        if tag == "a" and "tme_messages_more" in cls and a.get("data-before"):
            self.next_before = a["data-before"]

    def handle_endtag(self, tag):
        if self._cap and tag == "div":
            self._cap -= 1

    def handle_data(self, data):
        if self._cap and self.cur:
            self.cur["text"].append(data)


def _fetch(url: str, attempts: int = 4, backoff: float = 2.0) -> str:
    """GET with retries.

    t.me drops the TLS connection mid-handshake every so often, and a long
    `--backfill` walk makes ~150 requests — often enough that a single-shot
    fetch reliably dies part-way through (SSL: UNEXPECTED_EOF_WHILE_READING).
    Exponential backoff on transport errors only; an HTTP status error is
    surfaced immediately since retrying it won't help.
    """
    last: Exception | None = None
    for attempt in range(attempts):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError:
            raise
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            last = e
            if attempt == attempts - 1:
                break
            wait = backoff * (2 ** attempt)
            print(f"  retrying {url} in {wait:.0f}s after {type(e).__name__}: {e}",
                  file=sys.stderr)
            time.sleep(wait)
    assert last is not None
    raise last


def iter_web(channel: str, since_id: int, max_pages: int, sleep: float, backfill: bool):
    """Yield (post_id, posted_at_utc, text), newest first.

    Incremental (default): stop once we page past `since_id` (already stored).
    Backfill: ignore since_id and walk until max_pages or the channel start.
    """
    base = f"https://t.me/s/{channel}"
    before: str | None = None
    seen: set[int] = set()
    for _ in range(max_pages):
        url = base + (f"?before={before}" if before else "")
        p = _TgParser()
        p.feed(_fetch(url))
        page_ids: list[int] = []
        reached_known = False
        for post in p.posts:
            if not post["id"].isdigit():
                continue
            pid = int(post["id"])
            page_ids.append(pid)
            if pid in seen:
                continue
            seen.add(pid)
            if not backfill and pid <= since_id:
                reached_known = True
                continue
            if not post["dt"]:
                continue
            dt = datetime.fromisoformat(post["dt"]).astimezone(timezone.utc)
            yield pid, dt, "".join(post["text"])
        if not page_ids:
            break
        if reached_known and not backfill:
            break
        before = p.next_before or str(min(page_ids))
        time.sleep(sleep)


# ── unified parse layer ─────────────────────────────────────────────────────
# The two parsers return different dataclasses; everything downstream (storage,
# reparse, logging) works on this one normalised shape.

@dataclass
class Parsed:
    report_type: str                 # 'monthly' | 'monthly_digest' | 'unknown'
    period: str | None               # YYYY-MM
    period_start: str | None
    period_end: str | None
    # (category, kind, value, bound, raw_label)
    counters: list[tuple[str, str, int, str, str]]
    unmatched: list[str]
    warnings: list[str]


def parse_any(text: str, posted_at: datetime) -> Parsed:
    """Recognise either series, or neither.

    Tried recap-first: its gate (a "с 1 по <last day> <month> <year>" headline
    plus a "Поражены:" list) is the stricter of the two, and no post has ever
    satisfied both.
    """
    rec = parse(text)
    if rec.report_type == "monthly":
        return Parsed(
            "monthly", rec.period, rec.period_start, rec.period_end,
            [(c.category, c.kind, c.value, "exact", c.raw_label) for c in rec.counters],
            rec.unmatched, [],
        )

    dig = parse_digest.parse(text, posted_at.date())
    if dig.report_type == "monthly_digest" and dig.period:
        y, m = (int(x) for x in dig.period.split("-"))
        last = calendar.monthrange(y, m)[1]
        return Parsed(
            "monthly_digest", dig.period,
            f"{dig.period}-01", f"{dig.period}-{last:02d}",
            [(c.category, c.kind, c.value, c.bound, c.raw_label) for c in dig.counters],
            dig.unmatched, dig.warnings,
        )

    return Parsed("unknown", None, None, None, [], [], [])


# ── storage ─────────────────────────────────────────────────────────────────

def _signature(counters: list[tuple[str, str, int, str, str]]) -> tuple:
    """Hashable shape used to decide whether a re-parse changed anything."""
    return tuple(sorted((c[0], c[1], c[2], c[3]) for c in counters))


def _connect(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.executescript(SCHEMA)
    _migrate(conn)
    return conn


def _migrate(conn: sqlite3.Connection) -> None:
    """Additive migrations for DBs created by an earlier version of this script.

    `CREATE TABLE IF NOT EXISTS` is a no-op on an existing table, so a new
    column has to be added explicitly. Additive only — no data is rewritten,
    and the DEFAULT matches what every pre-existing row already meant.
    """
    cols = {r[1] for r in conn.execute("PRAGMA table_info(counters)")}
    if "bound" not in cols:
        conn.execute("ALTER TABLE counters ADD COLUMN bound TEXT NOT NULL DEFAULT 'exact'")
        conn.commit()


def _max_post_id(conn: sqlite3.Connection) -> int:
    row = conn.execute("SELECT MAX(post_id) FROM reports").fetchone()
    return int(row[0]) if row and row[0] is not None else 0


def store(
    conn: sqlite3.Connection,
    post_id: int,
    posted_at: datetime,
    text: str,
    report: Parsed,
    channel: str,
) -> str:
    """Insert a new version of one post. Returns 'inserted'|'updated'|'unchanged'."""
    scraped_at = datetime.now(timezone.utc).isoformat(timespec="microseconds")
    prior = conn.execute(
        "SELECT scraped_at FROM reports WHERE post_id = ? ORDER BY scraped_at DESC LIMIT 1",
        (post_id,),
    ).fetchone()

    if prior:
        prior_sig = tuple(sorted(conn.execute(
            "SELECT category, kind, value, bound FROM counters "
            "WHERE post_id = ? AND scraped_at = ?",
            (post_id, prior[0]),
        ).fetchall()))
        if prior_sig == _signature(report.counters):
            return "unchanged"
        status = "updated"
    else:
        status = "inserted"

    conn.execute(
        "INSERT INTO reports (post_id, scraped_at, posted_at, report_type, period, "
        "period_start, period_end, url, body_text, text_hash) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            post_id, scraped_at,
            posted_at.astimezone(timezone.utc).isoformat(timespec="seconds"),
            report.report_type, report.period, report.period_start, report.period_end,
            f"https://t.me/{channel}/{post_id}", text,
            hashlib.sha256(text.encode("utf-8")).hexdigest(),
        ),
    )
    for category, kind, value, bound, raw_label in report.counters:
        conn.execute(
            "INSERT INTO counters (post_id, scraped_at, category, kind, value, bound, raw_label) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (post_id, scraped_at, category, kind, value, bound, raw_label),
        )
    conn.commit()
    return status


# ── reporting helpers ───────────────────────────────────────────────────────

def _print_report(post_id: int, report: Parsed) -> None:
    print(f"  post {post_id}: {report.report_type} period={report.period} "
          f"counters={len(report.counters)}")
    for category, kind, value, bound, _ in report.counters:
        flag = " [at_least]" if bound == "at_least" else ""
        print(f"    {category:22s} {kind:18s} {value:>8d}{flag}")


def _warn(post_id: int, report: Parsed) -> None:
    """Surface drift and source oddities instead of dropping them silently."""
    module = "parse.py" if report.report_type == "monthly" else "parse_digest.py"
    if report.unmatched:
        print(
            f"WARNING: post {post_id} has {len(report.unmatched)} line(s) no "
            f"category claimed (new or renamed?) — add an alias in "
            f"scripts/rubikon/{module}, then re-run with --reparse: "
            f"{report.unmatched}",
            file=sys.stderr,
        )
    for w in report.warnings:
        print(f"WARNING: post {post_id}: {w}", file=sys.stderr)


# ── modes ───────────────────────────────────────────────────────────────────

def run_scrape(args: argparse.Namespace) -> int:
    conn = _connect(args.out)
    try:
        since_id = 0 if args.backfill else _max_post_id(conn)
        max_pages = args.max_pages or (DEFAULT_BACKFILL_PAGES if args.backfill else DEFAULT_PAGES)
        counts = {"inserted": 0, "updated": 0, "unchanged": 0}
        scanned = 0
        for post_id, posted_at, text in iter_web(
            args.channel, since_id, max_pages, args.sleep, args.backfill
        ):
            scanned += 1
            report = parse_any(text, posted_at)
            # Only the two monthly series are stored. Everything else on this
            # channel (combat footage, recruiting, milestone tallies, the
            # direction-scoped cumulative totals) parses to 'unknown' and is
            # skipped silently — that's ~200 posts a month, so logging each one
            # would drown the log.
            if report.report_type == "unknown":
                continue
            _warn(post_id, report)
            status = store(conn, post_id, posted_at, text, report, args.channel)
            counts[status] += 1
            print(f"{status}: {args.channel}/{post_id} → {report.report_type} "
                  f"{report.period} ({len(report.counters)} counters)")
            if args.verbose:
                _print_report(post_id, report)
        print(f"scanned {scanned} post(s) over ≤{max_pages} page(s); "
              f"{counts['inserted']} inserted, {counts['updated']} updated, "
              f"{counts['unchanged']} unchanged")
        _emit_changed(counts["inserted"] + counts["updated"] > 0)
        return 0
    finally:
        conn.close()


def run_reparse(args: argparse.Namespace) -> int:
    """Re-run the parser over already-stored post text.

    A widened scrape only helps for posts the parser DROPPED. When a fix changes
    how stored text is READ, the stored rows need re-parsing — that's this.
    Dry-run unless --apply is passed (mirrors scripts/gsua/reparse.py and the
    reparse-gsua-db.yml workflow, whose `dry_run` input defaults to on).
    """
    dry_run = not args.apply
    if not args.out.exists():
        print(f"ERROR: {args.out} does not exist", file=sys.stderr)
        return 1
    conn = _connect(args.out)
    try:
        rows = conn.execute(
            "SELECT post_id, posted_at, body_text FROM reports_latest ORDER BY post_id"
        ).fetchall()
        counts = {"inserted": 0, "updated": 0, "unchanged": 0}
        for post_id, posted_at, body_text in rows:
            report = parse_any(body_text, datetime.fromisoformat(posted_at))
            if report.report_type == "unknown":
                print(f"WARNING: stored post {post_id} no longer parses as either "
                      f"monthly series — leaving it untouched", file=sys.stderr)
                continue
            _warn(post_id, report)
            if dry_run:
                prior = tuple(sorted(conn.execute(
                    "SELECT category, kind, value, bound FROM counters_latest WHERE post_id = ?",
                    (post_id,),
                ).fetchall()))
                changed = prior != _signature(report.counters)
                counts["updated" if changed else "unchanged"] += 1
                print(f"{'would update' if changed else 'unchanged'}: {post_id} "
                      f"→ {report.report_type} {report.period} "
                      f"({len(report.counters)} counters)")
                if changed and args.verbose:
                    _print_report(post_id, report)
                continue
            status = store(
                conn, post_id,
                datetime.fromisoformat(posted_at), body_text, report, args.channel,
            )
            counts[status] += 1
            print(f"{status}: {post_id} → {report.report_type} {report.period} "
                  f"({len(report.counters)} counters)")
        print(f"reparsed {len(rows)} stored post(s); "
              f"{counts['updated']} changed, {counts['unchanged']} unchanged"
              + (" (dry run — nothing written; re-run with --apply)" if dry_run else ""))
        _emit_changed(not dry_run and counts["inserted"] + counts["updated"] > 0)
        return 0
    finally:
        conn.close()


def _emit_changed(changed: bool) -> None:
    """Tell the workflow whether to re-upload. The recap publishes ~once a
    month while CI polls daily across the publication window, so most runs are
    no-ops and must not bust the CDN cache."""
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a", encoding="utf-8") as fh:
            fh.write(f"changed={'true' if changed else 'false'}\n")


# ── CLI ─────────────────────────────────────────────────────────────────────

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--out", type=Path, default=DEFAULT_DB, help=f"DB path (default: {DEFAULT_DB})")
    ap.add_argument("--channel", default=CHANNEL, help=f"Telegram channel (default: {CHANNEL})")
    ap.add_argument("--backfill", action="store_true",
                    help="walk the whole channel history instead of stopping at the newest stored post")
    ap.add_argument("--max-pages", type=int, default=None,
                    help=f"page cap (default: {DEFAULT_PAGES} incremental, {DEFAULT_BACKFILL_PAGES} backfill)")
    ap.add_argument("--sleep", type=float, default=0.5, help="delay between preview pages (default: 0.5s)")
    ap.add_argument("--reparse", action="store_true",
                    help="re-parse stored post text instead of scraping (see --dry-run)")
    ap.add_argument("--apply", action="store_true",
                    help="with --reparse: actually write the re-parsed rows (default: dry run)")
    ap.add_argument("--verbose", action="store_true", help="print every parsed counter")
    args = ap.parse_args(argv)

    if args.reparse:
        return run_reparse(args)
    if args.apply:
        ap.error("--apply only applies to --reparse")
    return run_scrape(args)


if __name__ == "__main__":
    raise SystemExit(main())
