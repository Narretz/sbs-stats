#!/usr/bin/env python3
"""
parse.py — extract structured counters from a «Рубикон» monthly recap post.

Source: the Telegram channel of the Russian UAV unit "Центр «Рубикон»"
(@icpbtrubicon). On the 3rd–4th of each month it posts a fixed-shape recap of
the previous month:

    🔴 Применение Центра «Рубикон» по плану начальника Генерального Штаба
       с 1 по 31 августа 2026 года.
    Выполнено 124 720 боевых вылетов.
    Поражены:
    Живая сила - 538
    Танки - 5
    …
    Также системами РЭБ было подавлено 5 672 вражеских дронов.

Three kinds of number come out of that, and they are NOT interchangeable —
each counter carries a `kind` so the frontend can keep them apart:

    sorties        "Выполнено N боевых вылетов" — unit activity, not damage.
    engaged        every "Label - N" line under "Поражены:" — targets the unit
                   claims to have hit. Rubikon says *поражены* ("engaged"),
                   with NO destroyed/damaged split (same as the SBU Alfa recap).
    ew_suppressed  "системами РЭБ было подавлено N вражеских дронов" — drones
                   jammed by electronic warfare, i.e. NOT kinetically engaged.
                   Kept separate and flagged in the UI so it can never be read
                   as part of the "поражены" total.

This module does the pure text → rows transform; ingest.py handles I/O.
stdlib only.
"""
from __future__ import annotations

import calendar
import re
from dataclasses import dataclass, field

# --- data model ------------------------------------------------------------

# Counter kinds — see the module docstring. `engaged` is the "Поражены:" list;
# the other two are single sentences that bracket it.
KIND_SORTIES = "sorties"
KIND_ENGAGED = "engaged"
KIND_EW = "ew_suppressed"


@dataclass
class Counter:
    category: str      # canonical key, see CATEGORY_ALIASES below
    value: int
    kind: str          # sorties | engaged | ew_suppressed
    raw_label: str     # verbatim Russian phrasing, for audit


@dataclass
class ParsedReport:
    period: str | None          # 'YYYY-MM' — the month the recap covers
    period_start: str | None    # 'YYYY-MM-DD'
    period_end: str | None      # 'YYYY-MM-DD'
    report_type: str            # 'monthly' | 'unknown'
    counters: list[Counter] = field(default_factory=list)
    # "Label - N" lines under "Поражены:" that no alias claimed. The post is a
    # fixed list, so an unclaimed line means a brand-new or renamed category —
    # surfaced as a warning by ingest.py so a silent drop can't hide. The raw
    # post text is stored in the DB, so `ingest.py --reparse` can recover the
    # value once an alias is added.
    unmatched: list[str] = field(default_factory=list)


# --- helpers ---------------------------------------------------------------

# Thousands are space-separated in the source ("124 720"), sometimes with a
# NBSP or narrow NBSP. Some months drop the separator entirely ("1209").
_NUM = r"(\d{1,3}(?:[\s  ]\d{3})+|\d+)"


def _to_int(s: str) -> int:
    return int(re.sub(r"[\s  ]", "", s))


# Russian genitive month names, as used in "с 1 по 31 августа 2026 года".
_RU_MONTH_GEN = {
    "января": 1, "февраля": 2, "марта": 3, "апреля": 4, "мая": 5, "июня": 6,
    "июля": 7, "августа": 8, "сентября": 9, "октября": 10, "ноября": 11,
    "декабря": 12,
}

# The recap headline. Anchored on "с 1 по <day> <month> <year>" — a FULL
# calendar month. That anchor is also the gate that rejects the channel's
# other "Применение Центра «Рубикон» …" posts: the 30 Dec 2025 cumulative
# report reads "на Красноармейском направлении с 14 апреля по 30 декабря
# 2025 года", which is a multi-month, direction-scoped total and must never
# land in a monthly series.
_PERIOD_RE = re.compile(
    r"с\s+1\s+по\s+(\d{1,2})\s+(" + "|".join(_RU_MONTH_GEN) + r")\s+(20\d{2})\s+года",
    re.I,
)

# "Выполнено 124 720 боевых вылетов." — combat sorties flown in the month.
_SORTIES_RE = re.compile(rf"Выполнено\s+{_NUM}\s+боевы\w*\s+вылет", re.I)

# "Также системами РЭБ было подавлено 5 672 вражеских дронов."
# `подавлен\w*` covers подавлено / подавлены / подавлен; "было" is optional
# because the channel drops the auxiliary in some months.
_EW_RE = re.compile(
    rf"системами\s+РЭБ\s+(?:было\s+)?подавлен\w*\s+{_NUM}\s+вражески\w+\s+дрон",
    re.I,
)

# One line of the "Поражены:" list: "<label> - <number>". The separator is a
# hyphen/en-dash/em-dash SURROUNDED BY SPACES — that's what keeps "Баба-Яга"
# (internal hyphen, no spaces) from being split at the wrong place.
_ITEM_RE = re.compile(
    rf"^\s*(?P<label>.*\S)\s+[-–—]\s+(?P<num>{_NUM})\s*$"
)

