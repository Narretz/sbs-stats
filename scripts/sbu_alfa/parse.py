#!/usr/bin/env python3
"""
parse.py — extract structured counters from an SBU "Альфа" monthly recap article.

Source: ssu.gov.ua/novyny/alfa-sbu-* (and mirrors). The unit publishes a monthly
"TOP-1 серед підрозділів Сил оборони" recap that lists enemy losses for the
month — roughly 10–20 numeric counters covering KIA, drones, vehicles, armor,
artillery, air defense, etc.

This module does the pure text → rows transform; ingest.py handles I/O. Two
entry points:

    extract_text(html_str) -> str    — strip tags, collapse whitespace.
    parse(text)            -> ParsedReport(period, counters[])

The category-keyed approach (one regex per category, tried independently against
the whole text) is robust to wording drift between months — March uses inline
prose with commas, April uses ▪️ bullets, May uses bare numbered lines. All
three are the same data; the list rendering is incidental.

Bound model mirrors HUR (scripts/missile_stockpile/reports.json):
    exact      — bare number
    at_least   — "понад N" / "більше N" / "over N"   (every KIA line uses this)
    approx     — "близько N" / "приблизно N" / "~N"
    up_to      — "до N" / "≤ N"
    range      — value..value_max (not currently seen in Alpha recaps)
"""
from __future__ import annotations

import html
import re
from dataclasses import dataclass, field
from html.parser import HTMLParser

# --- text extraction -------------------------------------------------------

_DROP_TAGS = {"script", "style", "nav", "header", "footer", "svg", "iframe", "noscript"}


