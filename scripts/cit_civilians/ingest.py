#!/usr/bin/env python3
"""
ingest.py — build data/cit-civilians.db from CIT daily civilian-casualty posts.

Source: @CIT_shellings, the Conflict Intelligence Team's shelling monitor. Once
a day it posts a 20:00–20:00 MSK summary of civilian casualties by region, plus
corrections to earlier days. parse.py turns one such post into rows; this
script handles fetching, stitching, storage and re-parsing.

Backend: the public **t.me/s web preview** — plain HTTP + HTML, no Telegram API
account, stdlib only. Same approach as scripts/ru_mod and scripts/rubikon.

Typical use:

    # incremental — what CI runs; a few pages covers the last few days
    python3 scripts/cit_civilians/ingest.py --out data/cit-civilians.db

    # historical backfill — the daily-summary format starts 2023-10-16 (post
    # ~2105); the channel itself starts 2023-09-02 with no summaries.
    python3 scripts/cit_civilians/ingest.py --out data/cit-civilians.db --backfill

    # re-parse already-stored post text after a parser fix (no re-fetch).
    # Dry run by default — add --apply to write.
    python3 scripts/cit_civilians/ingest.py --out data/cit-civilians.db --reparse

TWO THINGS THIS SCRIPT DOES THAT THE OTHER TELEGRAM INGESTS DON'T:

1. **Stitching.** A long summary exceeds Telegram's 4096-character limit and
   CIT continues it in the next post — the corrections and the closing total
   routinely land there (post 10889 → 10890). A summary is therefore stored
   under its head post_id with `part_ids` naming every post it was assembled
   from.

2. **Reconciliation.** Every post closes with its own total ("…как минимум о 26
   погибших и 165 пострадавших"). The stored `stated_killed` / `stated_injured`
   come from that line, and `reconciled` records whether the parsed region rows
   add up to it. They agree on about 56% of posts; the rest are the older prose
   era and a handful where CIT's own arithmetic differs from its own breakdown.
   **The charting series is `stated_*`, which parses on ~96% of posts** — the
   region rows are the secondary breakdown, and `reconciled` says when to trust
   them. See README.md.

Storage is append-on-change, mirroring scripts/rubikon and scripts/sbu_alfa:
PRIMARY KEY (post_id, scraped_at). A post CIT later edits inserts a new
versioned row instead of overwriting; reads resolve the latest scraped_at per
post via the `*_latest` views. A re-scrape that parses identically inserts
nothing.
"""
from __future__ import annotations

import argparse
import hashlib
import os
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))
if str(SCRIPT_DIR.parent) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR.parent))

from ingest_log import ann, get_logger  # noqa: E402
from parse import (  # noqa: E402
    TYPE_DAILY, TYPE_WEEKEND, ParsedReport, is_summary, parse,
)

SUMMARY_TYPES = (TYPE_DAILY, TYPE_WEEKEND)

log = get_logger("cit-civilians")

CHANNEL = os.environ.get("CIT_CHANNEL", "CIT_shellings")
DEFAULT_DB = Path("data") / os.environ.get("CIT_DB_NAME", "cit-civilians.db")
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/124.0.0.0 Safari/537.36")

# The channel posts ~20 times a day and the summary is one of them, so one
# preview page is roughly one day. Four covers CI's daily cadence with slack.
DEFAULT_PAGES = 4
# Backfill: ~10,800 posts from the first summary (2023-10-16) to now, 20 per
# page. Generous headroom; the walk stops at the channel start regardless.
DEFAULT_BACKFILL_PAGES = 700

# A post this long was cut by Telegram's 4096-char limit and is continued in
# the next one. Shorter posts are never stitched, which is what stops a
# detail post from being glued onto a complete summary.
SPLIT_THRESHOLD = 3000
MAX_PARTS = 3


