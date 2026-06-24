#!/usr/bin/env python3
"""
Probe mod.gov.ua loss reports vs the stored Petro-derived DB.

Fetches the last N report-days from
  https://mod.gov.ua/en/news/total-russian-combat-losses-in-ukraine-as-of-{month}-{day}-{year}
parses the cumulative numbers out of each <li>label ‒ N (+Δ);</li> bullet,
and compares against the matching loss-day row already in the DB (URL date
- 1 = loss day, same convention Petro uses).

The output is a delta report per metric per loss-day so we can verify the
mapping is byte-for-byte equivalent before wiring this as a freshness
fallback into the real ingest.

Usage:
  python3 probe_mod_gov_ua.py                 # last 5 days
  python3 probe_mod_gov_ua.py --days 10
  python3 probe_mod_gov_ua.py --date 2026-06-21  # one specific URL date
"""
import argparse
import json
import re
import sqlite3
import sys
import urllib.request
from datetime import date as date_cls, timedelta
from html.parser import HTMLParser
from pathlib import Path

import ingest as ig  # reuse SCRIPT_DIR / DEFAULT_DB_NAME / METRICS

# MoD English label  →  PetroIvaniuk source-key (so we can reuse ig.EQUIP_MAP /
# PERSONNEL_MAP to translate back to our DB columns). When MoD's wording is
# already byte-equal to Petro's source-key, this is just the identity.
LABEL_TO_PETRO_KEY = {
    "personnel":                   "personnel",
    "tanks":                       "tank",
    "armored fighting vehicles":   "APC",
    "artillery systems":           "field artillery",
    "MLRS":                        "MRL",
    "air defense assets":          "anti-aircraft warfare",
    "aircraft":                    "aircraft",
    "helicopters":                 "helicopter",
    "UAVs (operational-tactical level)": "drone",
    "vehicles and fuel tanks":     "vehicles and fuel tanks",
    "warships and boats":          "naval ship",
    "submarines":                  "submarines",
    "special equipment":           "special equipment",
    "cruise missiles":             "cruise missiles",
    "unmanned ground vehicles":    "ground robotic systems",
}

URL = "https://mod.gov.ua/en/news/total-russian-combat-losses-in-ukraine-as-of-{m}-{d}-{y}"
MONTHS = ("january february march april may june july august september "
          "october november december").split()


def build_url(d: date_cls) -> str:
    return URL.format(m=MONTHS[d.month - 1], d=d.day, y=d.year)


_LI_RE = re.compile(r"<li[^>]*>\s*([^<]*?)\s*</li>", re.S)
# "<label> ‒ <cumulative> (+<delta>);" — both ‒ (U+2012) and -, both ; and .
# Numbers use space as thousands separator; the "approximately" prefix on
# the personnel line gets stripped via a lstrip.
_BULLET_RE = re.compile(
    r"^\s*(?:approximately\s+)?(.+?)\s*[‒–-]\s*([\d\s]+?)(?:\s*\(\+([\d\s]+)\))?\s*[;.]?\s*(?:persons\.?)?\s*$"
)


def _strip_html(s: str) -> str:
    class _Strip(HTMLParser):
        def __init__(self) -> None:
            super().__init__()
            self.buf: list[str] = []
        def handle_data(self, data: str) -> None:
            self.buf.append(data)
    p = _Strip()
    p.feed(s)
    return "".join(p.buf)


def _to_int(s: str) -> int:
    return int(s.replace(" ", "").replace(" ", "").replace(",", ""))


