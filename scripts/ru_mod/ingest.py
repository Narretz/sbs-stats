#!/usr/bin/env python3
"""
ingest.py — build the Russian-MoD air-defense drone-intercept DB (ru-mod-ad.db).

Source: the Russian MoD Telegram channel (@mod_russia). It posts ПВО reports of
the form "… дежурными средствами ПВО перехвачены и уничтожены N украинских
беспилотных летательных аппаратов … над территориями …". Two backends:

  --source web       (default) parses the public t.me/s/<channel> WEB PREVIEW —
                     plain HTTP + HTML, NO Telegram API account. Ideal for the
                     daily incremental pull from CI.
  --source telethon  uses the Telegram API (needs TELEGRAM_API_ID/HASH + a
                     session, same as scripts/gsua). Use for full historical
                     backfill, where the web preview is slow/rate-limited.

Both backends feed the SAME parser. Storage is append-only by post id: a post's
text is immutable, so we INSERT OR IGNORE keyed on the Telegram message id —
re-runs never duplicate or clobber. The frontend reads the `daily_ad` view.

Date model (see the MoD's own wording, all MSK):
  night   = "с 20.00 мск [D-1] до 7.00 мск [D]"   → window_end on D
  daytime = "с HH.00 до HH.00 мск"  (same day)     → window_end on D
We attribute each report to report_date = the MSK calendar date of its window
END, so the overnight report (which starts the previous evening) and that day's
daytime windows aggregate to the same date — tiling the 24h with a 20:00 MSK
boundary, no overlap under the normal pattern. Irregular merged windows can
overlap by a few hours; build logs any detected overlap rather than guessing.

These are UNVERIFIED claims, and "intercepted/downed" is a floor for "launched".
stdlib only for the web path (urllib + sqlite3 + html). telethon imported lazily.
"""
from __future__ import annotations

import argparse
import html
import os
import re
import sqlite3
import sys
import time
import urllib.request
from dataclasses import dataclass, field as dc_field
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser
from pathlib import Path

CHANNEL = os.environ.get("RU_MOD_CHANNEL", "mod_russia")
SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_DB_NAME = os.environ.get("RU_MOD_DB_NAME", "ru-mod-ad.db")
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"

MSK = timezone(timedelta(hours=3))  # Moscow time, no DST
MONTHS = {
    "января": 1, "февраля": 2, "марта": 3, "апреля": 4, "мая": 5, "июня": 6,
    "июля": 7, "августа": 8, "сентября": 9, "октября": 10, "ноября": 11, "декабря": 12,
}

# Count of Ukrainian UAVs intercepted (the metric).
COUNT_RE = re.compile(r"(\d+)\s+украин\w+\s+беспилотн\w+\s+летательн\w+\s+аппарат", re.I)
# Is this an air-defense intercept post at all?
AD_GATE = re.compile(r"(противовоздушн|средствами\s+пво|перехвач\w+\s+и\s+уничтож)", re.I)
# Explicit night range with dates: "с 20.00 мск 22 мая до 7.00 мск 23 мая"
NIGHT_DATED_RE = re.compile(
    r"с\s+(\d{1,2})[.:]\d{2}\s*мск\s+(\d{1,2})\s+(\w+)\s+до\s+(\d{1,2})[.:]\d{2}\s*мск\s+(\d{1,2})\s+(\w+)", re.I)
# Same-day range: "с 14.00 до 20.00 мск" and "с 7.00 мск до 15.00 мск"
# (the channel sometimes repeats "мск" after the start time).
DAY_RANGE_RE = re.compile(r"с\s+(\d{1,2})[.:]\d{2}\s*(?:мск\s*)?до\s+(\d{1,2})[.:]\d{2}\s*мск", re.I)
NIGHT_PHRASE_RE = re.compile(r"прошедш\w+\s+ноч|в\s+течение\s+ноч|минувш\w+\s+ноч", re.I)
REGION_RE = re.compile(r"над\s+территор\w+\s+(.*)", re.I)
# Itemized per-region breakdown line, e.g. "42 – над территорией Саратовской
# области," (dash may be -, –, —). The MoD uses this format on some days; on
# others it gives only a total + a region list (no per-region counts).
REGION_ITEM_RE = re.compile(
    r"(\d+)\s*[-–—]\s*над\s+территори\w+\s+([^,.;▫\d]+)", re.I)

