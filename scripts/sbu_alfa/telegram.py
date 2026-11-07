#!/usr/bin/env python3
"""
telegram.py — find SBU "Альфа" monthly recaps on SBU's Telegram channel and
ingest the ones not yet stored. What the scheduled workflow runs.

SBU posts each recap to t.me/SBUkr the same day as the press release on
ssu.gov.ua, with the same counter list. The channel is the sturdier source:
ssu.gov.ua sits behind Akamai, which refuses the news listing (and has
tightened its rules before — see README "Source quirks"), while the public
t.me/s web preview is plain HTML with no account and no bot wall. A post is
stored under its own URL, https://t.me/SBUkr/<id> — that is the source the
page links to — beside any article rows already in the DB; the frontend reads
one report per month (useDatabaseSbuAlfa).

How a recap is found: walk the channel newest-first back to the newest post
already stored, and keep the posts that pass parse.is_monthly_recap — a month
AND a recap's worth of counters. Nothing about the wording is assumed beyond
what the parser needs, so a month the unit isn't TOP-1 is still found. The
channel's search would be cheaper but isn't exhaustive ("Альфа" returns ~20
posts back to July), so it can't be the gate. At ~8 posts a day the walk is
~12 preview pages a month back.

Typical use:

    # incremental — what CI runs; stops at the newest stored post
    python3 scripts/sbu_alfa/telegram.py --out data/sbu-alfa.db

    # look further back (a recap missed while the walk was broken)
    python3 scripts/sbu_alfa/telegram.py --out data/sbu-alfa.db --pages 60 --rescan

One post by hand: `ingest.py https://t.me/SBUkr/<id>`.

stdlib only.
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from zoneinfo import ZoneInfo

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import ingest  # noqa: E402
from ingest_log import ann  # noqa: E402
from parse import extract_text, is_monthly_recap, parse  # noqa: E402

CHANNEL = "SBUkr"
POST_URL_PREFIX = f"https://t.me/{CHANNEL}/"

# Incremental: the walk stops at the newest stored post — last month's recap,
# ~30 days and ~12 pages back. The cap matters only when it is further back
# than that: a skipped month, or the first run against a DB holding articles
# only, which walks the cap and picks up the last couple of recaps.
DEFAULT_PAGES = 25

KYIV = ZoneInfo("Europe/Kyiv")


# ── web backend (t.me/s preview) ────────────────────────────────────────────
# scripts/zelensky_weekly's walker (itself scripts/rubikon's), copied rather
# than imported: every one of these directories has an ingest.py and a
# parse.py, so importing across them shadows one with the other.
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
    """GET with retries on transport errors — t.me drops the TLS connection
    mid-handshake every so often. An HTTP status error is raised at once."""
    last: Exception | None = None
    for attempt in range(attempts):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": ingest.UA})
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError:
            raise
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            last = e
            if attempt == attempts - 1:
                break
            time.sleep(backoff * (2 ** attempt))
    assert last is not None
    raise last


def posts_on_page(html: str) -> tuple[list[tuple[int, datetime, str]], str | None]:
    """(post_id, posted_at UTC, text) for each post on one preview page, and
    the cursor to the page before it."""
    p = _TgParser()
    p.feed(html)
    out = []
    for post in p.posts:
        if post["id"].isdigit() and post["dt"]:
            dt = datetime.fromisoformat(post["dt"]).astimezone(timezone.utc)
            out.append((int(post["id"]), dt, "".join(post["text"])))
    return out, p.next_before


def iter_channel(since_id: int, max_pages: int, sleep: float = 1.0):
    """Yield (post_id, posted_at, text), newest first, down to `since_id`
    (exclusive) or `max_pages` pages, whichever comes first."""
    before: str | None = None
    seen: set[int] = set()
    for _ in range(max_pages):
        url = f"https://t.me/s/{CHANNEL}" + (f"?before={before}" if before else "")
        posts, next_before = posts_on_page(_fetch(url))
        if not posts:
            break
        reached_known = False
        for pid, dt, text in posts:
            if pid in seen:
                continue
            seen.add(pid)
            if pid <= since_id:
                reached_known = True
                continue
            yield pid, dt, text
        if reached_known:
            break
        before = next_before or str(min(pid for pid, _, _ in posts))
        time.sleep(sleep)


def fetch_post(url: str) -> tuple[datetime, str]:
    """One post by its URL (https://t.me/SBUkr/<id>): (posted_at, text). The
    preview page for a post id shows it among its neighbours."""
    pid = int(url.rstrip("/").rsplit("/", 1)[-1])
    posts, _ = posts_on_page(_fetch(f"https://t.me/s/{CHANNEL}/{pid}"))
    for p_id, dt, text in posts:
        if p_id == pid:
            return dt, text
    raise LookupError(f"post {pid} not on its preview page — deleted, or not a text post")


def is_post_url(source: str) -> bool:
    return source.startswith(("https://t.me/", "http://t.me/"))


# ── storage ─────────────────────────────────────────────────────────────────

def kyiv_date(dt: datetime) -> str:
    return dt.astimezone(KYIV).date().isoformat()


def title_of(text: str) -> str:
    """The post's first line — its headline."""
    return next((ln.strip() for ln in text.splitlines() if ln.strip()), "")[:200]


def newest_stored_post(db_path: Path) -> int:
    """Newest channel post id already in the DB; 0 if none (or no DB yet)."""
    if not db_path.exists():
        return 0
    conn = sqlite3.connect(db_path)
    try:
        urls = conn.execute(
            "SELECT DISTINCT url FROM reports WHERE url LIKE ?", (POST_URL_PREFIX + "%",),
        ).fetchall()
    except sqlite3.OperationalError:
        return 0
    finally:
        conn.close()
    ids = [int(u.rsplit("/", 1)[-1]) for (u,) in urls if u.rsplit("/", 1)[-1].isdigit()]
    return max(ids, default=0)


def store_post(out: Path, pid: int, posted_at: datetime, text: str, dry_run: bool) -> str:
    """Parse one post and store it if it is a recap. Returns a status string:
    'not-a-recap', 'dry-run', or ingest.store()'s inserted/updated/unchanged."""
    url = POST_URL_PREFIX + str(pid)
    published_at = kyiv_date(posted_at)
    report = parse(extract_text(text), published_at)
    if not is_monthly_recap(report):
        return "not-a-recap"
    ingest.warn_unmatched(url, report)
    tag = f"period={report.period} counters={len(report.counters)}"
    if dry_run:
        print(f"[dry ] {url} ({tag}) {title_of(text)!r}")
        return "dry-run"
    status = ingest.store(out, url, text.encode("utf-8"), report, title_of(text), published_at)
    print(f"[{status:>8}] {url} ({tag}) {title_of(text)!r}")
    return status


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, default=ingest.DEFAULT_DB,
                    help=f"DB path (default: {ingest.DEFAULT_DB})")
    ap.add_argument("--pages", type=int, default=DEFAULT_PAGES,
                    help=f"most preview pages to walk (default: {DEFAULT_PAGES}, ~2 months)")
    ap.add_argument("--rescan", action="store_true",
                    help="walk the full --pages, past the newest stored post")
    ap.add_argument("--dry-run", action="store_true", help="report recaps found, don't write")
    args = ap.parse_args(argv)

    since = 0 if args.rescan else newest_stored_post(args.out)
    counts: dict[str, int] = {}
    walked = 0
    try:
        for pid, posted_at, text in iter_channel(since, args.pages):
            walked += 1
            status = store_post(args.out, pid, posted_at, text, args.dry_run)
            counts[status] = counts.get(status, 0) + 1
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        # A dead walk otherwise reads as a quiet "nothing new" run.
        ingest.log.warning(
            "t.me/s/%s walk failed after %d post(s): %r", CHANNEL, walked, e,
            extra=ann(title="sbu-alfa: Telegram walk failed"),
        )
    print(f"\n[done] walked {walked} post(s) newer than {since or '(none stored)'}: {counts}")
    ingest._emit_changed(counts.get("inserted", 0) + counts.get("updated", 0) > 0)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