# ── schema ──────────────────────────────────────────────────────────────────
# `reports.body_text` keeps the stitched post text so a later parser fix can be
# applied with `--reparse` instead of re-scraping (CLAUDE.md: a re-scrape
# re-ingests identical text and changes nothing).
SCHEMA = """
CREATE TABLE IF NOT EXISTS reports (
  post_id        INTEGER NOT NULL,  -- head post of the summary
  scraped_at     TEXT NOT NULL,     -- UTC ISO8601, our ingest timestamp
  posted_at      TEXT NOT NULL,     -- UTC ISO8601, the Telegram post timestamp
  part_ids       TEXT NOT NULL,     -- '10889,10890' — every post stitched in
  url            TEXT NOT NULL,
  report_type    TEXT NOT NULL,     -- 'daily_summary' | 'weekend_summary'
  window_days    INTEGER NOT NULL,  -- 1, or 2 for a weekend post (48h bucket)
  window_start   TEXT,              -- UTC ISO8601 of "20:00 DD.MM.YYYY –"
  window_end     TEXT,              -- UTC ISO8601 of "– 20:00 DD.MM.YYYY"
  report_date    TEXT NOT NULL,     -- 'YYYY-MM-DD', MSK date of window_end
  date_basis     TEXT NOT NULL,     -- 'window' | 'post_time' (2023 era)
  stated_killed  INTEGER,           -- from the closing "Таким образом" line
  stated_injured INTEGER,
  sum_killed     INTEGER NOT NULL,  -- parsed daily + amendment rows
  sum_injured    INTEGER NOT NULL,
  reconciled     INTEGER,           -- 1 agree / 0 differ / NULL no total line
  body_text      TEXT NOT NULL,
  text_hash      TEXT NOT NULL,     -- sha256 of body_text; cheap edit detector
  PRIMARY KEY (post_id, scraped_at)
);
CREATE INDEX IF NOT EXISTS ix_reports_date ON reports (report_date);

CREATE TABLE IF NOT EXISTS casualties (
  post_id     INTEGER NOT NULL,
  scraped_at  TEXT NOT NULL,
  seq         INTEGER NOT NULL,  -- ordinal within the post; keeps source order
  -- 'daily'      the window's own regional rows
  -- 'amendment'  casualties learned today for an EARLIER date; additive, and
  --              counted in CIT's own headline total
  -- 'adjustment' a correction CIT does NOT count in that headline: a
  --              retraction, a downward restatement, or our own −1 injured
  --              when someone already counted as injured has died
  kind        TEXT NOT NULL,
  event_date  TEXT,              -- 'YYYY-MM-DD'; NULL when indivisibly multi-dated
  event_dates TEXT,              -- comma-joined list when several were named
  date_basis  TEXT NOT NULL,     -- window|post_time|explicit|split|multi|unknown
  region_key  TEXT NOT NULL,     -- slug, 'unknown' when no region was matched
  region_raw  TEXT NOT NULL,     -- verbatim Russian phrase, for audit
  occupied    INTEGER,           -- 1 occupied / 0 gov-controlled / NULL unstated
  country     TEXT,              -- 'UA' | 'RU' | NULL for an unknown region
  killed      INTEGER NOT NULL,  -- signed; negative on an adjustment
  injured     INTEGER NOT NULL,  -- signed
  count_inferred INTEGER NOT NULL DEFAULT 0,  -- count came from a bare noun
  reason      TEXT,              -- excluded_by_source|restated_by_source|died_of_wounds
  raw_label   TEXT NOT NULL,
  PRIMARY KEY (post_id, scraped_at, seq),
  FOREIGN KEY (post_id, scraped_at) REFERENCES reports (post_id, scraped_at)
);
CREATE INDEX IF NOT EXISTS ix_casualties_event ON casualties (event_date);
CREATE INDEX IF NOT EXISTS ix_casualties_region ON casualties (region_key);

-- Latest stored version of each post.
CREATE VIEW IF NOT EXISTS reports_latest AS
  SELECT r.* FROM reports r
  JOIN (SELECT post_id, MAX(scraped_at) AS ms FROM reports GROUP BY post_id) l
    ON r.post_id = l.post_id AND r.scraped_at = l.ms;

CREATE VIEW IF NOT EXISTS casualties_latest AS
  SELECT c.* FROM casualties c
  JOIN (SELECT post_id, MAX(scraped_at) AS ms FROM reports GROUP BY post_id) l
    ON c.post_id = l.post_id AND c.scraped_at = l.ms;

-- THE HEADLINE SERIES. CIT's own figure for each report day, straight off the
-- post's closing sentence. This is what the charts plot: it parses on ~96% of
-- posts and never depends on the regional breakdown being complete.
CREATE VIEW IF NOT EXISTS daily_stated AS
  SELECT report_date, post_id, stated_killed AS killed, stated_injured AS injured,
         reconciled, date_basis, report_type, window_days
  FROM reports_latest
  WHERE stated_killed IS NOT NULL OR stated_injured IS NOT NULL;

-- As first reported: the region rows for each report window, nothing else.
CREATE VIEW IF NOT EXISTS daily_reported AS
  SELECT event_date, SUM(killed) AS killed, SUM(injured) AS injured
  FROM casualties_latest WHERE kind = 'daily' AND event_date IS NOT NULL
  GROUP BY event_date;

-- Revised: what we now believe happened on each day, once later corrections
-- are folded back onto the date they belong to. This is the multi-post row —
-- derived, so it can never go stale, and it names its sources.
CREATE VIEW IF NOT EXISTS daily_revised AS
  SELECT event_date,
         SUM(killed) AS killed,
         SUM(injured) AS injured,
         COUNT(DISTINCT post_id) AS source_post_count,
         group_concat(DISTINCT post_id) AS source_post_ids
  FROM casualties_latest WHERE event_date IS NOT NULL
  GROUP BY event_date;

-- Corrections that name several dates indivisibly ("ещё семи пострадавших за
-- 26, 28 и 30 августа" — 7 people, 3 days). Surfaced rather than dropped, so
-- a chart can show them as an unattributed band instead of pretending.
CREATE VIEW IF NOT EXISTS corrections_unattributed AS
  SELECT post_id, seq, kind, event_dates, region_key, killed, injured, raw_label
  FROM casualties_latest WHERE event_date IS NULL;
"""


