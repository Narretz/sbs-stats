#!/usr/bin/env python3
"""
backfill_history.py — one-off backfill of General Staff operational reports
from before the Telegram channel carried them (it starts 2024-05-13).

The reports were posted to facebook.com/GeneralStaff.ua all along, and until
2024-01-25 the Cabinet of Ministers' site (kmu.gov.ua) republished them
verbatim. Three steps, all stdlib:

  fb-links  The post URLs can't be derived (the post id is opaque), but the
            Wayback Machine's CDX index has archived ~3,100 of them in the slug
            form  /posts/оперативна-інформація-станом-на-0600-01-березня-2024-…/<id>/
            — the slug carries the report's header time and date. Writes them,
            deduped by post id, to fb_links.json.

  fb-fetch  Facebook serves a public post in full to Googlebot, no login and no
            browser: the page's embedded JSON holds the post's `message.text`
            and its `creation_time`. Stored as source='facebook',
            source_id=<post id>. The Wayback copies themselves are not used —
            most are a login wall.

  kmu       Fills the days that still have no morning (06:00) report from
            kmu.gov.ua, whose news sitemaps list every republished report.
            Stored as source='kmu', source_id=<URL slug> (the site has no
            numeric id).

Every report goes through the same parse_summary / parse_directions /
upsert_report as a Telegram post.

Writes to its own DB (default data/gsua-fb-backfill/ru-attacks-gsua-fb.db),
never the live one: merging is a separate, deliberate step. Re-runs skip what
is already stored, so an interrupted fetch resumes where it stopped.

  python3 backfill_history.py fb-links
  python3 backfill_history.py fb-fetch --since 2023-05-01 --until 2024-05-13
  python3 backfill_history.py kmu --since 2023-05-01 --until 2024-05-13
"""
import argparse
import html
import json
import random
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import scrape_general_staff as gs
from ingest_log import ann, excerpt, get_logger

log = get_logger("gsua-backfill")

ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = ROOT / "data" / "gsua-fb-backfill"
FB_LINKS_PATH = OUT_DIR / "fb_links.json"
DB_PATH = OUT_DIR / "ru-attacks-gsua-fb.db"

CDX = "https://web.archive.org/cdx/search/cdx"
FB_PREFIX = "facebook.com/GeneralStaff.ua/posts/оперативна-інформація"
# The General Staff page's numeric id, as scrape_facebook.py records it.
GS_PAGE_ID = "100069092624537"
GOOGLEBOT = "Googlebot/2.1 (+http://www.google.com/bot.html)"
# Not a full Chrome string: kmu.gov.ua's bot screen (Radware) answers one that
# arrives without the rest of a browser's headers with a captcha page, as 200.
BROWSER = "Mozilla/5.0"

UA_MONTHS = {
    "січня": 1, "лютого": 2, "березня": 3, "квітня": 4, "травня": 5, "червня": 6,
    "липня": 7, "серпня": 8, "вересня": 9, "жовтня": 10, "листопада": 11, "грудня": 12,
}
# Both slug spellings: "станом-на-0600-01-березня-2024" and "станом-на-1800-01032024"
# (2022 also drops the "на": "станом-0600-02082022").
SLUG_WORD = re.compile(r"станом(?:-на)?-(\d{3,4})-(\d{1,2})-([а-яіїєґ]+)-(\d{4})")
SLUG_NUM = re.compile(r"станом(?:-на)?-(\d{3,4})-(\d{1,2})(\d{2})(\d{4})")
# The post id follows the slug; some archived URLs carry junk after it
# (`…/638255331820882/"data:image…`, `…/&`).
POST_ID = re.compile(r"/posts/[^/]+/(\d{10,})(?:/|$)")

KMU_SITEMAPS = [f"https://www.kmu.gov.ua/sitemap-rainlab-blog-models-post-{i}.xml" for i in (1, 2, 3)]
# kmu.gov.ua transliterates the same title several ways ("operatyvna-informatsiia-
# heneralnoho-shtabu…", "operativna-informaciya-generalnogo-shtabu…", without the
# General Staff at all in mid-2022), and its emergency service (ДСНС) posts its
# own "operatyvna informatsiia" daily.
KMU_REPORT = re.compile(
    r"/news/\d*o?perat[iy]vn\w*-in[fp]orma[ct]\w*-(?!dsns)(?:.*shtab.*|.*stanom.*)(?:vtorh|vtorg)")
