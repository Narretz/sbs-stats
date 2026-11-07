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
    at_least   — "понад N" / "більше N" / "щонайменше N" / "не менше N" / …
    approx     — "близько N" / "приблизно N" / "майже N" / "орієнтовно N"
    up_to      — "до N"
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
    # Counter-like items ("NUM <Ukrainian noun>") that no category claimed —
    # SBU lists one counter per line in a fixed box, so an unclaimed line means
    # either a brand-new category or wording drift. Surfaced as a warning by the
    # callers (ingest.py / discover.py) so a silent drop can't hide.
    unmatched: list[str] = field(default_factory=list)


# --- helpers ---------------------------------------------------------------

# Numbers in the source use space-separated thousands ("10 200"); after
# extract_text() collapses whitespace, this stays as "10 200". We allow either
# bare digits ("\d+") or grouped digits ("\d{1,3}(?:\s\d{3})+"); _to_int strips
# the separators. A rounded headline can also be given in thousands — "майже
# 11 тис. окупантів" (Oct 2026), and by extension "10,5 тис." / "11 тисяч" —
# which _to_int scales back up. First, so "11" alone doesn't win at the same
# position.
_NUM = r"(\d+(?:[.,]\d+)?\s*тис(?:\.|яч\w*)|\d{1,3}(?:\s\d{3})+|\d+)"
_THOUSANDS = re.compile(r"(\d+(?:[.,]\d+)?)\s*тис", re.I)


def _to_int(s: str) -> int:
    k = _THOUSANDS.match(s)
    if k:
        return round(float(k.group(1).replace(",", ".")) * 1000)
    return int(s.replace(" ", ""))


# Ukrainian genitive-month → month number. SBU writes "за підсумками травня",
# "за результатами квітня" etc. (genitive).
_UA_MONTH_GEN = {
    "січня": 1, "лютого": 2, "березня": 3, "квітня": 4, "травня": 5, "червня": 6,
    "липня": 7, "серпня": 8, "вересня": 9, "жовтня": 10, "листопада": 11, "грудня": 12,
}
# Locative fallback — the June 2026 recap opens with "У червні наші..." and
# nowhere uses the "за підсумками/результатами <month>" phrasing, so we need
# to recognise the locative form too. Anchored on preceding "у "/"в " to
# avoid grabbing unrelated locatives that share the -і/-у ending.
_UA_MONTH_LOC = {
    "січні": 1, "лютому": 2, "березні": 3, "квітні": 4, "травні": 5, "червні": 6,
    "липні": 7, "серпні": 8, "вересні": 9, "жовтні": 10, "листопаді": 11, "грудні": 12,
}

_PERIOD_RE = re.compile(
    r"(?:за\s+(?:підсумками|результатами)\s+(\w+)|за\s+минулий\s+місяць)",
    re.I,
)
_PERIOD_RE_LOC = re.compile(
    r"\b[ув]\s+(" + "|".join(_UA_MONTH_LOC) + r")\b",
    re.I,
)
# Year hint from article date stamps like "9 червня 2026" or "12 Травня, 2026".
_YEAR_RE = re.compile(r"\b(20\d{2})\b")


def _detect_period(text: str) -> tuple[str | None, str | None]:
    """Return (period, precision) — ('2026-05','month') etc., or (None,None).

    Two phrasings seen so far:
      Mar/Apr/May: 'за підсумками <month-genitive>' or 'за результатами …'
      Jun:         'У <month-locative>' with no 'за підсумками' anywhere

    The headline often contains 'за результатами бойової роботи у квітні'
    (group(1) here captures 'бойової', not a month) BEFORE the body's true
    'За підсумками квітня'. So we iterate matches and accept the first one
    whose captured word is a known month genitive. If no genitive is found,
    fall back to the "[у|в] <locative>" pattern.
    """
    month = None
    for m in _PERIOD_RE.finditer(text):
        word = (m.group(1) or "").lower()
        month = _UA_MONTH_GEN.get(word)
        if month:
            break
    if not month:
        m = _PERIOD_RE_LOC.search(text)
        if m:
            month = _UA_MONTH_LOC.get(m.group(1).lower())
    if not month:
        return None, None
    year_m = _YEAR_RE.search(text)
    if not year_m:
        return None, None
    return f"{int(year_m.group(1)):04d}-{month:02d}", "month"