# ── web backend (t.me/s preview) ────────────────────────────────────────────
# Same shape as scripts/rubikon/ingest.py's parser. Kept local so the scrapers
# can drift independently.
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

    t.me drops the TLS connection every so often, and a `--backfill` walk makes
    hundreds of requests — often enough that a single-shot fetch reliably dies
    part-way through. Exponential backoff on transport errors only; an HTTP
    status error is surfaced immediately since retrying it won't help.
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
            log.info("retrying %s in %.0fs after %s: %s", url, wait, type(e).__name__, e)
            time.sleep(wait)
    assert last is not None
    raise last


def _is_continuation(text: str) -> bool:
    """Does this post look like the tail of a summary that overran 4096 chars?

    Deliberately narrow. The channel's ~20 other posts a day include detail
    write-ups that open with region headings, so a loose test would glue one
    onto a complete summary and inflate the day by dozens of casualties.
    """
    head = text.lstrip()[:40]
    if is_summary(text):
        return False              # a new summary, not a continuation
    if head.startswith(("Обстрелы", "Удары", "Апдейты", "–", "—", "-")):
        return False              # the detail post and its siblings
    return (head.startswith(("Кроме того", "Помимо этого", "Таким образом"))
            or "Таким образом" in text)


def iter_summaries(channel: str, since_id: int, max_pages: int, sleep: float,
                   backfill: bool):
    """Yield (head_post_id, part_ids, posted_at_utc, stitched_text), newest first.

    Incremental (default): stop once we page past `since_id`, already stored.
    Backfill: walk until max_pages or the channel start.
    """
    base = f"https://t.me/s/{channel}"
    before: str | None = None
    seen: set[int] = set()
    for _ in range(max_pages):
        url = base + (f"?before={before}" if before else "")
        p = _TgParser()
        p.feed(_fetch(url))
        posts = {int(x["id"]): x for x in p.posts if x["id"].isdigit()}
        if not posts:
            break
        page_ids = sorted(posts)
        reached_known = False
        for pid in reversed(page_ids):           # newest first within the page
            if pid in seen:
                continue
            seen.add(pid)
            post = posts[pid]
            text = "".join(post["text"])
            if not is_summary(text):
                continue
            if not backfill and pid <= since_id:
                reached_known = True
                continue
            if not post["dt"]:
                continue
            body, parts = text, [pid]
            # Stitch continuations. Bounded by MAX_PARTS so a run of
            # unexpected posts can't swallow the rest of the page.
            while ("Таким образом" not in body and len(body) >= SPLIT_THRESHOLD
                   and len(parts) < MAX_PARTS):
                nxt = posts.get(parts[-1] + 1)
                if nxt is None:
                    # The continuation is on the next page (a page boundary
                    # fell mid-summary). Losing the tail would drop the total
                    # and the corrections, so say so rather than store a
                    # truncated report.
                    log.warning(
                        "post %s looks truncated (%d chars, no closing total) and its "
                        "continuation is not on this page — re-run with a wider "
                        "--max-pages to capture it",
                        pid, len(body),
                        extra=ann(title="CIT: summary split across a page boundary"))
                    break
                nxt_text = "".join(nxt["text"])
                if not _is_continuation(nxt_text):
                    break
                body += "\n\n" + nxt_text
                parts.append(parts[-1] + 1)
                seen.add(parts[-1])
            dt = datetime.fromisoformat(post["dt"]).astimezone(timezone.utc)
            yield pid, parts, dt, body
        if reached_known and not backfill:
            break
        before = p.next_before or str(min(page_ids))
        time.sleep(sleep)