KMU_MONTHS = {
    "sichnia": 1, "liutoho": 2, "bereznia": 3, "kvitnia": 4, "travnia": 5, "chervnia": 6,
    "lypnia": 7, "serpnia": 8, "veresnia": 9, "zhovtnia": 10, "lystopada": 11, "hrudnia": 12,
}
KMU_WORD = re.compile(r"stanom(?:-na)?-(\d{3,4})-(\d{1,2})-([a-z]+)-(20\d\d)")
KMU_NUM = re.compile(r"stanom(?:-na)?-(\d{3,4})-(\d{1,2})(\d{2})(20\d\d)")
KMU_PUBLISHED = re.compile(r"опубліковано\s+(\d{1,2})\s+(\w+)\s+(\d{4})\s+року\s+о\s+(\d{1,2}):(\d{2})")


def _get(url: str, ua: str, timeout: int = 60) -> tuple[int, str]:
    req = urllib.request.Request(url, headers={"User-Agent": ua, "Accept-Language": "uk,en"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, ""


def _header(m: re.Match, months: dict | None) -> tuple[str, str] | None:
    """(header date ISO, header time HHMM) from a SLUG_WORD/SLUG_NUM-style match."""
    try:
        if months is not None:
            if m.group(3) not in months:
                return None
            d = date(int(m.group(4)), months[m.group(3)], int(m.group(2)))
        else:
            d = date(int(m.group(4)), int(m.group(3)), int(m.group(2)))
    except ValueError:
        return None
    return d.isoformat(), m.group(1).rjust(4, "0")


def slug_header(url: str) -> tuple[str, str] | None:
    s = urllib.parse.unquote(url)
    if m := SLUG_WORD.search(s):
        return _header(m, UA_MONTHS)
    if m := SLUG_NUM.search(s):
        return _header(m, None)
    return None


def kmu_header(url: str) -> tuple[str, str] | None:
    if m := KMU_WORD.search(url):
        return _header(m, KMU_MONTHS)
    if m := KMU_NUM.search(url):
        return _header(m, None)
    return None


def store(conn: sqlite3.Connection, source: str, source_id: str, text: str,
          published: datetime, url: str, label: str) -> bool:
    """Parse one report and upsert it. False when the gate rejects it."""
    msg = SimpleNamespace(id=source_id, source=source, date=published, text=text)
    summary = gs.parse_summary(text, msg)
    if summary is None:
        log.warning(f"{label}: gate rejected: {excerpt(text)}",
                    extra=ann(title="gsua-backfill: gate rejected"))
        return False
    # A report reposted hours later (the spokesman's "…(з уточненнями)"
    # version, 18.05.2023, 09.12.2023) is stored too, like the live ingest's
    # double posts: the frontend merges a (date, source, snapshot_at) with MAX.
    directions = gs.parse_directions(text, msg, summary.date)
    gs.upsert_report(conn, summary, directions, text, url)
    conn.commit()
    log.info(f"{label}: {summary.date} combat={summary.combat_engagements} "
             f"air={summary.air_strikes} dirs={len(directions)}")
    return True


def _write_failures(name: str, failures: list) -> None:
    if failures:
        path = OUT_DIR / name
        path.write_text(json.dumps(failures, ensure_ascii=False, indent=1))
        log.warning(f"{len(failures)} failures → {path}")


# ── Facebook ────────────────────────────────────────────────────────────────

def cmd_fb_links(args) -> None:
    q = urllib.parse.urlencode({
        "url": FB_PREFIX, "matchType": "prefix", "output": "json",
        "fl": "timestamp,original", "collapse": "urlkey",
    })
    status, body = _get(f"{CDX}?{q}", BROWSER, timeout=600)
    if status != 200:
        sys.exit(f"CDX query failed: HTTP {status}")
    rows = json.loads(body)[1:]
    links: dict[str, dict] = {}
    unparsed = 0
    for _ts, url in rows:
        m = POST_ID.search(url)
        hdr = slug_header(url)
        if not m or not hdr:
            unparsed += 1
            continue
        # One post can be archived under several truncated slugs; keep one.
        links.setdefault(m.group(1), {
            "post_id": m.group(1), "url": url[:m.end(1)] + "/",
            "header_date": hdr[0], "header_time": hdr[1],
        })
    out = sorted(links.values(), key=lambda r: (r["header_date"], r["header_time"]))
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    FB_LINKS_PATH.write_text(json.dumps(out, ensure_ascii=False, indent=1))
    log.info(f"{len(rows)} archived URLs → {len(out)} posts "
             f"({out[0]['header_date']} … {out[-1]['header_date']}), {unparsed} unparsed "
             f"→ {FB_LINKS_PATH}")


def fb_extract(page: str, post_id: str) -> tuple[str, datetime] | None:
    """The post's text and publish time out of the Googlebot page's JSON."""
    texts = []
    for m in re.finditer(r'"message":\{(?:[^{}]|\{[^{}]*\})*?"text":"((?:[^"\\]|\\.)*)"', page):
        t = json.loads(f'"{m.group(1)}"')
        if "Оперативна інформація" in t:
            texts.append(t)
    ctimes = re.findall(r'"creation_time":(\d+)', page)
    if not texts or not ctimes or post_id not in page:
        return None
    # The page is one post; its text recurs in several JSON blobs. Take the
    # longest in case one is a truncated preview.
    return max(texts, key=len), datetime.fromtimestamp(int(ctimes[0]), timezone.utc)


def cmd_fb_fetch(args) -> None:
    links = json.loads(FB_LINKS_PATH.read_text())
    todo = [r for r in links if args.since <= r["header_date"] <= args.until]
    conn = gs.open_db(Path(args.db))
    have = {r[0] for r in conn.execute("SELECT source_id FROM posts WHERE source = 'facebook'")}
    todo = [r for r in todo if r["post_id"] not in have]
    log.info(f"{len(todo)} posts to fetch ({args.since} … {args.until}), "
             f"{len(have)} already in {args.db}")

    failures, consecutive = [], 0
    for i, r in enumerate(todo, 1):
        label = f"[{i}/{len(todo)}] fb {r['post_id']} (hdr {r['header_date']} {r['header_time']})"
        status, page = _get(r["url"], GOOGLEBOT)
        got = fb_extract(page, r["post_id"]) if status == 200 else None
        if got is None:
            consecutive += 1
            failures.append({**r, "status": status})
            log.warning(f"{label}: HTTP {status}, no report text")
            if consecutive >= args.max_consecutive_failures:
                log.error(f"{consecutive} failures in a row — stopping (blocked?)")
                break
            time.sleep(args.delay * 4)
            continue
        consecutive = 0
        text, created = got
        url = f"https://www.facebook.com/story.php?story_fbid={r['post_id']}&id={GS_PAGE_ID}"
        if not store(conn, "facebook", r["post_id"], text, created, url, label):
            failures.append({**r, "status": "gate_rejected"})
        time.sleep(args.delay + random.uniform(0, args.delay / 2))

    _write_failures("fb_failures.json", failures)
    conn.close()


# ── kmu.gov.ua ──────────────────────────────────────────────────────────────

def kmu_reports() -> list[dict]:
    """Every republished General Staff report in the kmu.gov.ua news sitemaps."""
    out = []
    for i, sm in enumerate(KMU_SITEMAPS, 1):
        cache = OUT_DIR / f"kmu-post{i}.xml"
        if not cache.exists():
            status, body = _get(sm, BROWSER, timeout=300)
            if status != 200:
                sys.exit(f"{sm}: HTTP {status}")
            cache.write_text(body)
            time.sleep(1)
        for url, lastmod in re.findall(r"<loc>([^<]+)</loc>\s*<lastmod>([^<]+)</lastmod>", cache.read_text()):
            if not KMU_REPORT.search(url):
                continue
            hdr = kmu_header(url)
            if hdr is None:
                # A slug without a parseable header: fall back to the publish time.
                hdr = lastmod[:10], "0600" if lastmod[11:13] < "12" else "1800"
            out.append({"url": url, "header_date": hdr[0], "header_time": hdr[1]})
    return out


def kmu_extract(page: str) -> tuple[str, datetime] | None:
    """Title + body and the publish time (Kyiv) of one kmu.gov.ua news page."""
    title = re.search(r'<h1 class="heading-1">(.*?)</h1>', page, re.S)
    body = re.search(r'<div class="editor-content">(.*?)<div class="d-none d-md-block text-right">', page, re.S)
    pub = KMU_PUBLISHED.search(re.sub(r"\s+", " ", page))
    if not (title and body and pub) or pub.group(2) not in UA_MONTHS:
        return None
    lines = re.sub(r"</(?:div|p|li|h\d)>|<br\s*/?>", "\n", body.group(1))
    lines = html.unescape(re.sub(r"<[^>]+>", "", lines)).replace("\xa0", " ")
    text = html.unescape(title.group(1)).strip() + "\n\n" + "\n".join(
        l.strip() for l in lines.split("\n") if l.strip())
    d, mon, y, hh, mm = pub.groups()
    published = datetime(int(y), UA_MONTHS[mon], int(d), int(hh), int(mm), tzinfo=gs.KYIV_TZ)
    return text, published.astimezone(timezone.utc)


def cmd_kmu(args) -> None:
    conn = gs.open_db(Path(args.db))
    # Days whose morning report no source has supplied yet.
    have = {r[0] for r in conn.execute(
        "SELECT substr(snapshot_at, 1, 10) FROM posts WHERE substr(snapshot_at, 12, 2) = '06'")}
    stored = {r[0] for r in conn.execute("SELECT source_id FROM posts WHERE source = 'kmu'")}
    start, end = date.fromisoformat(args.since), date.fromisoformat(args.until)
    want = {(start + timedelta(i)).isoformat() for i in range((end - start).days + 1)} - have
    todo = [r for r in kmu_reports()
            if r["header_date"] in want and r["header_time"] < "1200"
            and r["url"].rsplit("/", 1)[1] not in stored]
    log.info(f"{len(want)} days without a morning report ({args.since} … {args.until}); "
             f"{len(todo)} of them on kmu.gov.ua")

    failures = []
    for i, r in enumerate(todo, 1):
        slug = r["url"].rsplit("/", 1)[1]
        label = f"[{i}/{len(todo)}] kmu (hdr {r['header_date']} {r['header_time']})"
        status, page = _get(r["url"], BROWSER)
        if "Radware Captcha" in page:
            log.error(f"{label}: kmu.gov.ua answered with its bot captcha — stopping")
            break
        got = kmu_extract(page) if status == 200 else None
        if got is None:
            failures.append({**r, "status": status})
            log.warning(f"{label}: HTTP {status}, no report text")
        elif not store(conn, "kmu", slug, got[0], got[1], r["url"], label):
            failures.append({**r, "status": "gate_rejected"})
        # robots.txt: Crawl-delay 1.
        time.sleep(args.delay + random.uniform(0, args.delay / 2))

    _write_failures("kmu_failures.json", failures)
    conn.close()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("fb-links", help="list FB report URLs from the Wayback CDX index")
    for name, delay, help_ in (("fb-fetch", 3.0, "fetch + parse + store FB reports"),
                               ("kmu", 1.5, "fill days without a morning report from kmu.gov.ua")):
        p = sub.add_parser(name, help=help_)
        p.add_argument("--since", required=True, help="header date, YYYY-MM-DD")
        p.add_argument("--until", required=True, help="header date, YYYY-MM-DD (inclusive)")
        p.add_argument("--db", default=str(DB_PATH))
        p.add_argument("--delay", type=float, default=delay, help="seconds between fetches")
        if name == "fb-fetch":
            p.add_argument("--max-consecutive-failures", type=int, default=8)
    args = ap.parse_args()
    {"fb-links": cmd_fb_links, "fb-fetch": cmd_fb_fetch, "kmu": cmd_kmu}[args.cmd](args)


if __name__ == "__main__":
    main()
