#!/usr/bin/env python3
"""
parse_digest.py — the «Итоги <месяца>» monthly-digest posts of @icpbtrubicon.

This is a SECOND, INDEPENDENT series from the one parse.py handles, not an
older format of it. Both exist for the same months (Jan/Feb/Mar 2026 each have
a General-Staff recap *and* an «Итоги» post, days apart) and they count
different things:

  parse.py        «Применение … по плану начальника Генерального Штаба»
                  — targets the unit claims to have ENGAGED. Jan 2026: 8 470.
  parse_digest.py «Количество ОПУБЛИКОВАННЫХ эпизодов поражения целей …
                   официальным каналом»
                  — strike videos the channel PUBLISHED. Jan 2026: 2 152.

The overlap months make the distinction measurable: the published share is
~20–25% of the claimed engagements overall, but per category it runs from
~0.10 (dugouts/fortifications) to ~0.95 (tanks) — a ~9× spread inside a single
month. That's publication selection (a destroyed tank gets filmed and posted
almost every time; a hit dugout almost never), not a coarser count of the same
thing. Post 2551 states both totals side by side: 280 000 targets hit vs
45 000 published episodes over the same 20 months.

So: same DB, different `kind`, different page. Never the same axis.

Shape (post 787, Nov 2025):

    🪖 Рубикон. Итоги ноября.
    Количество опубликованных эпизодов поражения целей противника операторами
    Центра "Рубикон" в ноябре 2025 составило 2245, …
    Структура основных типов пораженных целей в ноябре 2025 и динамика
    относительно октября 2025:
    • БПЛА - 664 (-8%)
    • НРТК - 87 (-33%)
    …
    • Прочие цели - 13

Categories are COARSER than the recap's: `РЛС, средства связи и наблюдения`
merges the recap's radar_ew + comms, `ПВД и полевые укрепления` merges
deployment_points + fortifications + engineering_structures, `Боевые
бронированные машины` merges afv_ifv + apc, and `БПЛА` merges uav + baba_yaga
+ fixed_wing_uav. Keys here are therefore their own namespace.

stdlib only.
"""
from __future__ import annotations

import calendar
import re
from dataclasses import dataclass, field
from datetime import date

# --- counter kinds ---------------------------------------------------------

# The month's headline number ("составило 2245").
KIND_TOTAL = "published_total"
# One "• Label - N" line of the structure list.
KIND_EPISODE = "published_episodes"

CATEGORY_TOTAL = "episodes_total"


@dataclass
class Counter:
    category: str
    value: int
    kind: str
    bound: str        # 'exact' | 'at_least'  ("превысило 1750" is a floor)
    raw_label: str


@dataclass
class ParsedDigest:
    period: str | None          # 'YYYY-MM'
    report_type: str            # 'monthly_digest' | 'unknown'
    counters: list[Counter] = field(default_factory=list)
    # Structure-list lines no alias claimed — a new/renamed category.
    unmatched: list[str] = field(default_factory=list)
    # Non-fatal oddities worth surfacing in the ingest log (source typos, a
    # breakdown that doesn't sum to its own headline).
    warnings: list[str] = field(default_factory=list)


# --- helpers ---------------------------------------------------------------

_NUM = r"(\d{1,3}(?:[\s  ]\d{3})+|\d+)"


def _to_int(s: str) -> int:
    return int(re.sub(r"[\s  ]", "", s))


# Genitive — how the TITLE names the month ("Итоги ноября").
_MONTH_GEN = {
    "января": 1, "февраля": 2, "марта": 3, "апреля": 4, "мая": 5, "июня": 6,
    "июля": 7, "августа": 8, "сентября": 9, "октября": 10, "ноября": 11,
    "декабря": 12,
}
# Prepositional — how the BODY names it ("в ноябре 2025 составило").
_MONTH_PREP = {
    "январе": 1, "феврале": 2, "марте": 3, "апреле": 4, "мае": 5, "июне": 6,
    "июле": 7, "августе": 8, "сентябре": 9, "октябре": 10, "ноябре": 11,
    "декабре": 12,
}