MAX_PLAUSIBLE = 5000  # guard against a runaway parse

# MoD "Сводка о ходе проведения СВО" summary posts. In 2025 a weekly variant
# ("с DD month по DD month YYYY") carried cumulative Ukrainian *equipment* losses
# (no personnel); a daily variant uses "по состоянию на DD month YYYY". These
# appear to have stopped on the channel in 2026. We capture them RAW (header +
# full text) for later parsing — see DATASETS.md §3.
SVODKA_GATE = re.compile(r"обороны\s+Российской\s+Федерации\s+о\s+ходе\s+проведения\s+специальной\s+военной\s+операции", re.I)
# Weekly range: "с 29 ноября по 5 декабря 2025" or shared-month "со 2 по 8 мая 2026".
SVODKA_WEEKLY_RE = re.compile(r"с[о]?\s+(\d{1,2})(?:\s+(\w+))?\s+по\s+(\d{1,2})\s+(\w+)\s+(\d{4})", re.I)
SVODKA_DAILY_RE = re.compile(r"по\s+состоянию\s+на\s+(\d{1,2}\s+\w+\s+\d{4})", re.I)


@dataclass
class Report:
    post_id: int
    posted_at: str          # UTC ISO
    window_start: str | None  # MSK ISO
    window_end: str | None    # MSK ISO
    window_kind: str          # 'night' | 'day' | 'other'
    report_date: str          # YYYY-MM-DD (MSK date of window end)
    drones: int
    region_count: int
    regions: str
    raw_text: str
    # Per-region (name, count) pairs when the post itemizes them; else empty.
    breakdown: list[tuple[str, int]] = dc_field(default_factory=list)


@dataclass
class Summary:
    """A MoD Сводка summary post, captured raw (numbers not parsed yet)."""
    post_id: int
    posted_at: str            # UTC ISO
    kind: str                 # 'svodka_weekly' | 'svodka_daily' | 'svodka'
    period: str | None        # parsed header period, e.g. "29 ноября – 5 декабря 2025"
    raw_text: str


# ── parsing ───────────────────────────────────────────────────────────────────
def _parse_window(text: str, posted_msk: datetime):
    """Return (start, end, kind) as MSK datetimes (or None) + kind string."""
    m = NIGHT_DATED_RE.search(text)
    if m:
        h1, d1, mon1, h2, d2, mon2 = m.groups()
        mo1, mo2 = MONTHS.get(mon1.lower()), MONTHS.get(mon2.lower())
        if mo1 and mo2:
            yr = posted_msk.year
            end = datetime(yr, mo2, int(d2), int(h2), 0, tzinfo=MSK)
            # start is the prior boundary; roll the year back if it wraps Dec→Jan
            yr1 = yr - 1 if mo1 > mo2 else yr
            start = datetime(yr1, mo1, int(d1), int(h1), 0, tzinfo=MSK)
            return start, end, "night"
    if NIGHT_PHRASE_RE.search(text):
        # standard undated night = 20:00 (prev day) → 07:00 (posted day)
        end = posted_msk.replace(hour=7, minute=0, second=0, microsecond=0)
        start = (end - timedelta(days=1)).replace(hour=20)
        return start, end, "night"
    m = DAY_RANGE_RE.search(text)
    if m:
        h1, h2 = int(m.group(1)), int(m.group(2))
        base = posted_msk.replace(minute=0, second=0, microsecond=0)

        def at(hh: int) -> datetime:  # tolerate "24.00" → next-day 00:00
            extra, hh = divmod(hh, 24)
            return (base + timedelta(days=extra)).replace(hour=hh)

        start, end = at(h1), at(h2)
        if end <= start:  # crosses midnight
            end += timedelta(days=1)
        kind = "night" if h1 >= 18 or h2 <= 7 else "day"
        return start, end, kind
    return None, None, "other"


def _parse_regions(text: str):
    m = REGION_RE.search(text)
    if not m:
        return 0, ""
    clause = m.group(1).split(".")[0].strip()
    clause = re.sub(r"\s+", " ", clause)
    # rough region count: comma-separated items plus trailing " и X"
    parts = [p for p in re.split(r",|\s+и\s+", clause) if p.strip()]
    return len(parts), clause[:300]