# ── storage ─────────────────────────────────────────────────────────────────

def _signature(report: ParsedReport) -> tuple:
    """Hashable shape used to decide whether a re-parse changed anything."""
    return (report.report_date, report.stated_killed, report.stated_injured,
            tuple((r.kind, r.event_date, r.region_key, r.occupied, r.killed,
                   r.injured, r.reason) for r in report.rows))


def _stored_signature(conn: sqlite3.Connection, post_id: int, scraped_at: str) -> tuple:
    head = conn.execute(
        "SELECT report_date, stated_killed, stated_injured FROM reports "
        "WHERE post_id = ? AND scraped_at = ?", (post_id, scraped_at)).fetchone()
    rows = conn.execute(
        "SELECT kind, event_date, region_key, occupied, killed, injured, reason "
        "FROM casualties WHERE post_id = ? AND scraped_at = ? ORDER BY seq",
        (post_id, scraped_at)).fetchall()
    return (head[0], head[1], head[2], tuple(tuple(r) for r in rows)) if head else ()


def _connect(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.executescript(SCHEMA)
    return conn


def _max_post_id(conn: sqlite3.Connection) -> int:
    row = conn.execute("SELECT MAX(post_id) FROM reports").fetchone()
    return int(row[0]) if row and row[0] is not None else 0


def store(conn: sqlite3.Connection, post_id: int, parts: list[int],
          posted_at: datetime, text: str, report: ParsedReport,
          channel: str) -> str:
    """Insert a new version of one summary. 'inserted'|'updated'|'unchanged'."""
    scraped_at = datetime.now(timezone.utc).isoformat(timespec="microseconds")
    prior = conn.execute(
        "SELECT scraped_at FROM reports WHERE post_id = ? ORDER BY scraped_at DESC LIMIT 1",
        (post_id,)).fetchone()
    if prior:
        if _stored_signature(conn, post_id, prior[0]) == _signature(report):
            return "unchanged"
        status = "updated"
    else:
        status = "inserted"

    reconciled = report.reconciled
    conn.execute(
        "INSERT INTO reports (post_id, scraped_at, posted_at, part_ids, url, "
        "report_type, window_days, window_start, window_end, report_date, "
        "date_basis, stated_killed, stated_injured, sum_killed, sum_injured, "
        "reconciled, body_text, text_hash) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (post_id, scraped_at,
         posted_at.astimezone(timezone.utc).isoformat(timespec="seconds"),
         ",".join(str(p) for p in parts),
         f"https://t.me/{channel}/{post_id}",
         report.report_type, report.window_days, report.window_start, report.window_end, report.report_date,
         report.date_basis, report.stated_killed, report.stated_injured,
         report.sum_killed, report.sum_injured,
         None if reconciled is None else int(reconciled),
         text, hashlib.sha256(text.encode("utf-8")).hexdigest()))
    for seq, row in enumerate(report.rows):
        conn.execute(
            "INSERT INTO casualties (post_id, scraped_at, seq, kind, event_date, "
            "event_dates, date_basis, region_key, region_raw, occupied, country, "
            "killed, injured, count_inferred, reason, raw_label) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (post_id, scraped_at, seq, row.kind, row.event_date, row.event_dates,
             row.date_basis, row.region_key, row.region_raw, row.occupied,
             row.country, row.killed, row.injured, row.count_inferred,
             row.reason, row.raw_label))
    conn.commit()
    return status


