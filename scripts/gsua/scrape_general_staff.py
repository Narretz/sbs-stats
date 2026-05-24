"""
Telegram Scraper for Ukrainian General Staff Operational Reports
================================================================

Scrapes messages from the @GeneralStaffZSU Telegram channel,
identifies daily operational situation reports, extracts structured
data (combat engagements, strikes, losses by direction), and stores
them in a SQLite database.

Requirements:
    pip install telethon python-dotenv

Setup:
    1. Get your own Telegram API credentials at https://my.telegram.org
    2. Create a .env file (or set environment variables):
         TELEGRAM_API_ID=your_api_id
         TELEGRAM_API_HASH=your_api_hash
    3. Run: python scrape_general_staff.py
    4. On first run you'll be prompted to log in with your phone number.

Output:
    output/general_staff.db, with two tables:
      - posts      : one row per operational report; PK is (source, source_id).
                     Multiple rows per `date` are expected (evening
                     report + next-morning wrap-up + later corrections).
      - directions : one row per (source, source_id, direction).

    Re-running the script appends new posts and overrides existing
    ones (matched by (source, source_id)), so edited posts get reparsed.
"""

import argparse
import os
import re
import sqlite3
import asyncio
import logging
from datetime import datetime, timezone, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

# Channel publishes in Kyiv local time. Used to detect mis-typed snapshot
# headers by comparing the header's calendar date against the Kyiv-local date
# of the Telegram message timestamp.
KYIV_TZ = ZoneInfo("Europe/Kyiv")
from dataclasses import dataclass

from telethon import TelegramClient
from telethon.errors import FloodWaitError
from telethon.tl.types import Message

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

CHANNEL = "GeneralStaffZSU"

API_ID = os.environ.get("TELEGRAM_API_ID")
API_HASH = os.environ.get("TELEGRAM_API_HASH")
SESSION_NAME = "gs_scraper_session"

# How far back to scrape (None = everything)
SCRAPE_SINCE = None  # e.g. datetime(2024, 1, 1, tzinfo=timezone.utc)

# Rate limiting — be gentle with Telegram's API
BATCH_PAUSE = 1.0           # seconds to sleep every BATCH_SIZE messages
BATCH_SIZE = 100            # Telethon fetches 100 msgs per API call by default
FLOOD_WAIT_MARGIN = 5       # extra seconds to add on top of Telegram's wait time

# Checkpoint file — lets you resume if interrupted
CHECKPOINT_FILE = Path("output/.checkpoint")

OUTPUT_DIR = Path("output")
DB_PATH = OUTPUT_DIR / "general_staff.db"
LOG_LEVEL = logging.INFO