def parse_breakdown(text: str) -> list[tuple[str, int]]:
    """Extract per-region (name, count) pairs when the post itemizes them.

    Returns [] for the total-only format. Requires ≥2 items (a single match in
    the total-only wording would be spurious)."""
    items = [(re.sub(r"\s+", " ", name).strip(" .,"), int(n))
             for n, name in REGION_ITEM_RE.findall(text)]
    return items if len(items) >= 2 else []


def parse_report(text: str, post_id: int, posted_at_utc: datetime) -> Report | None:
    """Parse one AD intercept post; return None if it isn't one."""
    flat = re.sub(r"\s+", " ", html.unescape(text)).strip()
    if not AD_GATE.search(flat) or "беспилотн" not in flat.lower():
        return None
    cm = COUNT_RE.search(flat)
    if not cm:
        return None
    drones = int(cm.group(1))
    if drones > MAX_PLAUSIBLE:
        return None
    posted_msk = posted_at_utc.astimezone(MSK)
    start, end, kind = _parse_window(flat, posted_msk)
    # attribute to the MSK date of the window end; fall back to posted MSK date
    report_date = (end or posted_msk).date().isoformat()

    # Prefer the itemized per-region counts when present; else the loose clause.
    breakdown = parse_breakdown(flat)
    if breakdown:
        region_count = len(breakdown)
        regions = ", ".join(name for name, _ in breakdown)[:300]
    else:
        region_count, regions = _parse_regions(flat)

    return Report(
        post_id=post_id,
        posted_at=posted_at_utc.astimezone(timezone.utc).isoformat(timespec="seconds"),
        window_start=start.isoformat(timespec="minutes") if start else None,
        window_end=end.isoformat(timespec="minutes") if end else None,
        window_kind=kind,
        report_date=report_date,
        drones=drones,
        region_count=region_count,
        regions=regions,
        raw_text=flat[:1000],
        breakdown=breakdown,
    )


def parse_summary(text: str, post_id: int, posted_at_utc: datetime) -> Summary | None:
    """Detect a MoD Сводка summary post and capture it raw (header + full text).

    Numbers are intentionally NOT parsed yet (see DATASETS.md §3). Returns None
    for non-summary posts (incl. the air-defense intercept reports)."""
    flat = re.sub(r"\s+", " ", html.unescape(text)).strip()
    if not SVODKA_GATE.search(flat):
        return None
    w = SVODKA_WEEKLY_RE.search(flat)
    if w:
        d1, mon1, d2, mon2, yr = w.groups()
        kind, period = "svodka_weekly", f"{d1} {mon1 or mon2} – {d2} {mon2} {yr}"
    else:
        d = SVODKA_DAILY_RE.search(flat)
        kind, period = ("svodka_daily", d.group(1)) if d else ("svodka", None)
    return Summary(
        post_id=post_id,
        posted_at=posted_at_utc.astimezone(timezone.utc).isoformat(timespec="seconds"),
        kind=kind,
        period=period,
        raw_text=flat[:20000],
    )


# ── web backend (t.me/s preview) ───────────────────────────────────────────────
class _TgParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.posts: list[dict] = []
        self.cur = None
        self._cap = 0
        self.next_before = None

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