# Where the "Поражены:" list starts, and the boilerplate that ends the post.
_LIST_START_RE = re.compile(r"Поражены\s*:", re.I)
_LIST_END_RE = re.compile(r"(Также\s+системами\s+РЭБ|Продолжаем\s+выполнять)", re.I)


def _norm_label(label: str) -> str:
    """Canonical form of a list label for alias lookup.

    Lowercase, ё→е, quotes dropped, whitespace collapsed, spaces around a
    slash removed ("ПВД / ОП" → "пвд/оп"), trailing punctuation trimmed.
    Abbreviation dots INSIDE the label are kept ("букс. арт. оруд") — they're
    part of how the channel writes it and the aliases below match that.
    """
    s = label.lower().replace("ё", "е")
    s = re.sub(r"[«»\"“”]", "", s)
    s = re.sub(r"[\s  ]+", " ", s)
    s = re.sub(r"\s*/\s*", "/", s)
    return s.strip(" .:;·-–—")


# --- categories ------------------------------------------------------------
#
# Canonical key ← every normalised label the channel has used for it. Labels
# come from the eight monthly recaps published so far (2026-01 … 2026-08);
# singular/plural and abbreviated/expanded variants are listed pre-emptively
# because the channel is inconsistent between months (e.g. "Пункты управления"
# in January, "Пункт управления" in March).
#
# English labels for these keys live in src/types/index.ts
# (RUBIKON_CATEGORY_LABELS) and reuse the app's existing wording wherever the
# category is semantically the same as one we already chart elsewhere.
CATEGORY_ALIASES: dict[str, str] = {
    # Personnel.
    "живая сила": "personnel",

    # Armour.
    "танки": "tanks",
    "танк": "tanks",
    "ббм, бмп": "afv_ifv",
    "ббм/бмп": "afv_ifv",
    "ббм": "afv_ifv",
    "бмп": "afv_ifv",
    "бронетранспортеры": "apc",
    "бронетранспортер": "apc",
    "бтр": "apc",

    # Artillery.
    "сао": "spg",
    "сау": "spg",
    "букс. арт. оруд": "towed_artillery",
    "буксируемые арт. оруд": "towed_artillery",
    "буксируемые артиллерийские орудия": "towed_artillery",
    "рсзо": "mlrs",
    "минометы": "mortars",
    "миномет": "mortars",

    # Sensors / electronic warfare / comms. The channel reports radar, SIGINT
    # and EW as ONE bucket ("РЛС, РЭР, РЭБ") — we keep it as one counter
    # rather than pretending to a split the source doesn't make.
    "рлс, рэр, рэб": "radar_ew",
    "рлс/рэр/рэб": "radar_ew",
    "рлс, рэб": "radar_ew",
    "рлс": "radar_ew",
    "системы связи": "comms",
    "система связи": "comms",

    # Command & control.
    "пункты управления бпла": "uav_control_points",
    "пункт управления бпла": "uav_control_points",
    "пу бпла": "uav_control_points",
    "пункты управления": "command_posts",
    "пункт управления": "command_posts",

    # Positions and structures. "ПВД / ОП" = пункт временной дислокации /
    # опорный пункт — temporary deployment point / strongpoint.
    "пвд/оп": "deployment_points",
    "пвд": "deployment_points",
    "инженерные сооружения": "engineering_structures",
    "инженерное сооружение": "engineering_structures",
    "фортификационные сооружения": "fortifications",
    "фортификационное сооружение": "fortifications",
    "склады бк/гсм": "depots",
    "склад бк/гсм": "depots",
    "склады бк": "depots",
    "средства жизнеобесп": "life_support",
    "средства жизнеобеспечения": "life_support",

    # Vehicles.
    "инженерная тех": "engineering_vehicles",
    "инженерная техника": "engineering_vehicles",
    "мототехника": "motorcycles",
    "автомобильная тех": "vehicles",
    "автомобильная техника": "vehicles",

    # Weapons / air defense.
    # «Огневые средства» — literally "fire assets": anything that delivers
    # fire. Mortars, towed guns, SPGs, MLRS, ATGMs, SAMs and AA guns each get
    # their own line in this same list, so what lands here is the residual —
    # crew-served infantry weapons (HMGs, AGS) and unclassified firing points.
    # The counts fit that reading: 1–7 a month, one 51 outlier (Jul 2026).
    # Key kept literal (`fire_weapons`); the reading lives in the English label.
    "огневые средства": "fire_weapons",
    "огневое средство": "fire_weapons",
    "птрк": "atgm",
    "зрк": "sam",
    "зенитные установки": "aa_guns",
    "зенитная установка": "aa_guns",

    # Decoys.
    "макеты": "decoys",
    "макет": "decoys",

    # Unmanned systems. "Баба-Яга" is the Russian nickname for Ukraine's heavy
    # multirotor night-bomber drones; the channel counts them separately from
    # the generic "БПЛА" bucket, so we do too.
    "бпла": "uav",
    "баба-яга": "baba_yaga",
    "баба яга": "baba_yaga",
    "наземные дроны": "ugv",
    "наземный дрон": "ugv",
    "дроны самолетного типа": "fixed_wing_uav",
    "дрон самолетного типа": "fixed_wing_uav",
}

