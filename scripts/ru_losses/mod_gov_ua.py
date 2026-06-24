"""
Fetch and parse daily Russian-loss reports from mod.gov.ua/en/news/.

Used as a freshness supplement to PetroIvaniuk's dataset: when MoD has
published a report for a loss-day Petro hasn't picked up yet (typically
1–2 days ahead), this fills the gap. PetroIvaniuk remains the primary /
authoritative source for the historical series.

URL pattern: as-of-{month-lowercase}-{day-nopad}-{year}, verified stable
across 2026 (single-digit days are NOT zero-padded — `may-1-2026` works,
`may-01-2026` 404s). Page is SSR'd Next.js so all numbers are in the
returned HTML — no headless browser needed.

Date convention (matches Petro's after his REPORT_TO_LOSS_DAY = -1 shift):
  URL date = report-publish day
  Loss day = URL date − 1   (the day the (+Δ) values report on)
  MoD's (+Δ) per metric goes straight into our daily_losses loss-day row.

Probe (scripts/ru_losses/probe_mod_gov_ua.py) verified MoD's deltas match
PetroIvaniuk's per-day diffs byte-for-byte on overlapping loss-days.
"""
import re
import urllib.error
import urllib.request
from datetime import date as date_cls, timedelta
from html.parser import HTMLParser


URL_TEMPLATE = (
    "https://mod.gov.ua/en/news/total-russian-combat-losses-in-ukraine-"
    "as-of-{month}-{day}-{year}"
)
_MONTHS = (
    "january february march april may june july august september "
    "october november december"
).split()

# MoD English label  →  our DB column (subset of ingest.METRICS). Labels
# not listed here ("submarines", "POW") are intentionally skipped —
# they're either flat-zero / not in our schema, or no longer reported in
# this format (parity with what PetroIvaniuk already drops).
MOD_LABEL_TO_DB_COL = {
    "tanks":                             "tanks",
    "armored fighting vehicles":         "apv",
    "artillery systems":                 "artillery",
    "MLRS":                              "mlrs",
    "air defense assets":                "aaws",
    "aircraft":                          "aircraft",
    "helicopters":                       "helicopters",
    "UAVs (operational-tactical level)": "uav",
    "vehicles and fuel tanks":           "vehicles",
    "warships and boats":                "boats",
    "special equipment":                 "se",
    "cruise missiles":                   "missiles",
    "unmanned ground vehicles":          "ugs",
}

# Outer envelope: every metric bullet is in <li>…</li>. The page sometimes
# wraps the inner text in <strong>/<u> tags, so we strip HTML afterwards.
_LI_RE = re.compile(r"<li[^>]*>(.*?)</li>", re.S)
# Standard bullet: "<label> ‒ <cumulative> (+<delta>);" — figure-dash
# (‒, U+2012), en-dash (–), or hyphen. Numbers use ASCII space or U+00A0
# as thousands separator. Trailing `;` mid-list, `.` on last item.
_BULLET_RE = re.compile(
    r"^(.+?)\s*[‒–-]\s*([\d  ]+?)\s*(?:\(\+([\d  ]+)\))?\s*[;.]?\s*$"
)
# Personnel is a standalone bullet without a dash:
#   "approximately 1 391 950 (+1 290) persons."
_PERSONNEL_RE = re.compile(
    r"approximately\s+([\d  ]+?)\s+\(\+([\d  ]+)\)\s+persons", re.I
)


def build_url(d: date_cls) -> str:
    """Build the canonical /en/news/ URL for a given report-publish date."""
    return URL_TEMPLATE.format(month=_MONTHS[d.month - 1], day=d.day, year=d.year)


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
    # MoD uses ASCII space and U+00A0 (NBSP) as thousands separator.
    return int(s.replace(" ", "").replace(" ", "").replace(",", ""))


def parse(html: str) -> dict[str, int]:
    """Return {DB-column: daily-Δ} from one MoD report's HTML body.

    Skips labels we don't map (submarines etc.). Raises RuntimeError on a
    page that doesn't yield ANY recognised bullet — better to fail loud
    than silently insert an empty row.
    """
    out: dict[str, int] = {}
    for li_html in _LI_RE.findall(html):
        text = _strip_html(li_html).strip()
        # Personnel first — its line shape is unique (no dash).
        m = _PERSONNEL_RE.search(text)
        if m:
            out["personnel"] = _to_int(m.group(2))
            continue
        m = _BULLET_RE.match(text)
        if not m:
            continue
        label = m.group(1).strip()
        col = MOD_LABEL_TO_DB_COL.get(label)
        if not col:
            continue
        out[col] = _to_int(m.group(3)) if m.group(3) else 0
    if not out:
        raise RuntimeError("no recognised bullets in MoD HTML — page format changed?")
    return out


def fetch_day(url_date: date_cls) -> dict[str, int] | None:
    """Fetch MoD report for {url_date} and parse it. Returns the deltas
    dict (DB-column → Δ) on success, None on 404 (report not yet
    published). Other HTTP/network errors raise so the caller decides.
    """
    url = build_url(url_date)
    headers = {"User-Agent": "sbs-stats-ingest"}
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            html = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise
    return parse(html)


def fetch_supplement(
    latest_loss_day: str,
    today: date_cls,
) -> dict[str, dict]:
    """Return {loss_day: {"reported_at": url_date, <metric>: Δ}} for every
    loss-day strictly after `latest_loss_day` and strictly before today
    (today's loss-day report won't be published yet at MoD's usual cadence).

    Stops at the first 404 — once MoD also hasn't published a day, there's
    no point checking further.
    """
    out: dict[str, dict] = {}
    cursor = date_cls.fromisoformat(latest_loss_day) + timedelta(days=1)
    while cursor < today:
        url_date = cursor + timedelta(days=1)
        deltas = fetch_day(url_date)
        if deltas is None:
            print(f"[mod] {url_date} not yet published — stopping supplement")
            break
        out[cursor.isoformat()] = {
            "reported_at": url_date.isoformat(),
            **deltas,
        }
        print(f"[mod] supplemented loss-day {cursor.isoformat()} from {url_date} "
              f"({len(deltas)} metrics)")
        cursor = cursor + timedelta(days=1)
    return out