# ── reporting ───────────────────────────────────────────────────────────────

def _warn(post_id: int, report: ParsedReport) -> None:
    """Surface drift and source oddities instead of dropping them silently."""
    if report.unmatched:
        log.warning(
            "post %s has %d paragraph(s) no region matcher claimed — a new or "
            "renamed region? Add a pattern in scripts/cit_civilians/parse.py, "
            "then re-run with --reparse: %s",
            post_id, len(report.unmatched), report.unmatched,
            extra=ann(title="CIT: unrecognised region paragraph"))
    if report.reconciled is False:
        log.warning(
            "post %s does not reconcile: parsed %d killed / %d injured, the post "
            "itself says %s / %s. The headline figures are stored either way and "
            "are what the charts use; the regional breakdown for this day is the "
            "part in doubt.",
            post_id, report.sum_killed, report.sum_injured,
            report.stated_killed, report.stated_injured,
            extra=ann(level="notice", title="CIT: breakdown disagrees with the post's own total"))
    for w in report.warnings:
        log.warning("post %s: %s", post_id, w,
                    extra=ann(level="notice", title="CIT: source oddity"))


def _emit_changed(changed: bool) -> None:
    """Tell the workflow whether to re-upload, so a no-op run doesn't bust the
    CDN cache."""
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a", encoding="utf-8") as fh:
            fh.write(f"changed={'true' if changed else 'false'}\n")


# ── modes ───────────────────────────────────────────────────────────────────

def run_scrape(args: argparse.Namespace) -> int:
    conn = _connect(args.out)
    try:
        since_id = 0 if args.backfill else _max_post_id(conn)
        max_pages = args.max_pages or (
            DEFAULT_BACKFILL_PAGES if args.backfill else DEFAULT_PAGES)
        counts = {"inserted": 0, "updated": 0, "unchanged": 0}
        scanned = reconciled = checkable = 0
        for post_id, parts, posted_at, text in iter_summaries(
                args.channel, since_id, max_pages, args.sleep, args.backfill):
            report = parse(text, posted_at)
            if report.report_type not in SUMMARY_TYPES:
                continue
            scanned += 1
            if report.reconciled is not None:
                checkable += 1
                reconciled += int(report.reconciled)
            _warn(post_id, report)
            status = store(conn, post_id, parts, posted_at, text, report, args.channel)
            counts[status] += 1
            log.info("%s: %s/%s → %s (%d rows, stated %s/%s)", status, args.channel,
                     post_id, report.report_date, len(report.rows),
                     report.stated_killed, report.stated_injured)
        log.info("scanned %d summary post(s) over ≤%d page(s); %d inserted, "
                 "%d updated, %d unchanged; %d/%d reconciled with the post's own total",
                 scanned, max_pages, counts["inserted"], counts["updated"],
                 counts["unchanged"], reconciled, checkable)
        _emit_changed(counts["inserted"] + counts["updated"] > 0)
        return 0
    finally:
        conn.close()