# "Итоги ноября." / "Итоги июля 2026." — year optional (2025 posts omit it).
_TITLE_RE = re.compile(
    r"Итоги\s+(" + "|".join(_MONTH_GEN) + r")\b(?:\s+(20\d{2}))?", re.I
)
# "… в ноябре 2025 составило 2245" / "… в июле 2025 превысило 1500 эпизодов".
# One regex binds month, year, bound word and value together so a stray number
# elsewhere in the post can never be picked up as the headline.
_HEADLINE_RE = re.compile(
    r"в\s+(" + "|".join(_MONTH_PREP) + r")\s+(20\d{2})\s+"
    r"(составило|составил|превысило|превысил)\s+(?:свыше\s+)?" + _NUM,
    re.I,
)
_AT_LEAST_WORDS = {"превысило", "превысил"}

# Gate for the per-category list. ONLY a post carrying this exact header has a
# breakdown for ITS OWN month. Post 481 ("Ударное лето", Aug 2025) also has a
# bulleted list, but it is a THREE-MONTH June+July+August aggregate and lacks
# this header — without the gate its bullets would be filed as August's.
_STRUCTURE_HEADER_RE = re.compile(r"Структура\s+основных\s+типов\s+пораженных\s+целей", re.I)

# "• БПЛА - 664 (-8%)"  ·  "• Прочие цели - 13"
# Label first, then a spaced dash, then the count; an optional "(±N%)" delta
# follows. 481's bullets are "• 47 танков;" (number first) so they can't match
# even if the header gate were bypassed.
_BULLET_RE = re.compile(
    r"^\s*[•▪]\s*(?P<label>[^\d•▪][^-–—]*?)\s+[-–—]\s+(?P<num>" + _NUM +
    r")\s*(?:\([^)]*\))?\s*;?\s*$"
)


def _norm_label(label: str) -> str:
    s = label.lower().replace("ё", "е")
    s = re.sub(r"[«»\"“”]", "", s)
    s = re.sub(r"[\s  ]+", " ", s)
    return s.strip(" .:;·-–—")


# --- categories ------------------------------------------------------------
#
# Own namespace: these are coarser aggregates than parse.py's keys, so a shared
# key would silently invite cross-series arithmetic that isn't valid.
CATEGORY_ALIASES: dict[str, str] = {
    "бпла": "uav",                                   # multirotor + fixed-wing + Baba-Yaga
    "нртк": "ugv",                                   # наземные робототехнические комплексы
    "рлс, средства связи и наблюдения": "radar_comms",
    "рлс, системы связи и наблюдения": "radar_comms",
    "системы связи": "radar_comms",
    "личный состав": "personnel",
    "автотранспорт": "vehicles",
    "пвд и полевые укрепления": "positions",         # + огневые позиции in some months
    "пвд, полевые укрепления и огневые позиции": "positions",
    "артиллерийские системы": "artillery",
    # Sep/Oct 2025 split artillery two ways; from Nov it's one line.
    "буксируемые орудия": "towed_artillery",
    "сау": "spg",
    "боевые бронированные машины": "armour",         # ББМ + БТР in recap terms
    "танки": "tanks",
    "объекты инфраструктуры": "infrastructure",
    # Joint strikes flown with the Aerospace Forces — a March 2026 addition,
    # and part of that month's headline total (3133 + 37 = 3170).
    "взаимодействие с вкс": "vks_joint",
    "прочие цели": "other",
}

# Chart order for the frontend; mirrors RUBIKON_EPISODE_CATEGORY_KEYS.
CATEGORY_ORDER = [
    CATEGORY_TOTAL,
    "uav", "ugv", "radar_comms", "personnel", "vehicles", "positions",
    "artillery", "towed_artillery", "spg", "armour", "tanks",
    "infrastructure", "vks_joint", "other",
]


# --- parsing ---------------------------------------------------------------