class _TextStrip(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.out: list[str] = []
        self._skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in _DROP_TAGS:
            self._skip += 1

    def handle_endtag(self, tag):
        if tag in _DROP_TAGS:
            self._skip = max(0, self._skip - 1)

    def handle_data(self, data):
        if not self._skip:
            self.out.append(data)


def extract_text(html_str: str) -> str:
    """Strip HTML, collapse whitespace, unescape entities. Idempotent on plain text."""
    p = _TextStrip()
    p.feed(html_str)
    text = " ".join(p.out)
    text = html.unescape(text)
    # NBSP/thin-space → regular space (important: numbers like "10 200" use 0x00A0)
    text = text.replace(" ", " ").replace(" ", " ").replace(" ", " ")
    text = re.sub(r"\s+", " ", text).strip()
    return text


# --- data model ------------------------------------------------------------

@dataclass
class Counter:
    category: str           # canonical key, see CATEGORIES below
    value: int              # the number; low end for range
    bound: str              # exact | at_least | approx | up_to | range
    raw_label: str          # verbatim Ukrainian phrasing for audit
    value_max: int | None = None


@dataclass
class ParsedReport:
    period: str | None      # YYYY-MM for monthly, YYYY for annual; None if undetected
    period_precision: str | None  # 'month' | 'year' | None
    report_type: str        # monthly_top1 | annual | themed | unknown
    counters: list[Counter] = field(default_factory=list)


# --- helpers ---------------------------------------------------------------

# Numbers in the source use space-separated thousands ("10 200"); after
# extract_text() collapses whitespace, this stays as "10 200". We allow either
# bare digits ("\d+") or grouped digits ("\d{1,3}(?:\s\d{3})+"); _to_int strips
# the separators.
_NUM = r"(\d{1,3}(?:\s\d{3})+|\d+)"


def _to_int(s: str) -> int:
    return int(s.replace(" ", ""))


# Ukrainian genitive-month → month number. SBU writes "за підсумками травня",
# "за результатами квітня" etc. (genitive).
_UA_MONTH_GEN = {
    "січня": 1, "лютого": 2, "березня": 3, "квітня": 4, "травня": 5, "червня": 6,
    "липня": 7, "серпня": 8, "вересня": 9, "жовтня": 10, "листопада": 11, "грудня": 12,
}

_PERIOD_RE = re.compile(
    r"(?:за\s+(?:підсумками|результатами)\s+(\w+)|за\s+минулий\s+місяць)",
    re.I,
)
# Year hint from article date stamps like "9 червня 2026" or "12 Травня, 2026".
_YEAR_RE = re.compile(r"\b(20\d{2})\b")


def _detect_period(text: str) -> tuple[str | None, str | None]:
    """Return (period, precision) — ('2026-05','month') etc., or (None,None).

    The headline often contains 'за результатами бойової роботи у квітні'
    (genitive 'квітні' is locative not in our map; group(1) captures the
    *first* word after 'результатами', which here is 'бойової') BEFORE the
    body's true 'За підсумками квітня'. So we iterate matches and accept
    the first one whose captured word is a known month genitive.
    """
    month = None
    for m in _PERIOD_RE.finditer(text):
        word = (m.group(1) or "").lower()
        month = _UA_MONTH_GEN.get(word)
        if month:
            break
    if not month:
        return None, None
    year_m = _YEAR_RE.search(text)
    if not year_m:
        return None, None
    return f"{int(year_m.group(1)):04d}-{month:02d}", "month"


# Bound phrases that can prefix a number. Order matters: longer alternatives first.
_BOUND_PREFIX = re.compile(
    r"(понад|більше(?:\s+ніж)?|близько|приблизно|майже|до)\s+",
    re.I,
)
_BOUND_MAP = {
    "понад": "at_least",
    "більше": "at_least",
    "більше ніж": "at_least",
    "близько": "approx",
    "приблизно": "approx",
    "майже": "approx",
    "до": "up_to",
}


def _bound_for_match(text: str, num_start: int) -> str:
    """Look at the ~25 chars before the number and infer the bound qualifier."""
    window = text[max(0, num_start - 25):num_start]
    m = None
    for hit in _BOUND_PREFIX.finditer(window):
        m = hit  # take the last (= closest to the number)
    if not m:
        return "exact"
    return _BOUND_MAP.get(m.group(1).lower().strip(), "exact")


# --- categories ------------------------------------------------------------

# Each category is one or more regex variants. Each variant captures a number
# group; the surrounding ~25 chars are checked for bound prefixes.
#
# IMPORTANT — variants are tried in order, FIRST match wins per category. So
# the more specific pattern goes first (e.g. tanks before generic armored).

CATEGORIES: list[tuple[str, list[re.Pattern[str]]]] = [
    # Headline KIA — "понад N окупантів/піхотинців". Both phrasings appear.
    ("enemy_kia", [
        re.compile(rf"{_NUM}\s+(?:російських\s+)?(?:ворожих\s+)?(?:піхотинців|окупантів)", re.I),
    ]),

    # Aggregate "N інших цілей" + the destroyed/damaged split.
    ("targets_total", [
        re.compile(rf"{_NUM}\s+інших\s+цілей", re.I),
    ]),
    ("targets_destroyed", [
        # "5122 знищено" or "7649 — знищено". The em/en dash is optional.
        re.compile(rf"{_NUM}\s*[—–-]?\s*знищено", re.I),
    ]),
    ("targets_damaged", [
        re.compile(rf"{_NUM}\s*(?:—|–|-|ще\s+)?\s*пошкоджено", re.I),
    ]),

    # Drones — "БпЛА" (post-2024 spelling) or "безпілотник\w+ (противника)" in
    # older/prose form. Anchor on the noun so we don't match "БпЛА «Молнія»" in
    # themed posts where the same noun appears with a different number.
    ("drones", [
        re.compile(rf"{_NUM}\s+(?:БпЛА|безпілотник\w+)", re.I),
    ]),

    # Comms / surveillance. Two distinct phrasings — "антен та вузлів зв'язку"
    # (May) and "засобів спостереження (та|і) зв'язку" (Mar/Apr) — same category.
    ("comms", [
        re.compile(rf"{_NUM}\s+антен\s+та\s+вузлів\s+зв", re.I),
        re.compile(rf"{_NUM}\s+засобів\s+спостереження", re.I),
    ]),

    # Fortifications / engineering objects. Singular/plural drift handled by \w+.
    ("fortifications", [
        re.compile(rf"{_NUM}\s+фортифікац\w+", re.I),
    ]),

    # Vehicles — May lumps everything into "автомобільної техніки" (one total);
    # Mar/Apr split into light + moto + trucks. Keep all four counters; the
    # frontend picks which to render per month.
    ("vehicles_auto_total", [
        re.compile(rf"{_NUM}\s+одиниц\w+\s+автомобільн\w+\s+техніки", re.I),
    ]),
    ("vehicles_light", [
        re.compile(rf"{_NUM}\s+одиниц\w+\s+легк\w+\s+(?:авто)?транспорт", re.I),
    ]),
    ("vehicles_moto", [
        re.compile(rf"{_NUM}\s+мотоцикл\w*", re.I),
        re.compile(rf"{_NUM}\s+одиниц\w+\s+мототранспорт", re.I),
    ]),
    ("vehicles_trucks", [
        re.compile(rf"{_NUM}\s+вантажівок", re.I),
    ]),

    ("artillery", [
        re.compile(rf"{_NUM}\s+артилерійськ\w+\s+систем", re.I),
    ]),

    # Armored total — "одиниць (бронетехніки|броньованої техніки)". The tank
    # and IFV sub-split (when present) lives in dedicated counters; the parent
    # number is still recorded so March (which omits the split) has a value.
    ("armored_total", [
        re.compile(rf"{_NUM}\s+одиниц\w+\s+бронь?ован\w+\s+техніки", re.I),
        re.compile(rf"{_NUM}\s+одиниц\w+\s+бронетехніки", re.I),
    ]),
    ("tanks", [
        re.compile(rf"{_NUM}\s+танк", re.I),
    ]),
    ("ifvs", [
        re.compile(rf"{_NUM}\s+бойових\s+броньованих\s+машин", re.I),
    ]),

    ("air_defense", [
        re.compile(rf"{_NUM}\s+засобів\s+ППО", re.I),
    ]),
    ("radar", [
        re.compile(rf"{_NUM}\s+РЛС", re.I),
    ]),
    ("mlrs", [
        re.compile(rf"{_NUM}\s+РСЗВ", re.I),
        re.compile(rf"{_NUM}\s+реактивних\s+систем\s+залпового\s+вогню", re.I),
    ]),
    ("aircraft", [
        re.compile(rf"{_NUM}\s+літак", re.I),
    ]),
    ("watercraft", [
        re.compile(rf"{_NUM}\s+одиниц\w+\s+водн\w+\s+транспорт", re.I),
    ]),
    ("depots", [
        re.compile(rf"{_NUM}\s+склад\w+\s+з\s+боєприпасами", re.I),
    ]),
]


def _raw_label_for(text: str, m: re.Match[str], num_start: int) -> str:
    """The ~80-char window around the match — captures the verbatim phrasing."""
    bound_window_start = max(0, num_start - 25)
    end = min(len(text), m.end() + 40)
    snippet = text[bound_window_start:end].strip()
    return re.sub(r"\s+", " ", snippet)


def parse(text: str) -> ParsedReport:
    """Parse extracted body text into a ParsedReport. Idempotent."""
    period, precision = _detect_period(text)
    report_type = "monthly_top1" if precision == "month" else "unknown"

    counters: list[Counter] = []
    for category, patterns in CATEGORIES:
        for pat in patterns:
            m = pat.search(text)
            if not m:
                continue
            num_start = m.start(1)
            value = _to_int(m.group(1))
            bound = _bound_for_match(text, num_start)
            counters.append(Counter(
                category=category,
                value=value,
                bound=bound,
                raw_label=_raw_label_for(text, m, num_start),
            ))
            break  # first variant wins per category

    return ParsedReport(
        period=period,
        period_precision=precision,
        report_type=report_type,
        counters=counters,
    )