def run_reparse(args: argparse.Namespace) -> int:
    """Re-run the parser over already-stored post text.

    A widened scrape only helps for posts the parser DROPPED. When a fix changes
    how stored text is READ, the stored rows need re-parsing — that's this.
    Dry-run unless --apply is passed (mirrors reparse-gsua-db.yml, whose
    `dry_run` input defaults to on).
    """
    if not args.out.exists():
        log.error("%s does not exist", args.out)
        return 1
    dry_run = not args.apply
    conn = _connect(args.out)
    try:
        rows = conn.execute(
            "SELECT post_id, part_ids, posted_at, body_text FROM reports_latest "
            "ORDER BY post_id").fetchall()
        changed = unchanged = 0
        reconciled = checkable = 0
        for post_id, part_ids, posted_at, body_text in rows:
            report = parse(body_text, datetime.fromisoformat(posted_at))
            if report.report_type not in SUMMARY_TYPES:
                log.warning("stored post %s no longer parses as a daily summary — "
                            "leaving it untouched", post_id,
                            extra=ann(title="CIT: stored post stopped parsing"))
                continue
            if report.reconciled is not None:
                checkable += 1
                reconciled += int(report.reconciled)
            _warn(post_id, report)
            if dry_run:
                prior = conn.execute(
                    "SELECT MAX(scraped_at) FROM reports WHERE post_id = ?",
                    (post_id,)).fetchone()[0]
                differs = _stored_signature(conn, post_id, prior) != _signature(report)
                changed += differs
                unchanged += not differs
                log.info("%s: %s → %s (%d rows)",
                         "would update" if differs else "unchanged",
                         post_id, report.report_date, len(report.rows))
                continue
            status = store(conn, post_id, [int(p) for p in part_ids.split(",")],
                           datetime.fromisoformat(posted_at), body_text, report,
                           args.channel)
            changed += status != "unchanged"
            unchanged += status == "unchanged"
            log.info("%s: %s → %s (%d rows)", status, post_id, report.report_date,
                     len(report.rows))
        log.info("reparsed %d stored post(s); %d changed, %d unchanged; "
                 "%d/%d reconciled%s", len(rows), changed, unchanged,
                 reconciled, checkable,
                 " (dry run — nothing written; re-run with --apply)" if dry_run else "")
        _emit_changed(not dry_run and changed > 0)
        return 0
    finally:
        conn.close()


# ── CLI ─────────────────────────────────────────────────────────────────────

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, default=DEFAULT_DB,
                    help=f"DB path (default: {DEFAULT_DB})")
    ap.add_argument("--channel", default=CHANNEL,
                    help=f"Telegram channel (default: {CHANNEL})")
    ap.add_argument("--backfill", action="store_true",
                    help="walk the whole channel history instead of stopping at "
                         "the newest stored post")
    ap.add_argument("--max-pages", type=int, default=None,
                    help=f"page cap (default: {DEFAULT_PAGES} incremental, "
                         f"{DEFAULT_BACKFILL_PAGES} backfill)")
    ap.add_argument("--sleep", type=float, default=0.5,
                    help="delay between preview pages (default: 0.5s)")
    ap.add_argument("--reparse", action="store_true",
                    help="re-parse stored post text instead of scraping")
    ap.add_argument("--apply", action="store_true",
                    help="with --reparse: actually write the re-parsed rows "
                         "(default: dry run)")
    args = ap.parse_args(argv)

    if args.reparse:
        return run_reparse(args)
    if args.apply:
        ap.error("--apply only applies to --reparse")
    return run_scrape(args)


if __name__ == "__main__":
    raise SystemExit(main())