logging.basicConfig(
    level=LOG_LEVEL,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass
class DailySummary:
    """Top-level numbers from a single operational report."""
    source: str = "telegram"     # 'telegram' | 'facebook'
    source_id: str = ""          # Telegram message_id or FB story_fbid, as text
    date: str = ""               # day the report is *about* (Kyiv local)
    message_date: str = ""       # source post timestamp (UTC, from the message)
    snapshot_at: str | None = None  # "станом на HH:MM D MONTH YYYY" parsed → ISO (Kyiv local, naive)
    combat_engagements: int | None = None
    missile_strikes: int | None = None
    missiles_used: int | None = None
    air_strikes: int | None = None
    kabs_dropped: int | None = None
    kamikaze_drones: int | None = None
    shellings: int | None = None
    mlrs_shellings: int | None = None
    notes: str | None = None  # free-text marker for parser corrections (e.g. header typos)
    part: str | None = None   # "1/2", "2/2", … when the post is one of a multipart split; else NULL


@dataclass
class DirectionEntry:
    """Per-direction breakdown from an operational report."""
    date: str = ""
    source: str = "telegram"
    source_id: str = ""
    direction: str = ""
    attacks: int | None = None
    ongoing: int | None = None


# ---------------------------------------------------------------------------
# Detection: is this an operational situation report?
# ---------------------------------------------------------------------------

# The GS posts multiple types of content. The operational reports typically
# contain phrases like "оперативна інформація" or "бойових зіткнень".
# The morning wrap-up (~08:00) often starts with "Оперативна інформація
# станом на 08:00" and lists the previous day's totals.

OPERATIONAL_REPORT_PATTERNS = [
    r"(?i)оперативна\s+інформація",
    # Accept both the separated form ("бойових зіткнень") and the compound
    # spelling ("боєзіткнення") that the channel uses in shorter updates.
    r"(?i)бо(?:йов(?:их|і|е)\s+зіткнен|єзіткнен)",
    # Daily ("протягом минулої доби") and intraday ("від/з початку (цієї) доби").
    r"(?i)(?:протягом|від\s+початку|з\s+початку)\s+(?:минулої\s+|цієї\s+)?доби",
]
# A bare "станом на HH:MM" used to be a 4th signal, but it false-matched
# non-report posts that *quote* a timestamp (e.g. Сирський's Pokrovsk operation
# briefings reference "станом на 06.00 13 жовтня 2025 року"). Real operational
# reports always say "Оперативна інформація" verbatim — patterns 1 + (2 or 3)
# cover them without that loose extra match.


def _strip_markdown(text: str) -> str:
    """Drop Markdown bold delimiters before regex matching.

    Late-2024 posts used **bold** liberally around the header phrase,
    direction names, and even bare numbers ("**190** бойових зіткнень").
    Stripping is safe everywhere — we never need to *match* on **, only
    around it. The original (un-stripped) text is still what gets stored.
    """
    return text.replace("**", "")


def is_operational_report(text: str) -> bool:
    """Return True if the message looks like an operational situation report.

    Requirements:
      1. Contains the literal phrase "Оперативна інформація" (every real
         situation report uses it verbatim; filters out press statements
         and commander quotes like msgs 23523, 30252).
      2. Contains a parseable "станом на HH:MM …" header (filters out
         specialised non-daily reports like msg 19345 — ОСУВ "Хортиця").
      3. Matches at least one of the body patterns (бо… зіткнень / від
         початку доби / etc.).
    """
    text = _strip_markdown(text)
    if not re.search(OPERATIONAL_REPORT_PATTERNS[0], text):
        return False
    if not SNAPSHOT_RE.search(text):
        return False
    other_matches = sum(1 for p in OPERATIONAL_REPORT_PATTERNS[1:] if re.search(p, text))
    return other_matches >= 1


# Snapshot header — accepts either Ukrainian-month form ("9 травня 2026") or
# the dotted numeric form ("09.05.2026") that the channel currently uses.
SNAPSHOT_RE = re.compile(
    r"станом\s+на\s+(\d{1,2})[:.](\d{2})\s+"
    r"(?:"
    r"(\d{1,2})\s+(\w+)\s+(\d{4})"             # 9 травня 2026
    r"|"
    r"(\d{1,2})[\./](\d{1,2})[\./](\d{4})"     # 09.05.2026
    r")",
    re.IGNORECASE,
)

# Day-of-coverage markers. When present they override the hour heuristic.
PREV_DAY_MARKERS = re.compile(
    r"(?i)(?:протягом\s+)?минулої\s+доби|за\s+минулу\s+добу|вчорашньої\s+доби"
)
SAME_DAY_MARKERS = re.compile(
    r"(?i)(?:від|з)\s+початку\s+(?:цієї\s+)?доби"
)


def _parse_snapshot(
    text: str, msg_date: datetime | None = None
) -> tuple[str | None, str | None, str | None]:
    """Parse 'станом на …' header → (report_date, snapshot_at_iso, note).

    `report_date` is the day the post is *about*. Prefer textual markers
    ("минулої доби" → previous day, "від початку доби" → same day) and fall
    back to the hour heuristic (hour < 12 → previous day) when neither is
    present.

    `note` is a free-text marker for parser corrections — populated only when
    the channel mis-typed the header date. We detect that case by comparing
    the header's calendar date against the Kyiv-local date of `msg_date`;
    posts are normally published within ~3 hours of their snapshot, so any
    day-level disagreement is a typo. When that happens, we trust the message
    timestamp and rewrite `snapshot_at` accordingly.
    """
    text = _strip_markdown(text)
    m = SNAPSHOT_RE.search(text)
    if not m:
        return None, None, None
    hour, minute = int(m.group(1)), int(m.group(2))
    if m.group(3):  # Ukrainian-month branch
        day, year = int(m.group(3)), int(m.group(5))
        month = UA_MONTHS.get(m.group(4).lower())
        if not month:
            return None, None, None
    else:           # numeric DD.MM.YYYY branch
        day, month, year = int(m.group(6)), int(m.group(7)), int(m.group(8))

    snapshot = datetime(year, month, day, hour, minute)
    note: str | None = None

    # Header sanity check: the message must have been posted on (or right
    # before) the day the header claims, in Kyiv local time.
    if msg_date is not None:
        # Compare the header timestamp (Kyiv local) against the message
        # timestamp (UTC) — they should agree to within a few hours since the
        # channel posts at or shortly after the snapshot time. Use a 12-hour
        # threshold: well above legitimate late posts (which sometimes cross
        # midnight, see msg 28416 = 2h late into Aug 30 for a 22:00 Aug 29
        # report) and well below day-level typos (always ≥24h off).
        snapshot_kyiv = snapshot.replace(tzinfo=KYIV_TZ)
        hours_off = (msg_date - snapshot_kyiv).total_seconds() / 3600
        if abs(hours_off) > 12:
            kyiv_date = msg_date.astimezone(KYIV_TZ).date()
            corrected = datetime.combine(kyiv_date, snapshot.time())
            note = (
                f"header_typo: header claimed "
                f"{snapshot.date().isoformat()} {snapshot.strftime('%H:%M')}; "
                f"corrected to {kyiv_date.isoformat()} from message_date"
            )
            snapshot = corrected

    report_day = snapshot.date()
    if PREV_DAY_MARKERS.search(text):
        report_day -= timedelta(days=1)
    elif SAME_DAY_MARKERS.search(text):
        pass
    elif hour < 12:
        report_day -= timedelta(days=1)
    return report_day.isoformat(), snapshot.isoformat(), note


# ---------------------------------------------------------------------------
# Parsing helpers
# ---------------------------------------------------------------------------

def _first_int(pattern: str, text: str) -> int | None:
    """Extract the first integer matched by `pattern` from `text`."""
    m = re.search(pattern, text)
    if m:
        # Find the group that contains a number
        for g in m.groups():
            if g and g.replace(" ", "").isdigit():
                return int(g.replace(" ", ""))
    return None


def _extract_int(pattern: str, text: str) -> int | None:
    """Simpler: search pattern, return first capture group as int."""
    m = re.search(pattern, text, re.IGNORECASE)
    if m:
        raw = m.group(1).replace(" ", "").replace("\u00a0", "")
        try:
            return int(raw)
        except ValueError:
            return None
    return None


def _extract_count(
    text: str, digit_re: str | None, word_re: str | None = None
) -> int | None:
    """Extract a count as either a digit (preferred) or a Ukrainian word form.

    `digit_re` must have one capture group with the number string, or be
    None to skip the digit attempt entirely (use when the caller has
    already exhausted digit branches).
    `word_re` must have one capture group with the Ukrainian number word
    (matched against UA_NUM with apostrophe variants normalised).
    """
    if digit_re is not None:
        n = _extract_int(digit_re, text)
        if n is not None:
            return n
    if word_re:
        m = re.search(word_re, text, re.IGNORECASE)
        if m:
            word = m.group(1).lower().replace("\u02bc", "'").replace("\u2019", "'")
            return UA_NUM.get(word)
    return None


def _branch_4_only(text: str) -> int | None:
    """Match the kil_kist family — "[загальна] кількість <X> [вже] <verb>
    [понад] N" — without running any earlier branches.

    Used by the sanity check as a recovery probe: if branch 3 grabbed a
    per-direction "окупанти здійснили N спроб" mini-aggregate, the global
    aggregate is often a kil_kist form that branch 4 would catch cleanly
    if it ran in isolation.
    """
    return _extract_int(
        r"(?:загальна\s+)?кількість\s+"
        r"(?:\w+\s+)?"
        r"(?:атак\s+(?:російського\s+)?агресора|ворожих\s+(?:\w+\s+){0,3}(?:атак|дій)|"
        r"боєзіткнень|бойових\s+зіткнень)"
        r"(?:\s+\w+|,){0,8}\s+"
        r"(?:[ув]же\s+)?"
        r"(?:становить|складає|"
        r"зросла(?:\s+ще\s+на\s+(?:\d+|[\w'ʼ’]+),)?\s+до|"
        r"збільшила(?:сь|ся)\s+(?:[ув]же\s+)?до|досягла|-|"
        r"станом\s+на\s+(?:\w+\s+){0,2}\w+)\s+"
        r"(?:понад\s+)?(\d[\d\s]*\d|\d)",
        text,
    )


def _parse_combat_engagements(
    text: str,
    *,
    skip_branch_1a: bool = False,
    only_branch_4: bool = False,
) -> int | None:
    """Run the combat-engagements branch chain on a markdown-stripped text.

    GSUA only reports enemy actions, so "N бойових зіткнень" / "агресор N
    разів атакував" / "окупанти атакували N разів" / "кількість ... становить
    N" all describe the same metric — just rephrased per slot/period.

    Per-direction sections reuse the same wording as the global aggregate
    for their own mini-summaries (e.g. "На X напрямках з початку доби
    відбулося дев'ять боєзіткнень"). The branches below are ordered so
    that more specific / better-anchored patterns are tried first. Branch
    1a is unanchored and can grab a per-direction "N бойових зіткнень"
    when the global aggregate uses a phrasing only a later branch catches;
    the sanity-check pass detects this case (combat < max direction
    attacks) and calls this function again with skip_branch_1a=True to
    recover the correct global. Passing only_branch_4=True runs only
    branch 4 (the kil_kist patterns) — used by the sanity check as an
    additional recovery probe for posts where branch 3 grabs a
    per-direction "окупанти здійснили N спроб" before branch 4 can
    catch the global "кількість X зросла до N" form.
    """
    if only_branch_4:
        return _branch_4_only(text)
    return (
        # 1a. Daily aggregate, separated form, digit: "N бойових/бойові/
        #     бойове зіткнень". Unanchored — skippable via the parameter.
        (None if skip_branch_1a else
         _extract_int(r"(\d[\d\s]*\d|\d)\s*бойов(?:их|і|е)\s+зіткнен", text))
        # 1b. Daily aggregate, compound form, digit. Anchored on a paragraph
        #     start (line beginning) followed by a day-marker, so per-direction
        #     mid-sentence mini-aggregates don't match.
        or _extract_int(
            r"(?:^|\n)\s*"
            r"(?:Загалом|Вчора|(?:З|Від)\s+початку\s+(?:цієї\s+)?доби),?\s+"
            r"(?:[\w'ʼ’\s,]{0,50}?)"
            r"(?:зафіксовано|відбулося|відбулось)\s+(\d[\d\s]*\d|\d)\s+боєзіткнен",
            text,
        )
        # 1d. Sep-2024 variant: "За сьогодні відбулося N ворожих атак" — this
        #     phrasing appears mid-paragraph rather than at line start, so it
        #     can't share the (?:^|\n) anchor. "За сьогодні" + "ворожих атак"
        #     is specific enough to the global midday aggregate that it
        #     doesn't need anchoring; per-direction prose uses "На X
        #     напрямку" not "За сьогодні".
        or _extract_int(
            r"За\s+сьогодні\s+(?:[\w'ʼ’\s,]{0,30}?)"
            r"відбулося\s+(\d[\d\s]*\d|\d)\s+ворожих\s+атак",
            text,
        )
        # 1c. Daily aggregate, word-form count (rare — msg 24737: "сто бойових
        #     зіткнень"). Same line-start anchoring as 1b.
        or _extract_count(
            text,
            None,
            r"(?:^|\n)\s*"
            r"(?:Загалом|Вчора|(?:З|Від)\s+початку\s+(?:цієї\s+)?доби),?\s+"
            r"(?:[\w'ʼ’\s,]{0,50}?)"
            r"(?:зафіксовано|відбулося|відбулось)\s+([\w'ʼ’]+)\s+"
            r"(?:боєзіткнен|бойов(?:их|і|е)\s+зіткнен)",
        )
        # 2. Midday aggregate: "(агресор|ворог) N раз(ів) атакував [у бік]
        #    позиц… Сил оборони". The "Сил оборони" suffix is what
        #    disambiguates the aggregate from per-direction lines like
        #    "ворог 14 разів атакував позиції наших захисників у районах …".
        #    `позиц\w+` covers all case forms (позиції/позицій), including
        #    the genitive plural "позицій" with terminal ї.
        or _extract_int(
            r"(?:агресор|ворог)\s+(\d[\d\s]*\d|\d)\s+раз(?:ів|и)?\s+"
            r"атакува\w*\s+(?:у\s+бік\s+)?позиц\w+\s+Сил\s+оборони",
            text,
        )
        # 2b. Jun-2024 variant: "З/Від початку доби (російські) загарбники
        #     N разів атакували позиції українських захисників" (msg 15275).
        #     Per-direction lines reuse this exact phrasing inside "На X
        #     напрямку ..." sections, so we anchor on the day-marker at
        #     paragraph start. The [^\w]* gap tolerates markdown noise
        #     ("доби** російські") around the line break.
        or _extract_int(
            r"(?:^|\n)\s*(?:З|Від)\s+початку\s+(?:цієї\s+)?доби[^\w]*"
            r"(?:російські\s+)?загарбник\w*\s+(\d[\d\s]*\d|\d)\s+раз\w*\s+"
            r"атакува\w*\s+позиц\w+\s+українських\s+захисників",
            text,
        )
        # 2c. May-2024 morning variant: "За поточну добу противник провів N
        #     атак[у]" (msg 14638) — different subject ("противник провів")
        #     and noun ("N атак[у]"). Anchored on the day-marker preamble.
        or _extract_int(
            r"(?:За\s+поточну\s+добу|(?:З|Від)\s+початку\s+(?:цієї\s+)?доби)"
            r"\s+противник\s+провів\s+(\d[\d\s]*\d|\d)\s+атак\w*",
            text,
        )
        # 3. Midday: "окупанти (атакували|здійснили) N (раз(ів)|спроб)".
        or _extract_int(
            r"окупанти\s+(?:атакували|здійснили)\s+(\d[\d\s]*\d|\d)\s+"
            r"(?:раз(?:ів|и)?|спроб)",
            text,
        )
        # 3b. May-2024 variant: "Поточної доби окупанти здійснили вже N
        #     спроб" (msg 14854). Per-direction lines also use "окупанти
        #     здійснили вже N спроб" inside "На X напрямку…" sections,
        #     and the more common day-marker "З/Від початку доби" overlaps
        #     with per-direction usage (msg 15811: "На Покровському
        #     напрямку … З початку доби окупанти здійснили вже 28 спроб").
        #     So this branch is restricted to the less common "Поточної
        #     доби" preamble that the global-aggregate form uses.
        or _extract_int(
            r"Поточної\s+доби[^.\n]{0,40}?"
            r"окупанти\s+(?:атакували|здійснили)\s+[ув]же\s+"
            r"(\d[\d\s]*\d|\d)\s+(?:раз(?:ів|и)?|спроб)",
            text,
        )
        # 4. Midday: "[загальна] кількість <X> [уже/вже] <verb> [понад] N"
        #    <X> covers every variant the channel has used: ворожих атак /
        #    ворожих <ADJ> дій / атак (рос.) агресора / бойових зіткнень /
        #    боєзіткнень. <verb> is "становить" / "складає" / "зросла до" /
        #    "збільшилась [вже] до" / "досягла" / a bare " - " (dash form,
        #    Jun-2024: "кількість бойових зіткнень на лінії фронту - 51").
        #    The word-fill before <verb> absorbs adverbial phrases like
        #    "уздовж усієї лінії фронту" / "по всій лінії фронту на цей час"
        #    and tolerates commas ("зросла, і складає").
        or _extract_int(
            r"(?:загальна\s+)?кількість\s+"
            # Optional adjective: "сьогоднішніх бойових зіткнень" (msg 17760).
            r"(?:\w+\s+)?"
            r"(?:атак\s+(?:російського\s+)?агресора|ворожих\s+(?:\w+\s+){0,3}(?:атак|дій)|"
            r"боєзіткнень|бойових\s+зіткнень)"
            r"(?:\s+\w+|,){0,8}\s+"
            r"(?:[ув]же\s+)?"
            r"(?:становить|складає|"
            # "зросла до N" plus the May-2024 interjection variant
            # "зросла ще на N, до M" (msg 14961).
            r"зросла(?:\s+ще\s+на\s+(?:\d+|[\w'ʼ’]+),)?\s+до|"
            r"збільшила(?:сь|ся)\s+(?:[ув]же\s+)?до|досягла|-|"
            # Verbless connector: "станом на зараз/цей час/цю хвилину N"
            # (msg 14881). \w+ covers "зараз"; "(?:\w+\s+){0,2}" handles
            # the longer variants like "на цей час" / "на цю хвилину".
            r"станом\s+на\s+(?:\w+\s+){0,2}\w+)\s+"
            r"(?:понад\s+)?(\d[\d\s]*\d|\d)",
            text,
        )
    )


def parse_summary(text: str, msg: Message) -> DailySummary | None:
    """Parse top-level aggregate numbers from an operational report."""
    if not is_operational_report(text):
        return None

    s = DailySummary()
    s.source = getattr(msg, "source", "telegram")
    s.source_id = str(msg.id)
    s.message_date = msg.date.isoformat()

    # 2024 posts used **Markdown bold** liberally — strip before any regex.
    text = _strip_markdown(text)

    # Try to extract reporting date + snapshot timestamp from the text itself.
    s.date, s.snapshot_at, s.notes = _parse_snapshot(text, msg.date)
    if not s.date:
        s.date = _extract_report_date(text, msg.date)

    # Detect multipart split (header ends with "(1/2)", "(2/2)", "[1/2]",
    # "[2/2]", "(2/3)", ...). Channel uses both round and square brackets,
    # and on at least one occasion (msg 15456) typo'd the separator as a
    # backslash: "(1\2)". Stored on the row so consumers / sanity-check /
    # future code don't need to re-derive it from the text.
    mp = re.search(r"[\(\[](\d+)[/\\](\d+)[\)\]]", text)
    if mp is not None:
        s.part = f"{int(mp.group(1))}/{int(mp.group(2))}"
        # Continuation parts (2/2, 3/3, ...) carry only per-direction
        # breakdowns, no global aggregate. Returning early leaves every
        # metric NULL so branch 1a doesn't greedily grab a per-direction
        # count as if it were a daily total.
        if int(mp.group(1)) > 1:
            return s

    s.combat_engagements = _parse_combat_engagements(text)

    # --- Missile strikes ---
    # "2 ракетних удари" / "ракетних ударів — 2" / "одного ракетного удару"
    s.missile_strikes = _extract_count(
        text,
        r"(\d[\d\s]*\d|\d)\s*ракетн(?:их|і|ий|ого|ому)\s*удар",
        r"завдав\s+(\w+)\s+ракетн(?:их|і|ий|ого|ому)\s*удар",
    )

    # --- Missiles used ---
    # "застосувавши 3 ракети" / "із застосуванням однієї ракети"
    s.missiles_used = _extract_count(
        text,
        r"(\d[\d\s]*\d|\d)\s*ракет[иі]?\b",
        r"застосуванням\s+(\w+)\s+ракет",
    )

    # --- Air strikes ---
    # "86 авіаційних ударів" / "51 авіаційного удару" (genitive sg)
    s.air_strikes = _extract_count(
        text,
        r"(\d[\d\s]*\d|\d)\s*авіаційн(?:их|і|ий|ого|ому)\s*удар",
        r"завдав\s+(\w+)\s+авіаційн(?:их|і|ий|ого|ому)\s*удар",
    )

    # --- KABs (guided aerial bombs) ---
    # "скинувши 312 КАБ" / "270 керованих авіабомб" / "151 керовану авіабомбу"
    # / "сім керованих бомб". The "авіа(ційн)?" prefix is now optional and
    # accepts the contracted form "авіабомб".
    s.kabs_dropped = _extract_count(
        text,
        r"(\d[\d\s]*\d|\d)\s*(?:КАБ|керован(?:их|і|у|ої)\s*"
        r"(?:авіа(?:ційн(?:их|і|у|ої))?\s*)?бомб)",
        r"(?:скинув(?:ши)?|застосував(?:ши)?)\s+(\w+)\s+керован(?:их|і|у|ої)\s*"
        r"(?:авіа(?:ційн(?:их|і|у|ої))?\s*)?бомб",
    )

    # --- Kamikaze drones ---
    # "4130 ударів дронами-камікадзе"
    # "дронів-камікадзе — 4130"
    # Accept both ASCII '-' and U+2013 '–' between "дрон" and "камікадзе".
    s.kamikaze_drones = (
        _extract_int(
            r"(\d[\d\s]*\d|\d)\s*(?:ударів\s*)?дрон(?:ів|ами|и)[\-–—]камікадзе",
            text,
        )
        or _extract_int(
            r"дрон(?:ів|ами|и)[\-–—]камікадзе\s*[\-–—:]\s*(\d[\d\s]*\d|\d)",
            text,
        )
    )

    # --- Shellings (artillery, mortar) ---
    # "2315 обстрілів" / "здійснив 2315 обстрілів"
    s.shellings = _extract_int(
        r"(\d[\d\s]*\d|\d)\s*обстріл(?:ів|и|ами)", text
    )

    # --- MLRS ---
    # "у тому числі 8 — з РСЗВ" / "зокрема 42 – із реактивних систем"
    # Accept ASCII '-', en-dash U+2013, em-dash U+2014, minus U+2212, plus "із".
    s.mlrs_shellings = _extract_int(
        r"(\d[\d\s]*\d|\d)\s*(?:[\-–—−]\s*)?(?:із|з)?\s*"
        r"(?:РСЗВ|реактивних\s*систем)",
        text,
    )

    return s


# ---------------------------------------------------------------------------
# Date extraction from Ukrainian text
# ---------------------------------------------------------------------------

UA_MONTHS = {
    "січня": 1, "лютого": 2, "березня": 3, "квітня": 4,
    "травня": 5, "червня": 6, "липня": 7, "серпня": 8,
    "вересня": 9, "жовтня": 10, "листопада": 11, "грудня": 12,
}

# Ukrainian word-form numbers. 1–10 cover essentially all per-direction
# counts and the small daily missile-strike totals; 11–100 are added so the
# (rare) word-form daily aggregate can be parsed too — e.g. msg 24737:
# "відбулося сто бойових зіткнень". Apostrophes are normalised to ' before
# lookup, so curly/Cyrillic forms work too.
UA_NUM = {
    "одного": 1, "одну": 1, "одне": 1, "одна": 1, "один": 1, "однієї": 1,
    "двох": 2, "два": 2, "дві": 2, "двічі": 2,
    "трьох": 3, "три": 3, "тричі": 3,
    "чотирьох": 4, "чотири": 4,
    "п'яти": 5, "п'ять": 5,
    "шести": 6, "шість": 6,
    "семи": 7, "сім": 7,
    "восьми": 8, "вісім": 8,
    "дев'яти": 9, "дев'ять": 9,
    "десяти": 10, "десять": 10,
    "одинадцять": 11, "дванадцять": 12, "тринадцять": 13, "чотирнадцять": 14,
    "п'ятнадцять": 15, "шістнадцять": 16, "сімнадцять": 17, "вісімнадцять": 18,
    "дев'ятнадцять": 19, "двадцять": 20, "тридцять": 30, "сорок": 40,
    "п'ятдесят": 50, "шістдесят": 60, "сімдесят": 70, "вісімдесят": 80,
    "дев'яносто": 90, "сто": 100,
}

def _extract_report_date(text: str, msg_date: datetime) -> str:
    """Fallback date extraction for posts without a parseable 'станом на' header."""
    # Pattern: "за 6 травня" — already states the content day, no shift.
    m = re.search(r"за\s+(\d{1,2})\s+(\w+)", text, re.IGNORECASE)
    if m:
        day, month_str = int(m.group(1)), m.group(2).lower()
        month = UA_MONTHS.get(month_str)
        if month:
            year = msg_date.year
            return f"{year}-{month:02d}-{day:02d}"

    # Pattern: "22:00 06.05.2026"
    m = re.search(r"(\d{2})\.(\d{2})\.(\d{4})", text)
    if m:
        day, month, year = int(m.group(1)), int(m.group(2)), int(m.group(3))
        return f"{year}-{month:02d}-{day:02d}"

    # Fallback
    return msg_date.strftime("%Y-%m-%d")


# ---------------------------------------------------------------------------
# Per-direction parsing
# ---------------------------------------------------------------------------

# Canonical direction names (Ukrainian → English label).
DIRECTION_NAMES = {
    # Key patterns in the posts → normalized English name
    "харківськ": "Kharkiv",
    "куп'янськ": "Kupiansk",  # apostrophe variants normalised before lookup
    "лиманськ": "Lyman",
    "сіверськ": "Siversk",
    "слов'янськ": "Sloviansk",
    "краматорськ": "Kramatorsk",
    "торецьк": "Toretsk",
    "покровськ": "Pokrovsk",
    "курахівськ": "Kurakhove",
    "костянтинівськ": "Kostiantynivka",
    "олександрівськ": "Oleksandrivka",
    "новопавлівськ": "Novopavlivka",
    "времівськ": "Vremivka",
    "гуляйпільськ": "Huliaipole",
    "оріхівськ": "Orikhiv",
    "придніпровськ": "Prydniprovske",
    "запорізьк": "Zaporizhzhia",
    "херсонськ": "Kherson",
    "волинськ": "Volyn",
    "поліськ": "Polissia",
    "сумськ": "Sumy",
    "курськ": "Kursk",
    "слобожанськ": "Slobozhanshchyna",
    "південнослобожанськ": "S-Slobozhanshchyna",
    "північнослобожанськ": "N-Slobozhanshchyna",
    "донецьк": "Donetsk",
    "чернігівськ": "Chernihiv",
    "шахтарськ": "Shakhtarsk",
}


def _normalize_direction(raw: str) -> str:
    """Map a Ukrainian direction mention to its English label.

    Apostrophe variants (U+02BC ʼ, U+2019 ’) are normalised to ASCII '
    before lookup so headers like "Куп'янському" / "Слов'янському" match.
    """
    lower = raw.lower().replace("ʼ", "'").replace("’", "'")
    for pattern, label in DIRECTION_NAMES.items():
        if pattern in lower:
            return label
    return raw.strip().title()


# Words captured by the direction regex that are NOT actually direction names —
# they come from prose like "На цьому напрямку…" / "На інших напрямках…".
DIRECTION_STOP_WORDS = {
    "цьому", "цих", "інших", "іншому", "цьом", "окремих",
    "даному", "визначених",  # "На даному напрямку" / "На визначених напрямках"
    "зазначеному",  # "На зазначеному напрямку"
    "найгарячіших",  # "На найгарячіших напрямках"
    "різних",  # "у різних напрямках"
    # Bare compass direction in prose like "БпЛА...на північному напрямку"
    # (drone flight direction), e.g. msg 15171. Note: if the 2022-era
    # "Northern Front" ever appears in older scrapes it'll need a different
    # disambiguator (bold-header context), not a stop-word removal.
    "північному",
}


def parse_directions(text: str, msg: Message, report_date: str) -> list[DirectionEntry]:
    """Extract per-direction engagement counts.

    The GS posts typically say things like:
      "На Покровському напрямку відбито 29 штурмових дій"
      "На Лиманському напрямку ворог здійснив 17 атак"
      "На Краматорському та Оріхівському напрямках ворог активних дій не проводив"
      "На Північно-Слобожанському і Курському напрямках відбулося три боєзіткнення"
    """
    text = _strip_markdown(text)
    entries = []

    # Direction headers may list up to three names, paired with "та"/"і"/"й"
    # at the end and (since Jun-2024, msg 15366) comma-separated in the
    # middle: "на Краматорському, Времівському та Оріхівському напрямках".
    # Endings are open-ended (lots of case variants) — we match anything
    # word-ish ending in a Cyrillic adjective ending common to direction
    # names. Allow ASCII '-' as well as en-dash U+2013 and em-dash U+2014
    # inside the name (e.g. "Північно–Слобожанському" uses U+2013).
    _DIR_STEM = r"[\w'ʼ’\-–—]+(?:ому|ій|их|ому|ім)"
    direction_pattern = re.compile(
        r"(?:На|У|В)\s+"
        r"(" + _DIR_STEM + r")"
        r"(?:,\s+(" + _DIR_STEM + r"))?"
        r"(?:\s+(?:та|і|й)\s+(" + _DIR_STEM + r"))?"
        r"\s+напрямк(?:у|ах|и)",
        re.IGNORECASE | re.UNICODE,
    )

    matches = list(direction_pattern.finditer(text))
    seen = set()

    for i, match in enumerate(matches):
        start = match.start()
        end = matches[i + 1].start() if i + 1 < len(matches) else min(start + 600, len(text))
        section = text[start:end]

        # "No activity" sentinel. When the section opens with a phrase that
        # says nothing happened on this direction (e.g. "ознак формування
        # наступальних угруповань ворога не виявлено", "активних дій не
        # проводив"), counts must be None. Otherwise an unrelated cumulative
        # paragraph that follows (msg 37227: a ceasefire-regime aggregate
        # with "провів 119 штурмових дій") gets falsely attributed to this
        # direction and trips the global combat_engagements sanity check.
        first_sentence = section.split(".", 1)[0]
        no_activity = re.search(
            r"ознак формування[^.]{0,80}не виявлено|"
            r"активних дій не проводив",
            first_sentence,
            re.IGNORECASE | re.UNICODE,
        )

        # Try to extract attack / engagement count from section. Digits first;
        # if no digit, try Ukrainian word forms (e.g. "відбили п'ять
        # боєзіткнень", "вісім разів штурмував", "три атаки").
        # \w doesn't include the apostrophe variants Ukrainian uses inside
        # number words ("п'ять", "дев'ять"), so the word-capture group has to
        # include them explicitly or the regex stops at "п".
        _NUMWORD = r"[\w'ʼ’]+"
        if no_activity:
            attacks = None
        else:
            attacks = _extract_count(
                section,
                r"(\d[\d\s]*\d|\d)\s*(?:штурмов|атак|бойов|боєзіткнен|разів|спроб)",
                r"(?:відбили|відбито|відбила|здійснив|штурмував|атакував|наступав|"
                r"намагалися|спроб[уи]вав)\w*\s+(" + _NUMWORD + r")\s+(?:штурмов|атак|"
                r"бойов|боєзіткнен|разів|раз[иі]|спроб|боєзіткнень)",
            )
            if attacks is None:
                attacks = _extract_count(
                    section,
                    r"відби(?:то|ла|ли)\s*(\d[\d\s]*\d|\d)",
                    r"відби(?:то|ла|ли)\s+(" + _NUMWORD + r")",
                )

        # Ongoing engagements: digit form or word form.
        if no_activity:
            ongoing = None
        else:
            ongoing = _extract_count(
                section,
                r"(\d[\d\s]*\d|\d)\s*(?:зіткнен|бо[ії]в|боєзіткнен|атак|спроб)"
                r"[\w\s]{0,30}трива",
                r"(" + _NUMWORD + r")\s+(?:зіткнен|бо[ії]в|боєзіткнен|атак|спроб)\w*"
                r"[\s\w]{0,30}\bтрива",
            )

        for raw in (match.group(1), match.group(2), match.group(3)):
            if not raw:
                continue
            if raw.lower() in DIRECTION_STOP_WORDS:
                continue
            dir_name = _normalize_direction(raw)
            if (msg.id, dir_name) in seen:
                continue
            seen.add((msg.id, dir_name))
            entries.append(DirectionEntry(
                date=report_date,
                source=getattr(msg, "source", "telegram"),
                source_id=str(msg.id),
                direction=dir_name,
                attacks=attacks,
                ongoing=ongoing,
            ))

    return entries


# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

# Target DB shape lives in ./schema.sql alongside this file. Loaded at import
# time and applied via executescript() in open_db(). One-shot migrations
# stay in Python (see _migrate_to_source_keyed_schema below) — the .sql file
# only describes the *target* shape.
SCHEMA_PATH = Path(__file__).parent / "schema.sql"
SCHEMA = SCHEMA_PATH.read_text(encoding="utf-8")


def _migrate_to_source_keyed_schema(conn: sqlite3.Connection) -> None:
    """One-shot migration: legacy schema (single message_id INTEGER PK on posts)
    → (source, source_id) composite key. No-op when the source column already
    exists or when posts doesn't exist yet (fresh DB). Wraps every step in a
    single transaction so a crash mid-migration leaves the DB usable.
    """
    cols = {r[1] for r in conn.execute("PRAGMA table_info(posts)")}
    if "source" in cols or "message_id" not in cols:
        return  # already on the new schema, or no data yet

    log.info("Migrating posts/directions to (source, source_id) primary key…")
    with conn:
        # daily_combined references columns we're about to rename — drop first.
        conn.execute("DROP VIEW IF EXISTS daily_combined")

        conn.execute("""
            CREATE TABLE posts_new (
                source              TEXT    NOT NULL,
                source_id           TEXT    NOT NULL,
                date                TEXT    NOT NULL,
                message_date        TEXT    NOT NULL,
                snapshot_at         TEXT,
                text                TEXT    NOT NULL,
                url                 TEXT    NOT NULL,
                combat_engagements  INTEGER,
                missile_strikes     INTEGER,
                missiles_used       INTEGER,
                air_strikes         INTEGER,
                kabs_dropped        INTEGER,
                kamikaze_drones     INTEGER,
                shellings           INTEGER,
                mlrs_shellings      INTEGER,
                scraped_at          TEXT    NOT NULL,
                notes               TEXT,
                part                TEXT,
                PRIMARY KEY (source, source_id)
            )
        """)
        conn.execute("""
            INSERT INTO posts_new
            SELECT 'telegram', CAST(message_id AS TEXT),
                   date, message_date, snapshot_at, text, url,
                   combat_engagements, missile_strikes, missiles_used,
                   air_strikes, kabs_dropped, kamikaze_drones,
                   shellings, mlrs_shellings, scraped_at, notes, part
            FROM posts
        """)
        conn.execute("DROP TABLE posts")
        conn.execute("ALTER TABLE posts_new RENAME TO posts")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_posts_date ON posts(date)")

        conn.execute("""
            CREATE TABLE directions_new (
                source      TEXT    NOT NULL,
                source_id   TEXT    NOT NULL,
                direction   TEXT    NOT NULL,
                attacks     INTEGER,
                ongoing     INTEGER,
                PRIMARY KEY (source, source_id, direction),
                FOREIGN KEY (source, source_id)
                    REFERENCES posts(source, source_id) ON DELETE CASCADE
            )
        """)
        conn.execute("""
            INSERT INTO directions_new
            SELECT 'telegram', CAST(message_id AS TEXT),
                   direction, attacks, ongoing
            FROM directions
        """)
        conn.execute("DROP TABLE directions")
        conn.execute("ALTER TABLE directions_new RENAME TO directions")

        conn.execute("""
            CREATE VIEW daily_combined AS
            SELECT
                source,
                date,
                snapshot_at,
                MIN(message_date)              AS message_date,
                GROUP_CONCAT(source_id, ',')   AS source_ids,
                MAX(combat_engagements)        AS combat_engagements,
                MAX(missile_strikes)           AS missile_strikes,
                MAX(missiles_used)             AS missiles_used,
                MAX(air_strikes)               AS air_strikes,
                MAX(kabs_dropped)              AS kabs_dropped,
                MAX(kamikaze_drones)           AS kamikaze_drones,
                MAX(shellings)                 AS shellings,
                MAX(mlrs_shellings)            AS mlrs_shellings,
                GROUP_CONCAT(notes, ' | ')     AS notes
            FROM posts
            GROUP BY source, date, snapshot_at
        """)
    log.info("Migration complete.")


def open_db(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    # IMPORTANT: foreign_keys stays OFF during migration. If we DROP the old
    # posts table with FK enforcement active, the ON DELETE CASCADE on
    # directions wipes the directions table out from under us. Only turn
    # FK enforcement back on after both tables have been rebuilt.
    _migrate_to_source_keyed_schema(conn)
    conn.execute("PRAGMA foreign_keys = ON")
    conn.executescript(SCHEMA)
    return conn


def _sanity_check(
    summary: "DailySummary",
    directions: list["DirectionEntry"],
    text: str = "",
) -> None:
    """Emit WARN-level logs for parsed reports that look off.

    Cheap insurance against silent regressions when the channel changes wording:
    if any of these fire on a fresh scrape, the regexes probably need an update.
    """
    sid = summary.source_id
    src_tag = "" if summary.source == "telegram" else f"{summary.source}:"
    try:
        posted = (
            datetime.fromisoformat(summary.message_date)
            .astimezone(KYIV_TZ)
            .strftime("%Y-%m-%d %H:%M")
        )
        prefix = f"msg {src_tag}{sid} (posted {posted} Kyiv)"
    except ValueError:
        prefix = f"msg {src_tag}{sid}"

    # Late-2024 multi-part posts: part 2+ carries only direction breakdowns,
    # no aggregate. Skip the "missing combat" / unusual-direction warnings.
    is_multipart = summary.part is not None

    if summary.snapshot_at is None:
        log.warning(f"{prefix}: snapshot_at is NULL — header regex may have drifted")

    # Cross-check the global combat_engagements against per-direction
    # attacks and against a branch-4-only probe — two recovery layers:
    #
    # (a) branch-4 probe: when an earlier unanchored branch (1a or 3)
    #     grabbed a per-direction value, the global aggregate is often a
    #     clean kil_kist form ("кількість X зросла до N") that branch 4
    #     would catch in isolation. Compare its result against the
    #     current value and the max direction attacks. This catches the
    #     branch-3 case where combat ≥ max(directions) and the
    #     impossibility check below doesn't fire.
    #
    # (b) impossibility check: the global is the sum of all directions,
    #     so it must be ≥ the biggest individual direction. When it's
    #     not, branch 1a has almost certainly grabbed a per-direction "N
    #     бойових зіткнень" line. Retry the chain with branch 1a
    #     skipped; if a later branch returns a sane value, use it.
    #     Otherwise null the field.
    if summary.combat_engagements is not None and directions:
        max_attacks = max(
            (d.attacks for d in directions if d.attacks is not None),
            default=0,
        ) or 0
        stripped = _strip_markdown(text) if text else ""

        # (a) Branch-4 probe.
        if stripped:
            b4 = _parse_combat_engagements(stripped, only_branch_4=True)
            if (
                b4 is not None
                and b4 > summary.combat_engagements
                and b4 >= max_attacks
            ):
                bad_value = summary.combat_engagements
                log.warning(
                    f"{prefix}: combat_engagements ({bad_value}) looks "
                    f"like a per-direction value — branch 4 probe gives "
                    f"{b4} (>= max direction attacks {max_attacks}); "
                    f"preferring branch-4 value"
                )
                summary.combat_engagements = b4

        # (b) Impossibility recovery.
        if summary.combat_engagements < max_attacks:
            bad_value = summary.combat_engagements
            recovered = None
            if stripped:
                candidate = _parse_combat_engagements(stripped, skip_branch_1a=True)
                if candidate is not None and candidate >= max_attacks:
                    recovered = candidate
            if recovered is not None:
                log.warning(
                    f"{prefix}: combat_engagements ({bad_value}) "
                    f"< max direction attacks ({max_attacks}); "
                    f"recovered {recovered} by skipping branch 1a "
                    f"(misparsed per-direction value)"
                )
                summary.combat_engagements = recovered
            else:
                log.warning(
                    f"{prefix}: combat_engagements ({bad_value}) "
                    f"< max direction attacks ({max_attacks}) — impossible; "
                    f"clearing as likely per-direction value misparsed as global"
                )
                summary.combat_engagements = None

    if summary.combat_engagements is None and not is_multipart:
        log.warning(f"{prefix}: combat_engagements is NULL on an operational report")
    if not is_multipart:
        if not directions:
            log.warning(f"{prefix}: no directions parsed")
        elif not (5 <= len(directions) <= 20):
            log.warning(f"{prefix}: unusual direction count ({len(directions)})")
    if summary.combat_engagements is not None and not (0 <= summary.combat_engagements <= 500):
        log.warning(
            f"{prefix}: combat_engagements out of expected range "
            f"({summary.combat_engagements})"
        )
    if summary.notes:
        log.warning(f"{prefix}: {summary.notes}")
    # Surface direction labels that fell through _normalize_direction's
    # DIRECTION_NAMES lookup — those still contain Cyrillic and likely need
    # a new dict entry.
    for d in directions:
        if any("Ѐ" <= ch <= "ӿ" for ch in d.direction):
            log.warning(
                f"{prefix}: unmapped direction {d.direction!r} — "
                f"add a stem to DIRECTION_NAMES"
            )


def upsert_report(
    conn: sqlite3.Connection,
    summary: "DailySummary",
    directions: list["DirectionEntry"],
    text: str,
    url: str,
) -> None:
    """Insert-or-replace a single operational report and its directions."""
    _sanity_check(summary, directions, text)
    conn.execute(
        """
        INSERT OR REPLACE INTO posts (
            source, source_id, date, message_date, snapshot_at, text, url,
            combat_engagements, missile_strikes, missiles_used, air_strikes,
            kabs_dropped, kamikaze_drones, shellings, mlrs_shellings,
            scraped_at, notes, part
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            summary.source, summary.source_id,
            summary.date, summary.message_date,
            summary.snapshot_at, text, url,
            summary.combat_engagements, summary.missile_strikes,
            summary.missiles_used, summary.air_strikes,
            summary.kabs_dropped, summary.kamikaze_drones,
            summary.shellings, summary.mlrs_shellings,
            datetime.now(timezone.utc).isoformat(),
            summary.notes,
            summary.part,
        ),
    )
    conn.execute(
        "DELETE FROM directions WHERE source = ? AND source_id = ?",
        (summary.source, summary.source_id),
    )
    if directions:
        conn.executemany(
            """
            INSERT INTO directions (source, source_id, direction, attacks, ongoing)
            VALUES (?, ?, ?, ?, ?)
            """,
            [
                (summary.source, summary.source_id, d.direction, d.attacks, d.ongoing)
                for d in directions
            ],
        )


# ---------------------------------------------------------------------------
# Main scraping loop
# ---------------------------------------------------------------------------

def _gate_failure_reason(text: str) -> str:
    """For a text that failed is_operational_report, identify which clause
    failed. Used by --debug-rejected to make the rejection log useful.
    """
    stripped = _strip_markdown(text)
    if not re.search(OPERATIONAL_REPORT_PATTERNS[0], stripped):
        return "no 'Оперативна інформація' phrase"
    if not SNAPSHOT_RE.search(stripped):
        return "no 'станом на HH:MM DD.MM.YYYY' header"
    other_matches = sum(1 for p in OPERATIONAL_REPORT_PATTERNS[1:] if re.search(p, stripped))
    if other_matches < 1:
        return "no body markers (бойових зіткнень / протягом доби / від початку доби)"
    return "(unknown — all gate checks passed?)"


async def scrape(
    client: TelegramClient,
    conn: sqlite3.Connection,
    since: datetime | None = None,
    until: datetime | None = None,
    debug_rejected: bool = False,
):
    """Fetch messages from the GS channel, parse, and write to SQLite.

    Rate limiting strategy:
    - Telethon's iter_messages fetches in batches of 100 (one API call each).
    - We sleep BATCH_PAUSE seconds between batches to stay well under limits.
    - If Telegram sends a FloodWaitError anyway, we respect the wait time
      plus a small margin, then retry automatically.
    - A checkpoint file tracks the last processed message ID so you can
      resume if interrupted (Ctrl-C, network drop, etc.).
    - Each parsed report is upserted into the DB immediately, so even an
      interrupted run leaves a valid, queryable database.
    """
    explicit_window = since is not None or until is not None
    offset_date = since if since is not None else SCRAPE_SINCE
    log.info(
        f"Fetching messages from @{CHANNEL} "
        f"(since={since.isoformat() if since else 'all'}, "
        f"until={until.isoformat() if until else 'now'})..."
    )

    # --- Resume from checkpoint if available, else from highest stored id ---
    # Skipped when the user asked for an explicit window: in that case we want
    # exactly that window, even if it overlaps already-stored posts (re-parse
    # via INSERT OR REPLACE).
    min_id = 0
    if not explicit_window:
        if CHECKPOINT_FILE.exists():
            try:
                min_id = int(CHECKPOINT_FILE.read_text().strip())
                log.info(f"Resuming from checkpoint: message_id > {min_id}")
            except ValueError:
                pass
        if min_id == 0:
            # source_id is TEXT now — only Telegram rows have integer-shaped ids,
            # so cast and filter explicitly.
            row = conn.execute(
                "SELECT MAX(CAST(source_id AS INTEGER)) FROM posts "
                "WHERE source = 'telegram'"
            ).fetchone()
            if row and row[0]:
                min_id = row[0]
                log.info(f"Resuming after highest stored message_id: {min_id}")

    count = 0
    batch_count = 0
    reports_found = 0
    last_msg_id = min_id

    try:
        async for msg in client.iter_messages(
            CHANNEL,
            reverse=True,
            offset_date=offset_date,
            min_id=min_id,
        ):
            if not isinstance(msg, Message) or not msg.text:
                continue

            if until is not None and msg.date > until:
                log.info(f"Reached --until ({until.isoformat()}); stopping.")
                break

            text = msg.text
            count += 1
            batch_count += 1
            last_msg_id = msg.id

            # --- Rate limiting: pause between batches ---
            if batch_count >= BATCH_SIZE:
                batch_count = 0
                log.debug(f"  Pausing {BATCH_PAUSE}s between batches...")
                await asyncio.sleep(BATCH_PAUSE)

            if count % 500 == 0:
                log.info(f"  ...processed {count} messages (at {msg.date.date()})")
                conn.commit()
                _save_checkpoint(msg.id)

            if not is_operational_report(text):
                if debug_rejected:
                    reason = _gate_failure_reason(text)
                    preview = " ".join(text.split())[:200]
                    log.info(
                        f"REJECTED msg {msg.id} ({msg.date.date()}): {reason} | {preview!r}"
                    )
                continue

            summary = parse_summary(text, msg)
            if summary:
                dirs = parse_directions(text, msg, summary.date)
                url = f"https://t.me/{CHANNEL}/{msg.id}"
                upsert_report(conn, summary, dirs, text, url)
                reports_found += 1

    except FloodWaitError as e:
        wait = e.seconds + FLOOD_WAIT_MARGIN
        log.warning(
            f"FloodWaitError: Telegram says wait {e.seconds}s. "
            f"Sleeping {wait}s then resuming..."
        )
        conn.commit()
        _save_checkpoint(last_msg_id)
        await asyncio.sleep(wait)
        log.info("Retrying after flood wait. Re-run the script to continue.")

    except KeyboardInterrupt:
        log.info("Interrupted by user. Saving progress...")

    conn.commit()
    log.info(
        f"Done. Processed {count} messages total, "
        f"upserted {reports_found} operational reports → {DB_PATH}"
    )

    if last_msg_id > min_id:
        _save_checkpoint(last_msg_id)
        log.info("Checkpoint saved. Re-run to continue from where you left off.")
    else:
        if CHECKPOINT_FILE.exists():
            CHECKPOINT_FILE.unlink()
            log.info("Scrape complete. Checkpoint removed.")


def _save_checkpoint(msg_id: int):
    """Save the last processed message ID so we can resume later."""
    CHECKPOINT_FILE.parent.mkdir(parents=True, exist_ok=True)
    CHECKPOINT_FILE.write_text(str(msg_id))


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def _parse_date_arg(s: str, end_of_day: bool = False) -> datetime:
    try:
        d = datetime.strptime(s, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except ValueError as e:
        raise argparse.ArgumentTypeError(f"expected YYYY-MM-DD, got {s!r}") from e
    if end_of_day:
        d = d.replace(hour=23, minute=59, second=59)
    return d


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Scrape @GeneralStaffZSU operational reports into SQLite.",
    )
    p.add_argument(
        "--since", type=lambda s: _parse_date_arg(s),
        help="Only fetch messages on or after this date (YYYY-MM-DD, UTC).",
    )
    p.add_argument(
        "--until", type=lambda s: _parse_date_arg(s, end_of_day=True),
        help="Only fetch messages on or before this date (YYYY-MM-DD, UTC, inclusive).",
    )
    p.add_argument(
        "--debug-rejected", action="store_true",
        help="Log each message that is_operational_report() rejects, with which "
             "gate component failed and a text preview. Use when scrolling a "
             "month and 'upserted 0' to figure out which gate clause changed.",
    )
    return p.parse_args()


async def main():
    args = parse_args()

    if not API_ID or not API_HASH:
        print(
            "ERROR: Set TELEGRAM_API_ID and TELEGRAM_API_HASH.\n"
            "  1. Go to https://my.telegram.org → API development tools\n"
            "  2. Create an application to get your api_id and api_hash\n"
            "  3. Set them as environment variables or in a .env file:\n"
            "       TELEGRAM_API_ID=12345678\n"
            "       TELEGRAM_API_HASH=abcdef1234567890abcdef1234567890\n"
        )
        return

    client = TelegramClient(SESSION_NAME, int(API_ID), API_HASH)

    # flood_sleep_threshold: if Telegram asks us to wait ≤ this many seconds,
    # Telethon will sleep automatically and retry. For longer waits, it raises
    # FloodWaitError so our code can save a checkpoint and exit gracefully.
    client.flood_sleep_threshold = 60  # auto-sleep for waits up to 60s

    conn = open_db(DB_PATH)
    try:
        async with client:
            await scrape(
                client, conn,
                since=args.since, until=args.until,
                debug_rejected=args.debug_rejected,
            )
    finally:
        conn.close()


if __name__ == "__main__":
    asyncio.run(main())