def _fetch(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", "replace")


def iter_web(channel: str, since_id: int, max_pages: int, sleep: float, backfill: bool):
    """Yield (post_id:int, posted_at_utc:datetime, text:str), newest first.

    Incremental (default): stop once we page past `since_id` (already stored).
    Backfill: ignore since_id, walk until max_pages.
    """
    base = f"https://t.me/s/{channel}"
    before = None
    seen = set()
    for _ in range(max_pages):
        url = base + (f"?before={before}" if before else "")
        p = _TgParser()
        p.feed(_fetch(url))
        page_ids = []
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


# ── telethon backend (backfill) ────────────────────────────────────────────────
def iter_telethon(channel: str, min_id: int):
    """Yield (post_id, posted_at_utc, text) via the Telegram API (needs creds)."""
    api_id = os.environ.get("TELEGRAM_API_ID")
    api_hash = os.environ.get("TELEGRAM_API_HASH")
    if not api_id or not api_hash:
        raise SystemExit("ERROR: set TELEGRAM_API_ID and TELEGRAM_API_HASH for --source telethon")
    from telethon import TelegramClient
    from telethon.tl.types import Message

    session = os.environ.get("RU_MOD_SESSION", "ru_mod_session")
    out: list = []
    with TelegramClient(session, int(api_id), api_hash) as client:
        client.flood_sleep_threshold = 60
        for msg in client.iter_messages(channel, reverse=True, min_id=min_id):
            if isinstance(msg, Message) and msg.text:
                out.append((msg.id, msg.date.astimezone(timezone.utc), msg.text))
    return out


# ── storage ─────────────────────────────────────────────────────────────────
SCHEMA = """
CREATE TABLE IF NOT EXISTS ad_reports (
  post_id      INTEGER PRIMARY KEY,
  posted_at    TEXT NOT NULL,
  window_start TEXT,
  window_end   TEXT,
  window_kind  TEXT,
  report_date  TEXT NOT NULL,
  drones       INTEGER NOT NULL,
  region_count INTEGER,
  regions      TEXT,
  raw_text     TEXT,
  scraped_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_ad_date ON ad_reports(report_date);
-- Per-region counts, populated only for posts that itemize them (the MoD does
-- this on some days; on others it gives just a total + region list).
CREATE TABLE IF NOT EXISTS ad_regions (
  post_id     INTEGER NOT NULL,
  report_date TEXT NOT NULL,
  region      TEXT NOT NULL,
  drones      INTEGER NOT NULL,
  PRIMARY KEY (post_id, region)
);
CREATE INDEX IF NOT EXISTS ix_adr_region ON ad_regions(region);
CREATE VIEW IF NOT EXISTS daily_ad AS
  SELECT report_date AS date,
         SUM(drones)  AS drones_destroyed,
         COUNT(*)     AS reports
  FROM ad_reports GROUP BY report_date;
CREATE VIEW IF NOT EXISTS region_totals AS
  SELECT region,
         SUM(drones)         AS drones,
         COUNT(DISTINCT post_id) AS reports
  FROM ad_regions GROUP BY region;
-- MoD Сводка summary posts captured raw (cumulative UA losses, not yet parsed).
CREATE TABLE IF NOT EXISTS summaries (
  post_id    INTEGER PRIMARY KEY,
  posted_at  TEXT NOT NULL,
  kind       TEXT,
  period     TEXT,
  raw_text   TEXT NOT NULL,
  scraped_at TEXT NOT NULL
);
"""


def store(db_path: Path, reports: list[Report], summaries: list[Summary] = []) -> tuple[int, int, str | None]:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    try:
        conn.executescript(SCHEMA)
        scraped = datetime.now(timezone.utc).isoformat(timespec="seconds")
        for s in summaries:
            conn.execute(
                "INSERT OR IGNORE INTO summaries (post_id,posted_at,kind,period,raw_text,scraped_at) "
                "VALUES (?,?,?,?,?,?)",
                (s.post_id, s.posted_at, s.kind, s.period, s.raw_text, scraped),
            )
        inserted = 0
        for r in reports:
            cur = conn.execute(
                "INSERT OR IGNORE INTO ad_reports "
                "(post_id,posted_at,window_start,window_end,window_kind,report_date,"
                " drones,region_count,regions,raw_text,scraped_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (r.post_id, r.posted_at, r.window_start, r.window_end, r.window_kind,
                 r.report_date, r.drones, r.region_count, r.regions, r.raw_text, scraped),
            )
            inserted += cur.rowcount
            for region, n in r.breakdown:
                conn.execute(
                    "INSERT OR IGNORE INTO ad_regions (post_id,report_date,region,drones) "
                    "VALUES (?,?,?,?)",
                    (r.post_id, r.report_date, region, n),
                )
        conn.commit()
        total = conn.execute("SELECT COUNT(*) FROM ad_reports").fetchone()[0]
        latest = conn.execute("SELECT MAX(report_date) FROM ad_reports").fetchone()[0]
        overlaps = _overlap_count(conn)
        if overlaps:
            print(f"WARNING: {overlaps} overlapping report window(s) detected "
                  f"(possible double-count) — inspect window_start/window_end.", file=sys.stderr)
    finally:
        conn.close()
    return inserted, total, latest


def _overlap_count(conn) -> int:
    rows = conn.execute(
        "SELECT window_start, window_end FROM ad_reports "
        "WHERE window_start IS NOT NULL AND window_end IS NOT NULL ORDER BY window_start"
    ).fetchall()
    n, prev_end = 0, None
    for s, e in rows:
        if prev_end and s < prev_end:
            n += 1
        if prev_end is None or e > prev_end:
            prev_end = e
    return n