# The two counters that live outside the "Поражены:" list.
CATEGORY_SORTIES = "combat_sorties"
CATEGORY_EW = "uav_ew_suppressed"

# Every canonical key the parser can emit, in the order the frontend charts
# them. Kept here (not just in the alias map) so the ordering is one list.
CATEGORY_ORDER = [
    CATEGORY_SORTIES,
    "personnel",
    "tanks",
    "afv_ifv",
    "apc",
    "spg",
    "towed_artillery",
    "mlrs",
    "mortars",
    "atgm",
    "fire_weapons",
    "sam",
    "aa_guns",
    "radar_ew",
    "comms",
    "uav_control_points",
    "command_posts",
    "deployment_points",
    "engineering_structures",
    "fortifications",
    "depots",
    "life_support",
    "engineering_vehicles",
    "motorcycles",
    "vehicles",
    "decoys",
    "uav",
    "baba_yaga",
    "fixed_wing_uav",
    "ugv",
    CATEGORY_EW,
]


# --- parsing ---------------------------------------------------------------

def _detect_period(text: str) -> tuple[str | None, str | None, str | None]:
    """Return (period, period_start, period_end) or (None, None, None).

    Only a full calendar month qualifies: the headline must say "с 1 по <last
    day of that month>". A recap whose end day isn't the month's last day is a
    partial period we don't know how to place on a monthly axis, so it's
    rejected rather than charted as if it were a whole month.
    """
    m = _PERIOD_RE.search(text)
    if not m:
        return None, None, None
    end_day = int(m.group(1))
    month = _RU_MONTH_GEN[m.group(2).lower()]
    year = int(m.group(3))
    if end_day != calendar.monthrange(year, month)[1]:
        return None, None, None
    return (
        f"{year:04d}-{month:02d}",
        f"{year:04d}-{month:02d}-01",
        f"{year:04d}-{month:02d}-{end_day:02d}",
    )


def _list_section(text: str) -> str:
    """The slice of the post between "Поражены:" and the closing boilerplate."""
    start = _LIST_START_RE.search(text)
    if not start:
        return ""
    rest = text[start.end():]
    end = _LIST_END_RE.search(rest)
    return rest[: end.start()] if end else rest


def parse(text: str) -> ParsedReport:
    """Parse a recap post's text into a ParsedReport. Idempotent.

    Requires the post's line breaks to be intact — the "Поражены:" block is a
    one-counter-per-line list and that's what separates the labels.
    """
    period, period_start, period_end = _detect_period(text)
    if period is None:
        return ParsedReport(None, None, None, "unknown")

    counters: list[Counter] = []
    unmatched: list[str] = []

    m = _SORTIES_RE.search(text)
    if m:
        counters.append(Counter(
            category=CATEGORY_SORTIES,
            value=_to_int(m.group(1)),
            kind=KIND_SORTIES,
            raw_label=re.sub(r"\s+", " ", m.group(0)).strip(),
        ))

    seen: set[str] = set()
    for line in _list_section(text).splitlines():
        if not line.strip():
            continue
        item = _ITEM_RE.match(line)
        if not item:
            continue
        label = item.group("label").strip()
        category = CATEGORY_ALIASES.get(_norm_label(label))
        if not category:
            unmatched.append(re.sub(r"\s+", " ", line).strip())
            continue
        # Two lines mapping to the same category would collide on the DB's
        # (post_id, scraped_at, category) primary key. Never seen so far;
        # keep the first and surface the second as drift rather than crash.
        if category in seen:
            unmatched.append(re.sub(r"\s+", " ", line).strip())
            continue
        seen.add(category)
        counters.append(Counter(
            category=category,
            value=_to_int(item.group("num")),
            kind=KIND_ENGAGED,
            raw_label=label,
        ))

    m = _EW_RE.search(text)
    if m:
        counters.append(Counter(
            category=CATEGORY_EW,
            value=_to_int(m.group(1)),
            kind=KIND_EW,
            raw_label=re.sub(r"\s+", " ", m.group(0)).strip(),
        ))

    # A headline + period but no "Поражены:" list isn't the monthly recap —
    # it's some other dated post that happens to span a full month.
    report_type = "monthly" if any(c.kind == KIND_ENGAGED for c in counters) else "unknown"

    order = {k: i for i, k in enumerate(CATEGORY_ORDER)}
    counters.sort(key=lambda c: order.get(c.category, len(order)))
    return ParsedReport(period, period_start, period_end, report_type, counters, unmatched)