# Bound qualifiers that can stand directly before a number — the headline KIA
# is the line that carries one ("понад 10 200", "майже 6000", "майже 11 тис.").
# Keyed by the phrase with its whitespace collapsed; the regex tries longer
# phrases first ("більше ніж" before "більше", "не менше ніж" before "не
# менше").
_BOUND_MAP = {
    # at least
    "понад": "at_least",
    "більше ніж": "at_least",
    "більше за": "at_least",
    "більш ніж": "at_least",
    "більш як": "at_least",
    "більше": "at_least",
    "щонайменше": "at_least",
    "не менше ніж": "at_least",
    "не менше за": "at_least",
    "не менш ніж": "at_least",
    "не менш як": "at_least",
    "не менше": "at_least",
    "принаймні": "at_least",
    "як мінімум": "at_least",
    "мінімум": "at_least",
    # approximately — "майже" ("almost") is just under, which the four-way
    # bound model has no slot for; approx is the honest reading
    "близько": "approx",
    "приблизно": "approx",
    "майже": "approx",
    "орієнтовно": "approx",
    "біля": "approx",
    "майже до": "up_to",
    # at most
    "до": "up_to",
    "не більше ніж": "up_to",
    "не більше": "up_to",
}
_BOUND_PREFIX = re.compile(
    r"(?<!\w)("
    + "|".join(re.escape(k).replace(r"\ ", r"\s+") for k in sorted(_BOUND_MAP, key=len, reverse=True))
    + r")\s+$",
    re.I,
)


def _bound_for_match(text: str, num_start: int) -> str:
    """The qualifier standing directly before the number, if any. Anchored to
    the number — a qualifier further back belongs to some other figure, and an
    unanchored search found "до" inside words ("водного")."""
    m = _BOUND_PREFIX.search(text[max(0, num_start - 30):num_start])
    if not m:
        return "exact"
    return _BOUND_MAP.get(re.sub(r"\s+", " ", m.group(1).lower()), "exact")


# --- categories ------------------------------------------------------------

# Each category is one or more regex variants. Each variant captures a number
# group; the surrounding ~25 chars are checked for bound prefixes.
#
# IMPORTANT — variants are tried in order, FIRST match wins per category. So
# the more specific pattern goes first (e.g. tanks before generic armored).