def max_stored_id(db_path: Path) -> int:
    if not db_path.exists():
        return 0
    conn = sqlite3.connect(db_path)
    try:
        conn.executescript(SCHEMA)
        r = conn.execute("SELECT MAX(post_id) FROM ad_reports").fetchone()[0]
        return r or 0
    finally:
        conn.close()


# ── self-test on captured samples (no network) ─────────────────────────────────
SAMPLES = [
    # (post_id, posted_utc, text, expect_drones, expect_kind, expect_report_date)
    (63943, "2026-05-25T06:07:01+00:00",
     "В течение прошедшей ночи дежурными средствами ПВО перехвачены и уничтожены 173 "
     "украинских беспилотных летательных аппарата самолетного типа над территориями "
     "Белгородской, Брянской областей и Республики Крым.", 173, "night", "2026-05-25"),
    (63892, "2026-05-23T05:25:17+00:00",
     "В период с 20.00 мск 22 мая до 7.00 мск 23 мая дежурными средствами ПВО перехвачены "
     "и уничтожены 348 украинских беспилотных летательных аппаратов самолетного типа над "
     "территориями Белгородской области и над акваториями Азовского и Черного морей.",
     348, "night", "2026-05-23"),
    (63908, "2026-05-23T18:49:01+00:00",
     "С 14.00 до 20.00 мск дежурными средствами ПВО перехвачены и уничтожены 11 украинских "
     "беспилотных летательных аппаратов самолетного типа над территориями Белгородской области.",
     11, "day", "2026-05-23"),
]


def selftest() -> int:
    ok = True
    for pid, posted, text, exp_n, exp_kind, exp_date in SAMPLES:
        r = parse_report(text, pid, datetime.fromisoformat(posted))
        got = (r.drones, r.window_kind, r.report_date) if r else None
        passed = r and got == (exp_n, exp_kind, exp_date)
        ok = ok and passed
        print(f"[{'OK' if passed else 'FAIL'}] {pid}: got={got} expect=({exp_n},{exp_kind},{exp_date})"
              + (f"  window={r.window_start}→{r.window_end} regions={r.region_count}" if r else ""))
    return 0 if ok else 1


# ── main ───────────────────────────────────────────────────────────────────
def main() -> int:
    ap = argparse.ArgumentParser(description="Build ru-mod-ad.db from the RU MoD Telegram channel.")
    ap.add_argument("--source", choices=["web", "telethon"], default="web")
    ap.add_argument("--channel", default=CHANNEL)
    ap.add_argument("--out", default=os.environ.get(
        "RU_MOD_DB_PATH", str(SCRIPT_DIR / "output" / DEFAULT_DB_NAME)))
    ap.add_argument("--max-pages", type=int, default=20, help="web: pages to walk (10–20 posts each)")
    ap.add_argument("--sleep", type=float, default=1.0, help="web: delay between pages")
    ap.add_argument("--backfill", action="store_true", help="web: ignore stored ids, walk max-pages")
    ap.add_argument("--selftest", action="store_true", help="parse built-in samples, no network")
    args = ap.parse_args()

    if args.selftest:
        return selftest()

    out = Path(args.out)
    since = max_stored_id(out)

    reports: list[Report] = []
    summaries: list[Summary] = []
    if args.source == "web":
        print(f"==> web preview t.me/s/{args.channel} (since_id={since}, backfill={args.backfill})")
        src = iter_web(args.channel, since, args.max_pages, args.sleep, args.backfill)
    else:
        print(f"==> telethon @{args.channel} (min_id={since})")
        src = iter_telethon(args.channel, since)

    scanned = 0
    for pid, posted, text in src:
        scanned += 1
        r = parse_report(text, pid, posted)
        if r:
            reports.append(r)
            continue
        s = parse_summary(text, pid, posted)
        if s:
            summaries.append(s)

    inserted, total, latest = store(out, reports, summaries)
    print(f"==> scanned {scanned} posts, parsed {len(reports)} AD reports "
          f"+ {len(summaries)} Сводка summaries, inserted {inserted} new AD; "
          f"DB total {total} (latest {latest}) → {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
