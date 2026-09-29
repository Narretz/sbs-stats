#!/usr/bin/env python3
"""
ingest.py — build data/zelensky-weekly.db from the President's weekly strike tally.

Source: @V_Zelenskiy_official, the President of Ukraine's Telegram channel.
Most Sundays one post closes with the week's Russian strikes on Ukraine in
three counters — strike drones, guided aerial bombs (КАБ), missiles. See
parse.py for the sentence shapes and why the week's dates are derived rather
than read. (The `V_Zelenskiy` slug is not a usable preview; the official one
is.)

Why it is worth a series of its own: the guided-bomb count is the one weekly
official figure for КАБs at all — the Air Force data behind
ru-air-attacks-gsua has none — and the drone/missile counts are a second,
rounded official figure for the same weeks the Air Force reports daily.

Backend: the public **t.me/s web preview** — plain HTTP + HTML, no Telegram API
account, stdlib only. The page walker is a copy of scripts/rubikon's.

Typical use:

    # incremental — what CI runs; stops at the newest post already stored
    python3 scripts/zelensky_weekly/ingest.py --out data/zelensky-weekly.db

    # historical backfill — the channel is ~20k posts, ~1,100 preview pages
    python3 scripts/zelensky_weekly/ingest.py --out data/zelensky-weekly.db --backfill

    # re-parse already-stored post text after a parser fix (no re-fetch).
    # Dry run by default — add --apply to write.
    python3 scripts/zelensky_weekly/ingest.py --out data/zelensky-weekly.db --reparse

Storage is append-on-change, like scripts/rubikon: PRIMARY KEY (post_id,
scraped_at); a post whose re-read changes anything (an edit, a parser fix)
inserts a new version, reads resolve the latest via the `*_latest` views, and
the `weekly` view picks one tally per week. Only tally posts are stored — the
channel's other ~500 posts a month are skipped without a trace.
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
# Shared diagnostics sink (scripts/ingest_log.py); `scripts/` isn't a package.
if str(SCRIPT_DIR.parent) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR.parent))

from ingest_log import ann, excerpt, get_logger  # noqa: E402
from parse import Report, parse  # noqa: E402

log = get_logger("zelensky-weekly")

UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
CHANNEL = os.environ.get("ZELENSKY_CHANNEL", "V_Zelenskiy_official")
DEFAULT_DB = Path("data") / os.environ.get("ZELENSKY_WEEKLY_DB_NAME", "zelensky-weekly.db")

# Incremental: the walk stops at the newest stored post — the previous week's
# tally, ~7 days and ~6 preview pages back on this channel (~17 posts/day,
# ~20 per page). The cap only matters when that post is further back than
# usual (a skipped week, a first run on an empty DB).
DEFAULT_PAGES = 15
# Backfill: the whole channel, ~21k posts at the time of writing.
DEFAULT_BACKFILL_PAGES = 1500

SCHEMA = (SCRIPT_DIR / "schema.sql").read_text(encoding="utf-8")


# ── web backend (t.me/s preview) ────────────────────────────────────────────
# scripts/rubikon's walker, copied rather than imported: both directories have
# an ingest.py and a parse.py, so importing across them shadows one `parse`
# with the other (see scripts/test_python.sh), and the scrapers are meant to be
# free to drift apart. It keeps <br> as "\n", which parse.py splits on.
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


# ── storage ─────────────────────────────────────────────────────────────────

def _signature(report: Report) -> tuple:
    """Everything a re-read can change that a reader would see."""
    return (
        report.report_type, report.period,
        tuple(sorted((c.category, c.value, c.bound) for c in report.counters)),
    )


def _stored_signature(conn: sqlite3.Connection, post_id: int, scraped_at: str) -> tuple:
    rtype, period = conn.execute(
        "SELECT report_type, period FROM reports WHERE post_id = ? AND scraped_at = ?",
        (post_id, scraped_at),
    ).fetchone()
    counters = conn.execute(
        "SELECT category, value, bound FROM counters WHERE post_id = ? AND scraped_at = ?",
        (post_id, scraped_at),
    ).fetchall()
    return rtype, period, tuple(sorted(counters))


def _connect(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.executescript(SCHEMA)
    return conn


def _max_post_id(conn: sqlite3.Connection) -> int:
    row = conn.execute("SELECT MAX(post_id) FROM reports").fetchone()
    return int(row[0]) if row and row[0] is not None else 0


def store(
    conn: sqlite3.Connection,
    post_id: int,
    posted_at: datetime,
    text: str,
    report: Report,
    channel: str,
) -> str:
    """Insert a new version of one post. Returns 'inserted'|'updated'|'unchanged'."""
    prior = conn.execute(
        "SELECT scraped_at FROM reports WHERE post_id = ? ORDER BY scraped_at DESC LIMIT 1",
        (post_id,),
    ).fetchone()
    if prior:
        if _stored_signature(conn, post_id, prior[0]) == _signature(report):
            return "unchanged"
        status = "updated"
    else:
        status = "inserted"

    scraped_at = datetime.now(timezone.utc).isoformat(timespec="microseconds")
    conn.execute(
        "INSERT INTO reports (post_id, scraped_at, posted_at, report_type, lang, week_ref, "
        "period, period_start, period_end, url, tally_text, body_text, text_hash) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            post_id, scraped_at,
            posted_at.astimezone(timezone.utc).isoformat(timespec="seconds"),
            report.report_type, report.lang, report.week_ref,
            report.period, report.period_start, report.period_end,
            f"https://t.me/{channel}/{post_id}", report.sentence, text,
            hashlib.sha256(text.encode("utf-8")).hexdigest(),
        ),
    )
    for c in report.counters:
        conn.execute(
            "INSERT INTO counters (post_id, scraped_at, category, value, bound, qualifier, raw_label) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (post_id, scraped_at, c.category, c.value, c.bound, c.qualifier, c.raw_label),
        )
    conn.commit()
    return status


# ── reporting ───────────────────────────────────────────────────────────────

def _describe(report: Report) -> str:
    counts = ", ".join(f"{c.category}={c.value}" for c in report.counters)
    return f"{report.report_type} {report.period} ({counts})"


def _warn(post_id: int, report: Report) -> None:
    """Source oddities, never fatal — failing would skip the upload and lose
    the week over one unread counter."""
    for w in report.warnings:
        log.warning(
            f"post {post_id}: {w}: {excerpt(report.sentence)}",
            extra=ann(title="zelensky-weekly: tally not fully read",
                      file="scripts/zelensky_weekly/parse.py"),
        )


def _emit_changed(changed: bool) -> None:
    """Tell the workflow whether to re-upload (most runs find nothing new)."""
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a", encoding="utf-8") as fh:
            fh.write(f"changed={'true' if changed else 'false'}\n")


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
            report = parse(text, posted_at)
            if report.report_type == "unknown":
                continue
            _warn(post_id, report)
            status = store(conn, post_id, posted_at, text, report, args.channel)
            counts[status] += 1
            print(f"{status}: {args.channel}/{post_id} → {_describe(report)}")
        print(f"scanned {scanned} post(s) over ≤{max_pages} page(s); "
              f"{counts['inserted']} inserted, {counts['updated']} updated, "
              f"{counts['unchanged']} unchanged")
        _emit_changed(counts["inserted"] + counts["updated"] > 0)
        return 0
    finally:
        conn.close()


def run_reparse(args: argparse.Namespace) -> int:
    """Re-run the parser over already-stored post text. Dry run unless --apply.

    Only posts that parsed once are stored, so this can correct a tally or
    re-date it, but cannot find a tally the parser missed at scrape time —
    that needs a re-scrape (`--backfill`, or a wider `--max-pages`).
    """
    dry_run = not args.apply
    if not args.out.exists():
        print(f"ERROR: {args.out} does not exist", file=sys.stderr)
        return 1
    conn = _connect(args.out)
    try:
        rows = conn.execute(
            "SELECT post_id, posted_at, body_text, scraped_at FROM reports_latest ORDER BY post_id"
        ).fetchall()
        changed = 0
        for post_id, posted_at, body_text, scraped_at in rows:
            posted = datetime.fromisoformat(posted_at)
            report = parse(body_text, posted)
            if report.report_type == "unknown":
                log.warning(
                    f"stored post {post_id} no longer parses as a weekly tally — "
                    f"leaving it untouched: {excerpt(body_text)}",
                    extra=ann(title="zelensky-weekly: stored post stopped parsing"),
                )
                continue
            _warn(post_id, report)
            if _stored_signature(conn, post_id, scraped_at) == _signature(report):
                continue
            changed += 1
            if dry_run:
                print(f"would update: {post_id} → {_describe(report)}")
            else:
                store(conn, post_id, posted, body_text, report, args.channel)
                print(f"updated: {post_id} → {_describe(report)}")
        print(f"reparsed {len(rows)} stored post(s); {changed} changed"
              + (" (dry run — nothing written; re-run with --apply)" if dry_run else ""))
        _emit_changed(not dry_run and changed > 0)
        return 0
    finally:
        conn.close()


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
                    help="re-parse stored post text instead of scraping (dry run unless --apply)")
    ap.add_argument("--apply", action="store_true", help="with --reparse: write the re-parsed rows")
    args = ap.parse_args(argv)

    if args.reparse:
        return run_reparse(args)
    if args.apply:
        ap.error("--apply only applies to --reparse")
    return run_scrape(args)


if __name__ == "__main__":
    raise SystemExit(main())