CATEGORIES: list[tuple[str, list[re.Pattern[str]]]] = [
    # Headline KIA — "понад N окупантів/піхотинців", "майже 11 тис. окупантів".
    # The noun is the anchor, so it takes the likely alternatives too; the
    # qualifier in front of the number is _bound_for_match's.
    ("enemy_kia", [
        re.compile(
            rf"{_NUM}\s+(?:(?:російських|ворожих)\s+)*"
            r"(?:піхотинців|окупантів|загарбників|росіян|військовослужбовців|солдатів"
            r"|(?:одиниць\s+)?(?:живої\s+сили|особового\s+складу))",
            re.I,
        ),
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

    # Comms / surveillance. Two distinct phrasings — "антен(и) та вузл(ів|и)
    # зв'язку" (May/Jun) and "засобів спостереження (та|і) зв'язку" (Mar/Apr).
    # Case endings vary with the preceding numeral (gen. after 5–20/0; nom.
    # after 2/3/4), so both regexes are permissive on the suffixes. "вузол" is
    # the odd one out: the nominative/accusative SINGULAR (after a numeral
    # ending in 1 — "2791 антену та вузол зв'язку", Aug 2026) keeps the -о-
    # that every other form drops, so `вузл\w+` alone misses it.
    ("comms", [
        re.compile(rf"{_NUM}\s+антен\w*\s+та\s+вуз(?:ол|л\w+)\s+зв", re.I),
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
    # IFVs — "бойових броньованих машин" (gen. pl. after 5+/0) / "бойові
    # броньовані машини" (nom. pl. after 2/3/4, e.g. "33 бойові броньовані
    # машини", Aug 2026). Stems + \w+ cover both, and the optional soft sign
    # in "бронь?ован" matches the armored_total spelling drift too.
    # And abbreviated, "1 танк та 8 ББМ" (Oct 2026).
    ("ifvs", [
        re.compile(rf"{_NUM}\s+бойов\w+\s+бронь?ован\w+\s+машин\w*", re.I),
        re.compile(rf"{_NUM}\s+ББМ", re.I),
    ]),

    ("air_defense", [
        # Suffix on "засоб" varies with the numeral (nom. pl. "засоби" after
        # 2/3/4 → "23 засоби ППО"; gen. pl. "засобів" after 5+/0 → "35 засобів
        # ППО"), so match the stem with \w+ rather than the hard-coded genitive.
        re.compile(rf"{_NUM}\s+засоб\w+\s+ППО", re.I),
        re.compile(rf"{_NUM}\s+засоб\w+\s+протиповітрян\w+\s+оборони", re.I),
    ]),
    # "N РЛС" (Apr/May) and "N засоби РЛС [та РЕБ]" (Jun). The latter bundles
    # EW into the same counter — we treat as one radar category since (a)
    # earlier months don't report EW separately, and (b) the values remain
    # in the same low-tens range (21/23/34), consistent with "same category
    # with a small widening" rather than a step-change. raw_label preserves
    # the "та РЕБ" phrasing so the audit note is honest.
    ("radar", [
        re.compile(rf"{_NUM}\s+РЛС", re.I),
        re.compile(rf"{_NUM}\s+засоб\w+\s+РЛС", re.I),
    ]),
    ("mlrs", [
        re.compile(rf"{_NUM}\s+РСЗВ", re.I),
        re.compile(rf"{_NUM}\s+реактивних\s+систем\s+залпового\s+вогню", re.I),
    ]),
    ("aircraft", [
        re.compile(rf"{_NUM}\s+літак", re.I),
        re.compile(rf"{_NUM}\s+одиниц\w+\s+авіаційн\w+\s+техніки", re.I),
    ]),
    ("watercraft", [
        re.compile(rf"{_NUM}\s+одиниц\w+\s+водн\w+\s+транспорт", re.I),
    ]),
    ("depots", [
        # "боєприпасами" is sometimes abbreviated "БК" (боєкомплект) —
        # "233 склади з БК та майном" (Jul 2026) vs "склади з боєприпасами".
        re.compile(rf"{_NUM}\s+склад\w*\s+(?:з|із)\s+(?:боєприпасами|БК)", re.I),
    ]),

    # UAV crews (drone-operator teams) — "N розрахунків БпЛА" (gen. pl. after
    # 5+/0) / "N розрахунки БпЛА" (nom. pl. after 2/3/4). Distinct from `drones`
    # (that pattern anchors the number directly on "БпЛА"; here "розрахунк\w+"
    # sits between), so the two never collide.
    ("drone_crews", [
        re.compile(rf"{_NUM}\s+розрахунк\w+\s+БпЛА", re.I),
    ]),

    # Command posts — "11 пунктів управління" (Oct 2026); "пункти" after 2/3/4.
    ("command_posts", [
        re.compile(rf"{_NUM}\s+пункт\w*\s+управління", re.I),
    ]),
    # Tactical ballistic missile systems — "1 ОТРК «Іскандер»" (Oct 2026), or
    # spelled out ("оперативно-тактичний ракетний комплекс").
    ("missile_systems", [
        re.compile(rf"{_NUM}\s+ОТРК", re.I),
        re.compile(rf"{_NUM}\s+оперативно-тактичн\w+\s+ракетн\w+\s+комплекс", re.I),
    ]),
]


# --- drift detection -------------------------------------------------------
#
# The recap lists one counter per line ("NUM <unit-noun> …") in a fixed box.
# We flag any such item that no category regex claimed, so a new/renamed
# category surfaces as a warning instead of vanishing. A candidate item is a
# number NOT preceded by a word char or hyphen (excludes model codes like
# "Су-30" and phone digits) and directly followed by a Cyrillic word (the unit
# noun — excludes "4444 (дзвінки", "24/7", bare dates like "9 червня").
_ITEM_RE = re.compile(
    rf"(?<![\w/-]){_NUM}\s+([А-ЯЄІЇҐа-яєіїґ][’'A-Za-zА-ЯЄІЇҐа-яєіїґ-]*)", re.U
)
# Followers that never denote a counter — month names and year words, which
# appear in the article's date stamp ("7 серпня 2026 року").
_NONCOUNTER_FOLLOWERS = (
    set(_UA_MONTH_GEN) | set(_UA_MONTH_LOC) | {"року", "році", "рік"}
)


def _find_unmatched(text: str, claimed: list[tuple[int, int]]) -> list[str]:
    """Counter-like items no category claimed, restricted to the region the
    matched counters span. The recap page is wrapped in nav/related-article
    chrome full of stray numbers ("5 каналу", "0 Коментарі", date stamps); a
    genuinely-missed counter instead sits *among* the matched ones in the box,
    so bounding to [first matched start, last matched end] drops the chrome
    without needing to model the page layout. No matches → nothing to bound to,
    so we skip (a non-recap article isn't our concern here)."""
    if not claimed:
        return []
    lo = min(s for s, _ in claimed)
    hi = max(e for _, e in claimed)
    claimed_starts = {s for s, _ in claimed}
    out: list[str] = []
    for m in _ITEM_RE.finditer(text):
        start = m.start(1)
        if start < lo or start > hi or start in claimed_starts:
            continue
        if m.group(2).lower() in _NONCOUNTER_FOLLOWERS:
            continue
        end = min(len(text), m.end(2) + 25)
        out.append(re.sub(r"\s+", " ", text[start:end]).strip())
    return out


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
    claimed: list[tuple[int, int]] = []
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
            claimed.append((num_start, m.end()))
            break  # first variant wins per category

    return ParsedReport(
        period=period,
        period_precision=precision,
        report_type=report_type,
        counters=counters,
        unmatched=_find_unmatched(text, claimed),
    )