def fetch_and_parse(url: str) -> dict:
    headers = {"User-Agent": "sbs-stats-mod-gov-probe"}
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=60) as resp:
        if resp.status != 200:
            raise RuntimeError(f"{url} returned HTTP {resp.status}")
        html = resp.read().decode("utf-8", errors="replace")
    # MoD bullets carry both the running cumulative AND the day's delta
    # (e.g. "tanks ‒ 12 050 (+1);"). Our DB rows store the DELTA per
    # loss-day, so the delta is what we'd actually feed into ingest.
    cum: dict[str, int] = {}
    delta: dict[str, int] = {}
    for li_html in _LI_RE.findall(html):
        text = _strip_html(li_html).strip()
        m = _BULLET_RE.match(text)
        if not m:
            continue
        label = m.group(1).strip()
        cum[label] = _to_int(m.group(2))
        delta[label] = _to_int(m.group(3)) if m.group(3) else 0
    # Pull headline loss-day from "Total russian military losses on {Month} {D}, {Y}"
    hl = re.search(
        r"Total russian military losses on (\w+) (\d{1,2}), (\d{4})", html
    )
    headline_loss_day = None
    if hl:
        mon = MONTHS.index(hl.group(1).lower()) + 1
        headline_loss_day = date_cls(int(hl.group(3)), mon, int(hl.group(2))).isoformat()
    # Pull publishedAt from the embedded Next.js JSON for cross-check.
    pub = re.search(r'"publishedAt":\{"iso":"([^"]+)"', html)
    return {
        "cum": cum,
        "delta": delta,
        "headline_loss_day": headline_loss_day,
        "published_at": pub.group(1) if pub else None,
    }


def db_row_for(conn: sqlite3.Connection, loss_day: str) -> dict | None:
    """Latest stored cumulative-metric row for the given loss-day."""
    row = conn.execute(
        "SELECT * FROM daily_losses WHERE date = ? "
        "ORDER BY scraped_at DESC LIMIT 1",
        (loss_day,),
    ).fetchone()
    if row is None:
        return None
    cols = [d[0] for d in conn.execute("SELECT * FROM daily_losses LIMIT 0").description]
    return dict(zip(cols, row))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    ap.add_argument("--days", type=int, default=5,
                    help="Number of trailing URL-dates to probe (default 5).")
    ap.add_argument("--date", metavar="YYYY-MM-DD",
                    help="Probe exactly one URL date instead of the trailing window.")
    ap.add_argument("--db", default=str(ig.SCRIPT_DIR / "output" / ig.DEFAULT_DB_NAME),
                    help="DB to diff against (default scripts/ru_losses/output/<db>).")
    args = ap.parse_args()

    if args.date:
        dates = [date_cls.fromisoformat(args.date)]
    else:
        today = date_cls.today()
        dates = [today - timedelta(days=i) for i in range(args.days)]

    db_path = Path(args.db)
    conn: sqlite3.Connection | None = None
    if db_path.exists():
        conn = sqlite3.connect(db_path)
    else:
        print(f"# NOTE: {db_path} not found — DB-diff column will be empty.")

    for url_date in dates:
        url = build_url(url_date)
        print(f"\n━━━ URL {url_date.isoformat()}  {url}")
        try:
            parsed = fetch_and_parse(url)
        except urllib.error.HTTPError as e:
            print(f"   HTTP {e.code} — skipping")
            continue
        loss_day = (url_date - timedelta(days=1)).isoformat()
        headline = parsed["headline_loss_day"]
        publish = parsed["published_at"]
        match_marker = "✓" if headline == loss_day else "⚠"
        print(f"   loss day (URL-1) = {loss_day}   headline says: {headline}  {match_marker}")
        print(f"   page publishedAt = {publish}")
        print(f"   {'metric':<32}  {'MoD cum':>10}  {'MoD Δ':>8}  {'DB Δ':>8}  Δ-match")
        db_row = db_row_for(conn, loss_day) if conn else None
        for label, petro_key in LABEL_TO_PETRO_KEY.items():
            mod_cum = parsed["cum"].get(label)
            mod_delta = parsed["delta"].get(label)
            our_col = (
                "personnel" if petro_key == "personnel"
                else "captive" if petro_key == "POW"
                else next((our for our, src in ig.EQUIP_MAP.items() if src == petro_key), None)
            )
            db_val = db_row.get(our_col) if (db_row and our_col) else None
            match = (
                "—" if mod_delta is None or db_val is None
                else "✓" if mod_delta == db_val
                else f"off {mod_delta - db_val:+}"
            )
            cum_disp   = f"{mod_cum:>10,}"   if mod_cum   is not None else f"{'—':>10}"
            delta_disp = f"{mod_delta:>8,}"  if mod_delta is not None else f"{'—':>8}"
            db_disp    = f"{db_val:>8,}"     if db_val    is not None else f"{'—':>8}"
            print(f"   {label:<32}  {cum_disp}  {delta_disp}  {db_disp}  {match}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
