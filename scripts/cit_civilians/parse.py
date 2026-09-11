#!/usr/bin/env python3
"""
parse.py — extract civilian casualty rows from a CIT summary post.

Source: @CIT_shellings, the Conflict Intelligence Team's shelling-monitoring
channel. Once a day it posts a summary of civilian casualties over the
preceding 24 hours, 20:00–20:00 **MSK**:

    Всего за прошедшие сутки (20:00 07.09.2026 – 20:00 08.09.2026):

    в Киевской области вследствие атак ракетами и БПЛА погибли семь человек,
    ещё 42 пострадали, включая двухлетнюю девочку.
    …
    на оккупированной территории Донецкой области … погибли три человека, …
    …
    Кроме того, стало известно о ещё одном пострадавшем в Харьковской области
    за 7 сентября, …

    Таким образом, за прошедшие сутки стало известно как минимум о
    26 погибших и 165 пострадавших мирных жителях.

At the weekend the two days are published as ONE 48-hour post, "Всего за
прошедшие выходные". Those are only ~15% of summaries but ~26% of days, so
they are parsed too and flagged with `window_days=2` — a 48-hour bucket must
never be plotted as one day's toll.

Three kinds of row come out of a post. They are NOT interchangeable — each row
carries a `kind` so a query can pick the semantics it wants:

    daily       one row per region paragraph, attributed to the report window.
    amendment   a "Кроме того …" clause: casualties learned today that belong
                to an EARLIER date. Additive — CIT adds to a figure, it does
                not restate it. Counted in CIT's own daily headline.
    adjustment  a signed correction that CIT does NOT count in that headline:
                  * 'excluded_by_source' — "из подсчёта были исключены …",
                    a retraction (negative).
                  * 'restated_by_source' — "…составляет 87 человек, а не 90",
                    the one form in which CIT revises a figure outright. The
                    delta is new − old, and is usually negative.
                  * 'died_of_wounds' — someone already counted as injured on
                    date D has died. CIT adds +1 killed and leaves the injured
                    count alone; we additionally emit −1 injured so a revised
                    view doesn't count one person twice.

The distinction matters because of an empirical fact about the source, checked
against every retraction in the archive (posts 12729 and 12526): the closing
"Таким образом" total counts `daily` + `amendment` and IGNORES retractions. So
the reconciliation gate sums exactly those two kinds. README.md has the
worked arithmetic.

THE HEADLINE SERIES IS NOT PARSED FROM THE REGION LINES. `stated_killed` /
`stated_injured` come straight off the "Таким образом" line, a single fixed
sentence that parses on ~96% of posts. The region rows are the secondary
breakdown and reconcile with the headline on ~56%; `reconciled` records which.
The older prose eras are where the breakdown degrades, long before the
headline does.

Three format eras, all of which this module handles:

    2023-10-16 → ~2023-11-06   "Всего за прошедшие сутки:" — no window in
                               parentheses, no closing total. Window is NULL
                               and the date comes from the post timestamp.
    ~2023-11 → ~mid-2025       hyphen window; region lines are prose with city
                               names inline and varied verbs ("получили
                               ранения", "были ранены", "заявляется о N
                               пострадавших").
    ~mid-2025 → present        en-dash window; regular "вследствие атак …
                               погибли N человек, ещё M пострадали".

This module does the pure text → rows transform; ingest.py handles I/O.
stdlib only.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone

# CIT reports on Moscow time; `scraped_at` stays UTC (CLAUDE.md convention).
MSK = timezone(timedelta(hours=3))

KIND_DAILY = "daily"
KIND_AMENDMENT = "amendment"
KIND_ADJUSTMENT = "adjustment"

REASON_EXCLUDED = "excluded_by_source"
REASON_DIED_OF_WOUNDS = "died_of_wounds"
REASON_RESTATED = "restated_by_source"

# `date_basis` — how firmly a row is pinned to its `event_date`.
BASIS_WINDOW = "window"                     # the report's own 20:00–20:00 window
BASIS_WINDOW_MULTIDAY = "window_multiday"   # a weekend post: one 48h bucket
BASIS_POST_TIME = "post_time"               # 2023 era: inferred from posted_at
BASIS_EXPLICIT = "explicit"                 # the clause names exactly one date
BASIS_SPLIT = "split"                       # N casualties over N dates → one each
BASIS_MULTI = "multi"                       # several dates, indivisible
BASIS_UNKNOWN = "unknown"                   # no date found at all

# CIT publishes a 24-hour summary on weekdays and ONE combined 48-hour summary
# for the weekend, so gating on "сутки" alone silently loses a quarter of the
# series.
GATE = "Всего за прошедшие"
GATE_RE = re.compile(r"Всего\s+за\s+прошедшие\s+(?P<span>сутки|выходные)")

TYPE_DAILY = "daily_summary"
TYPE_WEEKEND = "weekend_summary"


def is_summary(text: str) -> bool:
    """Cheap gate used by the scraper before the full parse."""
    return bool(GATE_RE.match(text.lstrip()[:64]))


# --- data model ------------------------------------------------------------

@dataclass
class Row:
    kind: str                   # daily | amendment | adjustment
    region_key: str             # slug, e.g. 'kharkiv'; 'unknown' if unmatched
    region_raw: str             # verbatim Russian region phrase, for audit
    occupied: int | None        # 1 occupied / 0 government-controlled / None
    country: str | None         # 'UA' | 'RU' | None when the region is unknown
    killed: int                 # signed: negative on an adjustment
    injured: int                # signed
    event_date: str | None      # 'YYYY-MM-DD'; None when indivisibly multi-dated
    event_dates: str | None     # comma-joined list when several were named
    date_basis: str
    reason: str | None          # set on adjustment rows
    raw_label: str              # the verbatim clause this came from
    count_inferred: int = 0     # 1 when a count came from a bare noun


@dataclass
class ParsedReport:
    report_type: str                    # daily_summary | weekend_summary | unknown
    window_start: str | None            # UTC ISO8601
    window_end: str | None              # UTC ISO8601
    report_date: str | None             # 'YYYY-MM-DD', MSK date of window_end
    date_basis: str | None
    stated_killed: int | None
    stated_injured: int | None
    rows: list[Row] = field(default_factory=list)
    # Paragraphs no region matcher claimed. The post is a fixed list of region
    # lines, so an unclaimed one means a new or renamed region — surfaced as a
    # warning by ingest.py rather than dropped. The raw text is stored, so
    # `ingest.py --reparse` recovers the value once a pattern is added.
    unmatched: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    # Days the window spans: 1 for a weekday post, 2 for a weekend one.
    window_days: int = 1

    @property
    def sum_killed(self) -> int:
        """Killed as CIT counts them — daily + amendment, retractions excluded."""
        return sum(r.killed for r in self.rows if r.kind != KIND_ADJUSTMENT)

    @property
    def sum_injured(self) -> int:
        return sum(r.injured for r in self.rows if r.kind != KIND_ADJUSTMENT)

    @property
    def reconciled(self) -> bool | None:
        """Does the parse agree with the post's own closing total?

        None when the post has no total line (the 2023 era), which is an
        absence of evidence, not a failure.
        """
        if self.stated_killed is None or self.stated_injured is None:
            return None
        return (self.sum_killed == self.stated_killed
                and self.sum_injured == self.stated_injured)


# --- Russian numerals ------------------------------------------------------
# Cardinals plus the collective ("двое", "четверо") and the oblique forms the
# amendment clauses use ("о ещё одном пострадавшем", "о двух погибших").

_UNITS = {
    "один": 1, "одна": 1, "одно": 1, "одного": 1, "одном": 1, "одной": 1,
    "одному": 1, "одну": 1, "первый": 1,
    "два": 2, "две": 2, "двух": 2, "двум": 2, "двое": 2, "двоих": 2, "двоим": 2,
    "три": 3, "трёх": 3, "трех": 3, "трём": 3, "трем": 3, "трое": 3, "троих": 3,
    "четыре": 4, "четырёх": 4, "четырех": 4, "четырём": 4, "четырем": 4,
    "четверо": 4, "четверых": 4,
    "пять": 5, "пяти": 5, "пятеро": 5, "пятерых": 5,
    "шесть": 6, "шести": 6, "шестеро": 6, "шестерых": 6,
    "семь": 7, "семи": 7, "семеро": 7, "семерых": 7,
    "восемь": 8, "восьми": 8, "восьмеро": 8, "восьмерых": 8,
    "девять": 9, "девяти": 9, "девятеро": 9, "девятерых": 9,
    "десять": 10, "десяти": 10, "десятеро": 10,
    "одиннадцать": 11, "одиннадцати": 11,
    "двенадцать": 12, "двенадцати": 12,
    "тринадцать": 13, "тринадцати": 13,
    "четырнадцать": 14, "четырнадцати": 14,
    "пятнадцать": 15, "пятнадцати": 15,
    "шестнадцать": 16, "шестнадцати": 16,
    "семнадцать": 17, "семнадцати": 17,
    "восемнадцать": 18, "восемнадцати": 18,
    "девятнадцать": 19, "девятнадцати": 19,
    "двадцать": 20, "двадцати": 20,
    "тридцать": 30, "тридцати": 30,
    "сорок": 40, "сорока": 40,
    "пятьдесят": 50, "пятидесяти": 50,
}

# Bare nouns that stand in for a count. CIT's older posts routinely write
# "погибла женщина" where the modern format writes "погиб один человек"; these
# are the idioms that mean something other than one.
_NOUN_COUNTS = {"пара": 2, "пары": 2, "супруги": 2, "супругов": 2,
                "родители": 2, "родителей": 2, "близнецы": 2}

# Word boundaries matter: without them "восьмилетний" reads as 8 and
# "двухлетнюю" as 2.
_NUM_WORD = re.compile(
    r"\b(?:" + "|".join(sorted((re.escape(w) for w in _UNITS), key=len, reverse=True)) + r")\b")

MONTHS = {
    "января": 1, "февраля": 2, "марта": 3, "апреля": 4, "мая": 5, "июня": 6,
    "июля": 7, "августа": 8, "сентября": 9, "октября": 10, "ноября": 11,
    "декабря": 12,
}
_MONTH_RE = "|".join(MONTHS)


# --- casualty verbs and counting -------------------------------------------
# Stems, so every inflection is covered. "постра" rather than "пострада"
# because CIT typos the stem often enough to matter ("пострадли") and no other
# Russian word starts that way.
_KILLED_RE = re.compile(r"погиб\w*|погибш\w*|скончал\w*|умер\w*|смертельн\w*")
_INJURED_RE = re.compile(r"постра\w*|ранен\w*|ранени\w*|травмир\w*")

# One regex so a clause can be walked verb by verb, in source order.
_VERB_RE = re.compile(
    r"(?P<k>погиб\w*|скончал\w*|умер\w*)"
    r"|(?P<i>постра\w*|ранен\w*|ранени\w*|травмир\w*)")

# Phrases that introduce a SUB-count of a figure already stated ("…погибли 23
# человека, включая четырёх детей…"). Counting these would double-count, so
# each span is deleted before any number is read. A span runs to the next
# "ещё", the next casualty verb, a clause break, or the end — whichever comes
# first; that boundary set is what keeps "включая четырёх детей 2, 14, 17 и 17
# лет, ещё 63 мирных жителя получили ранения" from eating the 63.
_SUBCOUNT_RE = re.compile(
    r"(?:,\s*)?(?:включая|в том числе|в их числе|в числе которых|среди них|"
    r"среди которых|среди пострадавших|среди погибших|из них|из которых|в частности)\b"
    r".*?(?=(?:,?\s*(?:а\s+)?(?:ещё|еще)\b)"
    r"|(?:\s*[;.]\s*)"
    r"|(?:\s+(?:погиб|постра|ранен|получил|скончал))"
    r"|$)")

# Numbers that are never casualty counts. Stripped before the count scan so a
# date, an age or a weapon designation can't be mistaken for a victim tally.
_NOISE_RES = [
    re.compile(rf"\b\d{{1,2}}(?:\s*,\s*\d{{1,2}})*(?:\s+и\s+\d{{1,2}})?\s+(?:{_MONTH_RE})\b"),
    re.compile(rf"\b(?:{_NUM_WORD.pattern})\s+(?:{_MONTH_RE})\b"),
    re.compile(r"\b\d{1,3}\s*-\s*летн\w*|\b\d{1,3}-летн\w*"),
    re.compile(r"\b\d{1,2}(?:\s*,\s*\d{1,2})*(?:\s+и\s+\d{1,2})?\s+лет\b"),
    re.compile(r"«[^»]*»"),                              # «Герань-5», «Кременском»
    re.compile(r"\b[А-ЯЁA-Z][А-Яа-яЁёA-Za-z]*-\d+\b"),   # Су-24, С-300
    # Weapon designations written with a space and a model pair — "Shahed
    # 131/136" read as 131 + 136 = 267 injured before this, which is the worst
    # shape a miscount can take: large, plausible, and silent.
    re.compile(r"\b[А-ЯЁA-Z][А-Яа-яЁёA-Za-z]*\s+\d{1,4}(?:\s*/\s*\d{1,4})+\b"),
    re.compile(r"\b\d{1,4}\s*/\s*\d{1,4}\b"),
    re.compile(r"\b\d{4}\b"),                            # years
]


def _strip_colon_lists(text: str) -> str:
    """Drop "…37 человек: полицейский, 13 газовиков и 23 спасателей" tails.

    A colon after a casualty count introduces a breakdown OF that count, not
    extra victims; reading past it counts the same people twice.
    """
    parts = []
    for part in text.split(";"):
        idx = part.find(":")
        if idx > 0 and _VERB_RE.search(part[:idx]):
            part = part[:idx]
        parts.append(part)
    return ";".join(parts)


def _strip_noise(text: str) -> str:
    """Remove sub-counts, breakdowns, dates, ages and equipment designations."""
    out = _SUBCOUNT_RE.sub(" ", _strip_colon_lists(text))
    for rx in _NOISE_RES:
        out = rx.sub(" ", out)
    return out


def _number_at(text: str, prefer_last: bool = False) -> tuple[int | None, bool]:
    """First (or last) casualty count in `text`. Returns (value, from_bare_noun).

    Digits win over words because CIT mixes them freely ("42 пострадали",
    "ещё семь пострадали"). `prefer_last` is for the text *before* a verb,
    where the count nearest the verb is the trailing one.
    """
    digits = re.findall("\\d[\\d \u00a0\u202f]*\\d|\\d", text)
    if digits:
        raw = re.sub(r"[^\d]", "", digits[-1] if prefer_last else digits[0])
        if raw:
            return int(raw), False
    words = _NUM_WORD.findall(text)
    if words:
        return _UNITS[words[-1] if prefer_last else words[0]], False
    for noun, value in _NOUN_COUNTS.items():
        if re.search(rf"\b{noun}\b", text):
            return value, True
    return None, False


# A clause states killed and injured in separate breaths, joined by "ещё",
# "и" or ", а". Splitting there and reading one verb + one number per piece
# beats binding numbers to verbs by distance, which mis-binds on "погибли 23
# человека, ещё 63 … получили ранения".
_SEG_ESCHE = re.compile(r",?\s*(?:а\s+)?(?:ещё|еще)\s+")
_SEG_AND = re.compile(r"\s+и\s+|,\s*а\s+(?!также)")
# No comma in the tail: "и пострадал ещё 31 человек" binds the count to the
# verb, while "погибли, еще 19 получили ранения" genuinely separates two
# tallies — the comma is what tells them apart.
_VERB_TAIL_RE = re.compile(r"(?:погиб|постра|ранен|ранени|скончал|умер|травмир)\w*\s*$")


def _split_eshche(text: str) -> list[str]:
    out, last = [], 0
    for m in _SEG_ESCHE.finditer(text):
        # The separator match swallows the comma, so test the match itself:
        # ", ещё" is always a new tally, a bare "ещё" after a verb is not.
        if "," not in m.group(0) and _VERB_TAIL_RE.search(text[last:m.start()]):
            continue
        out.append(text[last:m.start()])
        last = m.end()
    out.append(text[last:])
    return out


# A trailing "… и мужчина" has no verb of its own and continues the previous
# one. Deciding that by a whitelist of victim nouns loses people — CIT writes
# "лесник", "начальник пожарной части", "спасатель ГСЧС". The set of things
# that are NOT a person in such a segment is far smaller and far more stable,
# so the test is a rejection filter instead.
_NON_PERSON_RE = re.compile(
    r"\b(?:г|с|п|пгт|х|ст)\.|"
    r"\b(?:БПЛА|РСЗО|БЭК|ПВО|атак\w*|удар\w*|обстрел\w*|ракет\w*|авиабомб\w*|"
    r"бомб\w*|дрон\w*|беспилотник\w*|общин\w*|район\w*|области|области\w*|"
    r"кра[йе]|дом\w*|здани\w*|предприяти\w*|инфраструктур\w*|автомобил\w*|"
    r"транспорт\w*|мин[аеуы]|снаряд\w*|боеприпас\w*|детонац\w*|разрушен\w*|"
    r"поврежд\w*|объект\w*|сел[оае]|город\w*|улиц\w*)\b")


def _looks_like_person(seg: str) -> bool:
    text = seg.strip(" .,;")
    if not text or len(text) > 60 or _NON_PERSON_RE.search(text):
        return False
    # "при обстрелах Токаревки, Молодежного и Зеленовки" — the tail of a list
    # of settlements. Every Russian common noun for a person is lowercase, so a
    # segment with no lowercase Cyrillic word is a proper name, not a victim.
    return bool(re.search(r"(?<![А-ЯЁ])\b[а-яё]{4,}", text))


def _segment_counts(seg: str) -> tuple[int, int, bool, str | None]:
    """(killed, injured, inferred, kind_of_last_verb) for one segment.

    A segment can still hold several events — the old prose era strings them
    with commas: "был ранен ребенок, в с. Раденск … были ранены женщина".
    Each verb is counted separately and reads its count from the text around it.
    """
    verbs = list(_VERB_RE.finditer(seg))
    if not verbs:
        return 0, 0, False, None
    killed = injured = 0
    inferred = False
    for idx, m in enumerate(verbs):
        prev_end = verbs[idx - 1].end() if idx else 0
        next_start = verbs[idx + 1].start() if idx + 1 < len(verbs) else len(seg)
        # The window after the verb stops at a comma: "20 человек погибли,
        # 75 получили ранения" has no "ещё" to split on, and without that bound
        # the 75 is read as the number of dead. The window before the verb is
        # NOT bounded — there the count is regularly on the far side of a comma
        # ("обратились три человека, пострадавшие при предыдущих обстрелах").
        after = seg[m.end():next_start]
        before = seg[prev_end:m.start()]
        value, from_noun = _number_at(after.split(",")[0])
        if value is None:
            value, from_noun = _number_at(before, prefer_last=True)
        if value is None:
            value, from_noun = 1, True
        inferred = inferred or from_noun
        if m.lastgroup == "k":
            killed += value
        else:
            injured += value
    return killed, injured, inferred, verbs[-1].lastgroup


def _counts(clause: str) -> tuple[int, int, bool]:
    """(killed, injured, any_count_inferred) for one already-scoped clause."""
    killed = injured = 0
    inferred = False
    for chunk in _split_eshche(_strip_noise(clause)):
        carried: str | None = None       # kind of the last verb seen in this chunk
        for seg in _SEG_AND.split(chunk):
            k, i, inf, last_kind = _segment_counts(seg)
            if last_kind is not None:
                killed += k
                injured += i
                inferred = inferred or inf
                carried = last_kind
                continue
            # No verb of its own: "… и мужчина" continues the previous verb.
            if carried and _looks_like_person(seg):
                value, _ = _number_at(seg)
                value = value or 1
                if carried == "k":
                    killed += value
                else:
                    injured += value
                inferred = True
    return killed, injured, inferred


# --- regions ---------------------------------------------------------------
# Matched generically (any "<Adj>ой области") rather than from a closed list,
# so a region CIT reports for the first time still yields its casualties. The
# closed lists below only decide `country`; an unknown region is reported as a
# warning, never dropped.

_UA_REGIONS = {
    "винницкая", "волынская", "днепропетровская", "донецкая", "житомирская",
    "закарпатская", "запорожская", "ивано-франковская", "киевская",
    "кировоградская", "луганская", "львовская", "николаевская", "одесская",
    "полтавская", "ровненская", "сумская", "тернопольская", "харьковская",
    "херсонская", "хмельницкая", "черкасская", "черниговская", "черновицкая",
    "крым", "севастополь",
}

_RU_REGIONS = {
    "белгородская", "брянская", "курская", "воронежская", "ростовская",
    "краснодарский", "ставропольский", "саратовская", "волгоградская",
    "рязанская", "тульская", "московская", "ленинградская", "новгородская",
    "псковская", "смоленская", "орловская", "липецкая", "тамбовская",
    "пензенская", "самарская", "нижегородская", "ярославская", "тверская",
    "калужская", "владимирская", "ивановская", "костромская", "свердловская",
    "челябинская", "тюменская", "оренбургская", "архангельская", "мурманская",
    "вологодская", "кировская", "ульяновская", "астраханская",
    "калининградская", "пермский", "красноярский", "приморский",
    "хабаровский", "забайкальский", "алтайский", "новосибирская", "омская",
    "томская", "кемеровская", "иркутская", "курганская",
    "башкортостан", "татарстан", "чувашия", "мордовия", "удмуртия", "коми",
    "адыгея", "дагестан", "калмыкия", "карелия", "ингушетия", "северная",
    # Adjectival forms, as they appear in "в <X>ой Республике".
    "удмуртская", "чеченская", "чувашская", "башкирская", "татарская",
    "мордовская", "карельская", "калмыцкая", "дагестанская", "марийская",
    "кабардино-балкарская", "карачаево-черкесская", "ингушская", "тувинская",
    "бурятская", "якутская", "хакасская", "алтайская", "коми",
}

# Amendment clauses often name only a city ("при атаках на г. Харьков 8 июля").
# Regions are the secondary dimension here, so this covers the cities CIT names
# repeatedly; everything else falls through to 'unknown', which costs the region
# attribution but never the casualty count or its date.
_CITY_REGIONS = {
    "харьков": ("харьковская", 0), "киев": ("киевская", 0),
    "запорожье": ("запорожская", 0), "херсон": ("херсонская", 0),
    "одесс": ("одесская", 0), "николаев": ("николаевская", 0),
    "сумы": ("сумская", 0), "чернигов": ("черниговская", 0),
    "днепр": ("днепропетровская", 0), "кривой рог": ("днепропетровская", 0),
    "никополь": ("днепропетровская", 0), "марганец": ("днепропетровская", 0),
    "краматорск": ("донецкая", 0), "славянск": ("донецкая", 0),
    "дружковка": ("донецкая", 0), "константиновка": ("донецкая", 0),
    "покровск": ("донецкая", 0), "полтава": ("полтавская", 0),
    "кременчуг": ("полтавская", 0), "белгород": ("белгородская", 0),
    "курск": ("курская", 0), "брянск": ("брянская", 0),
    "донецк": ("донецкая", 1), "луганск": ("луганская", 1),
    "лисичанск": ("луганская", 1), "северодонецк": ("луганская", 1),
    "мариуполь": ("донецкая", 1), "мелитополь": ("запорожская", 1),
    "бердянск": ("запорожская", 1), "энергодар": ("запорожская", 1),
    "джанкой": ("крым", 1), "симферополь": ("крым", 1),
    "севастополь": ("севастополь", 1), "алешки": ("херсонская", 1),
    "алёшки": ("херсонская", 1), "новоазовск": ("донецкая", 1),
}

_OCCUPIED_RE = re.compile(
    r"на\s+оккупированн(?:ой|ых)\s+территори(?:и|ях)\s+([А-ЯЁ][а-яё-]+ой)\s+области",
    re.IGNORECASE)
_CRIMEA_RE = re.compile(
    r"в\s+оккупированн(?:ой|ом)\s+(?:Автономной\s+Республике\s+Крым|Крыму)",
    re.IGNORECASE)
_SEVASTOPOL_RE = re.compile(r"в\s+оккупированн\w+\s+(?:г\.\s*)?Севастопол\w*", re.IGNORECASE)
# "ая" as well as "ой": CIT sometimes writes the nominative ("в Сумская
# области", post 2991), and dropping the paragraph would lose the whole region.
_OBLAST_RE = re.compile(r"\b([А-ЯЁ][а-яё-]+(?:ой|ая))\s+области", re.IGNORECASE)
_KRAI_RE = re.compile(r"\b([А-ЯЁ][а-яё-]+ом)\s+крае", re.IGNORECASE)
# Most Russian republics put their name BEFORE the noun and in the adjectival
# form ("в Удмуртской Республике"); only a few follow it ("Республике Северная
# Осетия", "Республике Крым"). The adjectival form is tried first.
#
# Neither carries re.IGNORECASE, deliberately: with it the `[А-ЯЁ]` guard stops
# guarding, and "в Удмуртской Республике вследствие атаки" captured
# "вследствие" as the region name.
_REPUBLIC_ADJ_RE = re.compile(r"\b([А-ЯЁ][а-яё-]+ой)\s+Республик[еи]")
_REPUBLIC_RE = re.compile(r"\bРеспублик[еи]\s+([А-ЯЁ][а-яё-]+)")
_CITY_RE = re.compile(r"\bг\.\s*([А-ЯЁ][а-яё-]+)", re.IGNORECASE)

_TRANSLIT = {
    "а": "a", "б": "b", "в": "v", "г": "h", "д": "d", "е": "e", "ё": "e",
    "ж": "zh", "з": "z", "и": "i", "й": "i", "к": "k", "л": "l", "м": "m",
    "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u",
    "ф": "f", "х": "kh", "ц": "ts", "ч": "ch", "ш": "sh", "щ": "shch",
    "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "iu", "я": "ia", "-": "-",
}

# Stable slugs for the regions that get charted, so the frontend and any saved
# deep link don't depend on the transliteration table above.
_SLUGS = {
    "киевская": "kyiv", "харьковская": "kharkiv", "донецкая": "donetsk",
    "луганская": "luhansk", "запорожская": "zaporizhzhia",
    "херсонская": "kherson", "днепропетровская": "dnipropetrovsk",
    "сумская": "sumy", "черниговская": "chernihiv", "одесская": "odesa",
    "николаевская": "mykolaiv", "полтавская": "poltava", "крым": "crimea",
    "севастополь": "sevastopol", "белгородская": "belgorod",
    "курская": "kursk", "брянская": "bryansk", "ростовская": "rostov",
    "воронежская": "voronezh", "краснодарский": "krasnodar",

    "удмуртская": "udmurtia", "чеченская": "chechnya", "чувашская": "chuvashia",
    "чувашия": "chuvashia", "башкирская": "bashkortostan",
    "татарская": "tatarstan", "мордовская": "mordovia",
    "дагестанская": "dagestan", "северная": "north-ossetia",
    "ингушетия": "ingushetia", "ингушская": "ingushetia",
}


def _norm_region(word: str) -> str:
    """'Харьковской' → 'харьковская'; krai forms → 'краснодарский'."""
    w = word.lower().replace("ё", "е")
    for suffix, repl in (("ской", "ская"), ("ой", "ая"), ("ом", "ий")):
        if w.endswith(suffix):
            return w[: -len(suffix)] + repl
    return w


def _slug(name: str) -> str:
    if name in _SLUGS:
        return _SLUGS[name]
    base = re.sub(r"(ская|ский|ское|ая|ий)$", "", name.lower().replace("ё", "е"))
    out = "".join(_TRANSLIT.get(ch, "") for ch in base)
    return re.sub(r"-+", "-", out).strip("-") or "unknown"


def _country(name: str) -> str | None:
    key = name.lower().replace("ё", "е")
    if key in _UA_REGIONS:
        return "UA"
    if key in _RU_REGIONS:
        return "RU"
    return None


@dataclass
class RegionHit:
    name: str            # normalised Russian name, e.g. 'харьковская'
    raw: str             # verbatim matched phrase
    occupied: int | None
    start: int           # offset in the scanned text, used to split clauses


def region_of(text: str) -> RegionHit | None:
    """First region named in `text`, or None.

    Occupied forms are tried first: "на оккупированной территории Донецкой
    области" must never collapse into government-controlled "в Донецкой
    области" — they are different rows with different casualty profiles.
    """
    for rx, occupied, fixed in (
            (_OCCUPIED_RE, 1, None), (_CRIMEA_RE, 1, "крым"),
            (_SEVASTOPOL_RE, 1, "севастополь"), (_OBLAST_RE, 0, None),
            (_KRAI_RE, 0, None), (_REPUBLIC_ADJ_RE, 0, None), (_REPUBLIC_RE, 0, None)):
        m = rx.search(text)
        if m:
            name = fixed or _norm_region(m.group(1))
            return RegionHit(name, m.group(0), occupied, m.start())
    m = _CITY_RE.search(text)
    if m:
        city = m.group(1).lower().replace("ё", "е")
        for prefix, (region, occupied) in _CITY_REGIONS.items():
            if city.startswith(prefix.replace("ё", "е")):
                return RegionHit(region, m.group(0), occupied, m.start())
    return None


def _region_fields(hit: RegionHit | None, raw: str) -> tuple[str, str, int | None, str | None]:
    if hit is None:
        return "unknown", raw.strip()[:120], None, None
    return _slug(hit.name), hit.raw, hit.occupied, _country(hit.name)


# --- dates -----------------------------------------------------------------

_DATE_LIST_RE = re.compile(
    rf"((?:\d{{1,2}}(?:\s*,\s*|\s+и\s+))*\d{{1,2}})\s+({_MONTH_RE})\b")


def _dates_in(text: str, report_day: date) -> list[date]:
    """Every date named in an amendment clause, in source order.

    Handles the list forms CIT actually uses — "за 7 сентября", "за 2 и 5
    сентября", "за 30 и 31 августа и 1 сентября" — and infers the year from
    the report date, rolling back a year when the named month is in the future
    (a January report amending "28 декабря").
    """
    out: list[date] = []
    for group, month_name in _DATE_LIST_RE.findall(text):
        month = MONTHS[month_name]
        year = report_day.year - 1 if month > report_day.month + 1 else report_day.year
        for day_s in re.findall(r"\d{1,2}", group):
            try:
                out.append(date(year, month, int(day_s)))
            except ValueError:
                continue
    return out


def _attribute(dates: list[date], count: int) -> tuple[str | None, str | None, str]:
    """Decide (event_date, event_dates, date_basis) for an amendment clause.

    One date → pin it. Anything else (the "ещё семи пострадавших … за 26, 28 и
    30 августа" case — 7 people, 3 days) cannot be divided without inventing
    data, so the row keeps the whole list and no single date. The caller
    handles the one divisible case, N casualties over exactly N dates.
    """
    if not dates:
        return None, None, BASIS_UNKNOWN
    joined = ",".join(d.isoformat() for d in dates)
    if len(dates) == 1:
        return dates[0].isoformat(), joined, BASIS_EXPLICIT
    return None, joined, BASIS_MULTI


# --- amendments ------------------------------------------------------------

# "…число пострадавших … составляет 87 человек, а не 90 как сообщалось ранее"
# — an absolute restatement, and the only form in which CIT revises a figure
# outright. The delta is new − old; like a retraction it sits outside the day's
# headline total. Unhandled, it reads as 87 + 90 = 177.
_RESTATE_RE = re.compile(
    r"составля\w+\s+(?P<new>\S+)[^.;]{0,40}?,\s*а\s+не\s+(?P<old>\S+)")
# "возросло до 34" states a new absolute total without naming the old one, so
# no delta can be derived from the text alone. Counting the 34 as new victims
# would be badly wrong, so it is reported and skipped.
_ABS_TOTAL_RE = re.compile(r"(?:возрос\w+|вырос\w+|увеличил\w+)\s+до\s+\S+")
_DELTA_PREFIX_RE = re.compile(r"\bна\s+\S+\s+(?:человек\w*\s+)?(?:возрос|вырос|увеличил)")

# Clause boundaries inside a corrections paragraph. CIT uses all of these,
# sometimes several in one post (see fixtures 12844, 12886, 11884).
_AMEND_SPLIT = re.compile(r";|,\s*а\s+также\s+|,\s*и\s+о\s+|,\s*(?:ещё|еще)\s+")
_AMEND_PARA_SPLIT = re.compile(r"\.\s*(?=Помимо\s+этого|Кроме\s+того)")
# How a corrections paragraph announces itself. "Кроме того" is the modern
# form; the 2024 posts use "в результате предыдущих ударов/обстрелов" instead,
# and reading those as one region's daily line attributes a whole paragraph of
# other regions' casualties to whichever region happens to be named first.
_AMEND_OPENER_RE = re.compile(
    r"^\s*(?:Кроме\s+того|Помимо\s+этого|(?:[Вв]\s+результате\s+)?"
    r"(?:предыдущ\w+|ранее\s+произошедш\w+)\s+(?:удар\w*|обстрел\w*|атак\w*))",
    re.IGNORECASE)


def _split_multi_region(piece: str) -> list[str]:
    """Safety net for clauses the punctuation split left joined.

    "о погибшем в Сумской области за 13 августа, одном пострадавшем в
    Запорожской области за 17 августа" has no ';' and no 'ещё', so the coarse
    split leaves both regions in one clause and the second would be lost.
    Cutting at the comma before each additional region recovers it.
    """
    starts: list[int] = []
    pos = 0
    while pos < len(piece):
        hit = region_of(piece[pos:])
        if hit is None:
            break
        starts.append(pos + hit.start)
        pos += hit.start + max(len(hit.raw), 1)
    if len(starts) <= 1:
        return [piece]
    cuts = [0]
    for start in starts[1:]:
        comma = piece.rfind(",", cuts[-1], start)
        if comma > cuts[-1]:
            cuts.append(comma + 1)
    return [piece[a:b].strip(" ,") for a, b in zip(cuts, cuts[1:] + [len(piece)])
            if piece[a:b].strip(" ,")]


def _amendment_rows(paragraph: str, report_day: date) -> tuple[list[Row], list[str]]:
    rows: list[Row] = []
    warnings: list[str] = []
    for para in _AMEND_PARA_SPLIT.split(paragraph):
        for coarse in _AMEND_SPLIT.split(para):
            for clause in _split_multi_region(coarse):
                clause = clause.strip(" .,")
                if not clause or not (_KILLED_RE.search(clause) or _INJURED_RE.search(clause)):
                    continue

                restated = _RESTATE_RE.search(clause)
                abs_total = bool(_ABS_TOTAL_RE.search(clause)) and \
                    not _DELTA_PREFIX_RE.search(clause)
                killed, injured, inferred = _counts(clause)
                died_of_wounds = bool(re.search(r"скончал|умер", clause)) and \
                    bool(re.search(r"пострадавш|получивш\w*\s+ранени|раненн", clause))
                if died_of_wounds:
                    # "скончался мужчина, пострадавший 1 июля" — the participle
                    # identifies the person who died, it does not report a new
                    # injury. Counting it would add a victim who never existed
                    # and break the post's own total by one.
                    injured = 0

                if restated:
                    new, _ = _number_at(restated.group("new"))
                    old, _ = _number_at(restated.group("old"))
                    if new is None or old is None:
                        warnings.append(f"restatement with unreadable figures: {clause!r}")
                        continue
                    about_killed = bool(re.search(r"погибш|погибл", clause[:restated.start()]))
                    killed, injured = ((new - old, 0) if about_killed else (0, new - old))
                    inferred = False
                elif abs_total:
                    warnings.append(
                        "clause restates an absolute total without naming the "
                        f"previous figure, so no delta can be derived — skipped: {clause!r}")
                    continue

                if killed == 0 and injured == 0:
                    continue

                hit = region_of(clause)
                region_key, region_raw, occupied, country = _region_fields(hit, clause)
                if hit is None:
                    warnings.append(
                        "amendment clause names no region we recognise — its "
                        f"casualties are still counted, on their own date: {clause!r}")
                dates = _dates_in(clause, report_day)
                retraction = bool(re.search(r"исключ", clause))

                def _mk(kind: str, k: int, i: int, event_date, event_dates, basis,
                        reason=None, _clause=clause, _rk=region_key, _rr=region_raw,
                        _occ=occupied, _c=country, _inf=inferred) -> Row:
                    return Row(
                        kind=kind, region_key=_rk, region_raw=_rr, occupied=_occ,
                        country=_c, killed=k, injured=i, event_date=event_date,
                        event_dates=event_dates, date_basis=basis, reason=reason,
                        raw_label=_clause, count_inferred=int(_inf))

                if restated:
                    ev, evs, basis = _attribute(dates, abs(killed) + abs(injured))
                    rows.append(_mk(KIND_ADJUSTMENT, killed, injured, ev, evs,
                                    basis, REASON_RESTATED))
                    continue

                if retraction:
                    # CIT's own daily total ignores retractions (verified on
                    # posts 12729 and 12526), so these must stay outside the
                    # reconciliation sum — hence KIND_ADJUSTMENT.
                    ev, evs, basis = _attribute(dates, killed + injured)
                    rows.append(_mk(KIND_ADJUSTMENT, -killed, -injured, ev, evs,
                                    basis, REASON_EXCLUDED))
                    continue

                total = killed + injured
                if len(dates) > 1 and len(dates) == total:
                    # N casualties named over exactly N dates: one each. This
                    # is the only multi-date split the source actually licenses.
                    joined = ",".join(x.isoformat() for x in dates)
                    per = [("k", 1) for _ in range(killed)] + [("i", 1) for _ in range(injured)]
                    for d, (what, n) in zip(dates, per):
                        rows.append(_mk(KIND_AMENDMENT, n if what == "k" else 0,
                                        n if what == "i" else 0, d.isoformat(),
                                        joined, BASIS_SPLIT))
                    continue

                ev, evs, basis = _attribute(dates, total)
                rows.append(_mk(KIND_AMENDMENT, killed, injured, ev, evs, basis))
                if died_of_wounds and killed:
                    # Already counted as injured on that date; CIT does not
                    # decrement, we do — outside the checksum.
                    rows.append(_mk(KIND_ADJUSTMENT, 0, -killed, ev, evs, basis,
                                    REASON_DIED_OF_WOUNDS))
                if basis == BASIS_UNKNOWN:
                    warnings.append(
                        "amendment clause names no date — counted for the "
                        f"report day only, not attributed: {clause!r}")
    return rows, warnings


# --- header, totals, entry point -------------------------------------------

_WINDOW_RE = re.compile(
    r"\(\s*(\d{1,2}):(\d{2})\s+(\d{2})\.(\d{2})\.(\d{4})\s*[-–—]\s*"
    r"(\d{1,2}):(\d{2})\s+(\d{2})\.(\d{2})\.(\d{4})\s*\)")

_TOTAL_RE = re.compile(r"Таким образом[^\n]*", re.IGNORECASE)

# Paragraphs that are neither a region line nor a correction. Listing them
# keeps `unmatched` meaningful: it should hold surprises, not the boilerplate
# tail every post carries.
_IGNORE_RE = re.compile(
    r"^\s*(?:Удары\s+по\s+энергетической|Обстрелы\s+гражданской|"
    r"Апдейты\s+по\s+предыдущим|Всего\s+за\s+прошедшие|[–—-]\s*$)", re.IGNORECASE)


def _window(text: str) -> tuple[datetime, datetime] | None:
    m = _WINDOW_RE.search(text)
    if not m:
        return None
    sh, sm, sd, smo, sy, eh, em, ed, emo, ey = (int(x) for x in m.groups())
    try:
        return (datetime(sy, smo, sd, sh, sm, tzinfo=MSK),
                datetime(ey, emo, ed, eh, em, tzinfo=MSK))
    except ValueError:
        return None


def _totals(text: str) -> tuple[int | None, int | None]:
    """Killed and injured off the closing "Таким образом …" sentence."""
    m = _TOTAL_RE.search(text)
    if not m:
        return None, None
    killed, injured, _ = _counts(m.group(0))
    # A quiet day states only one of the two ("…как минимум 17 мирных жителей
    # получили ранения"). Zero there is a real figure, not a failed parse.
    return killed, injured


def parse(text: str, posted_at: datetime) -> ParsedReport:
    """Parse one CIT summary post.

    `posted_at` is used only when the post carries no explicit window (the
    2023 era).
    """
    # Zero-width characters appear mid-word in some posts and silently break
    # the region match; nbsp and narrow-nbsp stand in for a plain space.
    body = re.sub("[\u200b-\u200f\ufeff]", "", text)
    body = body.replace("\xa0", " ").replace("\u202f", " ")

    gate = GATE_RE.match(body.lstrip()[:64])
    if not gate:
        return ParsedReport("unknown", None, None, None, None, None, None)
    weekend = gate.group("span") == "выходные"
    report_type = TYPE_WEEKEND if weekend else TYPE_DAILY

    warnings: list[str] = []
    win = _window(body)
    if win and win[1] <= win[0]:
        # The stated window ends at or before it starts — a typo in the source
        # ("20:00 30.05.2025 – 20:00 01.05.2025", post 7000, which meant
        # 01.06). Trusting it files a whole day under the wrong month. The
        # START is sound and the span is known from the gate ("сутки" = 1 day,
        # "выходные" = 2), so the end is rebuilt from those rather than from
        # the post timestamp, which can fall on the next MSK day.
        span = 2 if weekend else 1
        fixed_end = win[0] + timedelta(days=span)
        warnings.append(
            f"stated window ends before it starts ({win[0].date()} -> "
            f"{win[1].date()}) — a source typo; the end date is rebuilt as "
            f"{fixed_end.date()} from the window start and the report's own span")
        win = (win[0], fixed_end)

    if win:
        start, end = win
        window_start = start.astimezone(timezone.utc).isoformat(timespec="seconds")
        window_end = end.astimezone(timezone.utc).isoformat(timespec="seconds")
        # 20:00→20:00 MSK straddles two calendar days; 20 of the 24 hours fall
        # on the end date, so that is the day the report is *about*.
        report_day = end.date()
        window_days = max((end.date() - start.date()).days, 1)
        basis = BASIS_WINDOW_MULTIDAY if window_days > 1 else BASIS_WINDOW
        if window_days > 3:
            warnings.append(
                f"stated window spans {window_days} days, which no CIT summary "
                f"format does — check the dates on this post")
    else:
        window_start = window_end = None
        report_day = posted_at.astimezone(MSK).date()
        window_days = 2 if weekend else 1
        basis = BASIS_POST_TIME
        if _WINDOW_RE.search(body) is None:
            warnings.append(
                "post states no 20:00\u201320:00 window (2023-era format); "
                "report_date inferred from the post timestamp")

    stated_killed, stated_injured = _totals(body)

    rows: list[Row] = []
    unmatched: list[str] = []
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", body) if p.strip()]
    if len(paragraphs) <= 2:            # some posts use single newlines
        paragraphs = [p.strip() for p in body.split("\n") if p.strip()]

    for para in paragraphs:
        if _IGNORE_RE.match(para) or _TOTAL_RE.match(para):
            continue
        if _AMEND_OPENER_RE.match(para):
            amended, warns = _amendment_rows(para, report_day)
            rows.extend(amended)
            warnings.extend(warns)
            continue

        hit = region_of(para)
        if hit is None:
            unmatched.append(para[:200])
            continue
        # A region paragraph can carry several clauses with separate tallies
        # ("…в п. Антоновка … погиб мужчина …; в г. Херсон … погибли два …").
        killed = injured = 0
        inferred = False
        for clause in para.split(";"):
            k, i, inf = _counts(clause)
            killed += k
            injured += i
            inferred = inferred or inf
        if killed == 0 and injured == 0:
            unmatched.append(para[:200])
            continue
        region_key, region_raw, occupied, country = _region_fields(hit, para)
        rows.append(Row(
            kind=KIND_DAILY, region_key=region_key, region_raw=region_raw,
            occupied=occupied, country=country, killed=killed, injured=injured,
            event_date=report_day.isoformat(), event_dates=None,
            date_basis=basis, reason=None, raw_label=para[:500],
            count_inferred=int(inferred)))

    return ParsedReport(
        report_type=report_type,
        window_start=window_start,
        window_end=window_end,
        report_date=report_day.isoformat(),
        date_basis=basis,
        stated_killed=stated_killed,
        stated_injured=stated_injured,
        rows=rows,
        unmatched=unmatched,
        warnings=warnings,
        window_days=window_days,
    )