def _resolve_year(month: int, posted_at: date | None) -> int | None:
    """Year for a title-only month, from the post's own date.

    These land on the last day of the month they describe, or the first day or
    two of the next — so the described month is the posting month or the one
    before it.
    """
    if posted_at is None:
        return None
    if month == posted_at.month:
        return posted_at.year
    prev = posted_at.replace(day=1)
    prev_month = 12 if prev.month == 1 else prev.month - 1
    prev_year = prev.year - 1 if prev.month == 1 else prev.year
    if month == prev_month:
        return prev_year
    return None


def parse(text: str, posted_at: date | None = None) -> ParsedDigest:
    """Parse an «Итоги» digest post. Idempotent.

    `posted_at` is only a fallback for the year when the title names a month
    without one (the 2025 posts do) and the body doesn't state it either.
    """
    warnings: list[str] = []

    title = _TITLE_RE.search(text)
    title_month = _MONTH_GEN[title.group(1).lower()] if title else None
    title_year = int(title.group(2)) if title and title.group(2) else None

    head = _HEADLINE_RE.search(text)
    body_month = _MONTH_PREP[head.group(1).lower()] if head else None
    body_year = int(head.group(2)) if head else None

    # The TITLE wins on the month. Post 2260 is titled "Итоги июля 2026" but
    # its body says "в июне 2026 составило 4900" — a source typo: June was
    # already reported as 5232 by post 1986, and 2260 was posted on 31 Jul.
    # Trusting the body there would overwrite June with July's number.
    month = title_month or body_month
    if title_month and body_month and title_month != body_month:
        warnings.append(
            f"title says month {title_month}, body says month {body_month} — "
            f"using the title (see post 2260, a known source typo)"
        )
    if month is None:
        return ParsedDigest(None, "unknown", warnings=warnings)
    year = title_year or body_year or _resolve_year(month, posted_at)
    if year is None:
        return ParsedDigest(None, "unknown", warnings=warnings)
    period = f"{year:04d}-{month:02d}"

    counters: list[Counter] = []
    if head:
        counters.append(Counter(
            category=CATEGORY_TOTAL,
            value=_to_int(head.group(4)),
            kind=KIND_TOTAL,
            bound="at_least" if head.group(3).lower() in _AT_LEAST_WORDS else "exact",
            raw_label=re.sub(r"\s+", " ", head.group(0)).strip(),
        ))

    unmatched: list[str] = []
    if _STRUCTURE_HEADER_RE.search(text):
        seen: set[str] = set()
        for line in text.splitlines():
            m = _BULLET_RE.match(line)
            if not m:
                continue
            label = m.group("label").strip()
            category = CATEGORY_ALIASES.get(_norm_label(label))
            if not category or category in seen:
                unmatched.append(re.sub(r"\s+", " ", line).strip())
                continue
            seen.add(category)
            counters.append(Counter(
                category=category,
                value=_to_int(m.group("num")),
                kind=KIND_EPISODE,
                bound="exact",
                raw_label=label,
            ))

    # Every published breakdown so far sums EXACTLY to its own headline
    # (six for six, 2025-09 … 2026-03). Treat a mismatch as a parse smell —
    # a missed bullet or a category counted twice — rather than silently
    # storing a set of parts that doesn't add up.
    parts = [c for c in counters if c.kind == KIND_EPISODE]
    total = next((c for c in counters if c.kind == KIND_TOTAL), None)
    if parts and total and total.bound == "exact":
        s = sum(c.value for c in parts)
        if s != total.value:
            warnings.append(
                f"breakdown sums to {s} but the headline says {total.value} "
                f"(diff {s - total.value:+d}) — a bullet may be missing or double-counted"
            )

    if not counters:
        return ParsedDigest(None, "unknown", warnings=warnings)

    order = {k: i for i, k in enumerate(CATEGORY_ORDER)}
    counters.sort(key=lambda c: order.get(c.category, len(order)))
    return ParsedDigest(period, "monthly_digest", counters, unmatched, warnings)
