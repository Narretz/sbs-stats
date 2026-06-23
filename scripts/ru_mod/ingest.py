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
from datetime import date, datetime, timedelta, timezone
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

# Count of Ukrainian UAVs intercepted (the metric). Anchored to "уничтожен\w+" so
# the Cyrillic-word alternation can't snap onto a stray phrase before the count;
# the token is digits OR a 1–2 word spelled-out numeral ("шесть", "двадцать три")
# resolved via _count_to_int — low days (single-digit totals) use word form, e.g.
# msg 63991 "уничтожены шесть украинских беспилотных…".
# `\w*` (not `\w+`) on the verb suffix is deliberate: Russian uses the bare
# masculine-singular form "уничтожен" — no trailing letter — when the count
# ends in 1 but not 11 (e.g. "уничтожен 301 ... аппарат", "уничтожен 141 ...").
# Two surface forms appear across the channel's history (see _extract_drones):
#   * VERB-FIRST:  "уничтожено [и перехвачено] N украинских <unit>"     — common
#   * NOUN-FIRST:  "N украинских <unit> [adjs] уничтожен[ы]"            — Oct'24
# A SINGULAR variant ("украинский <unit> уничтожен" — count=1, no numeral) is
# also used for one-drone intercepts. The "украин\w+" anchor between count and
# unit is what distinguishes a headline from a per-region bullet (bullets drop
# the "украинских" modifier), so all three patterns keep it.
_AD_VERB = r"(?:уничтожен|сбит|перехвач)\w*"
# Unit noun: either the short "БПЛА"/"БпЛА" or the full "беспилотн… летательн…
# аппарат" noun phrase. The short form became common in late 2024 — its absence
# from the old COUNT_RE silently dropped every report that used it.
_UNIT_NOUN = r"(?:БПЛА|БпЛА|беспилотн\w+\s+летательн\w+\s+аппарат\w*)"
_HEAD_NUM = r"(\d+|[А-Яа-яЁё]+(?:\s+[А-Яа-яЁё]+)?)"
COUNT_VERB_FIRST_RE = re.compile(
    # Leading verb is any _AD_VERB, not just "уничтожен" — msg 50783 (Apr
    # 2025) opened with "перехвачено три украинских …", and the channel
    # also uses "сбит…" in the same position. The optional inner verb
    # then covers paired forms like "уничтожено и перехвачено N".
    rf"{_AD_VERB}(?:\s+и\s+{_AD_VERB})?\s+{_HEAD_NUM}\s+украин\w+\s+{_UNIT_NOUN}",
    re.I,
)
COUNT_NOUN_FIRST_RE = re.compile(
    rf"{_HEAD_NUM}\s+украин\w+\s+{_UNIT_NOUN}(?:\s+\w+){{0,3}}\s+{_AD_VERB}",
    re.I,
)
COUNT_SINGULAR_RE = re.compile(
    rf"украинский\s+{_UNIT_NOUN}(?:\s+\w+){{0,3}}\s+{_AD_VERB}",
    re.I,
)
# Verb-first singular: "уничтожен украинский <unit> над <region>" (msg
# 49558, Mar 2025) — the short verb-first form for one-drone intercepts.
# Mirror of COUNT_SINGULAR_RE with the verb fronted.
COUNT_SINGULAR_VERB_FIRST_RE = re.compile(
    rf"{_AD_VERB}(?:\s+и\s+{_AD_VERB})?\s+украинский\s+{_UNIT_NOUN}",
    re.I,
)
# Is this an air-defense intercept post at all?
AD_GATE = re.compile(r"(противовоздушн|средствами\s+пво|перехвач\w+\s+и\s+уничтож)", re.I)
# Explicit night range with dates: "с 20.00 мск 22 мая до 7.00 мск 23 мая".
# "мск" after each time is OPTIONAL — the channel often omits it on the dated
# form, e.g. "с 23.00 12 марта до 7.00 13 марта". Without this the report falls
# through to NIGHT_PHRASE_RE, which assumes a 20:00 start and so mis-records the
# real (e.g. 23:00) window start.
NIGHT_DATED_RE = re.compile(
    r"с\s+(\d{1,2})[.:]\d{2}\s*(?:мск\s+)?(\d{1,2})\s+(\w+)\s+до\s+(\d{1,2})[.:]\d{2}\s*(?:мск\s+)?(\d{1,2})\s+(\w+)", re.I)
# Same-day range: "с 14.00 до 20.00 мск" and "с 7.00 мск до 15.00 мск"
# (the channel sometimes repeats "мск" after the start time). Minutes are
# captured (not just hours): early August 2025 reports used short same-hour
# windows like "С 07.00 до 07.20 мск" which without minute precision look like
# h1==h2 → "crosses midnight" → mis-recorded as a 24-hour overnight window.
DAY_RANGE_RE = re.compile(r"с\s+(\d{1,2})[.:](\d{2})\s*(?:мск\s*)?до\s+(\d{1,2})[.:](\d{2})\s*мск", re.I)
NIGHT_PHRASE_RE = re.compile(r"прошедш\w+\s+ноч|в\s+течение\s+ноч|минувш\w+\s+ноч", re.I)
# Explicit "с HH.MM … до HH.MM" hours within a night report, regardless of the
# date format that follows (word month, numeric "6.05", a "т.г." suffix, or the
# whole range in parentheses — all of which NIGHT_DATED_RE can't cover). Used to
# recover the real start hour instead of assuming the 20:00 default.
NIGHT_HOURS_RE = re.compile(r"с\s+(\d{1,2})[.:]\d{2}.*?до\s+(\d{1,2})[.:]\d{2}", re.I)
REGION_RE = re.compile(r"над\s+территор\w+\s+(.*)", re.I)
# Itemized per-region breakdown line, e.g. "42 – над территорией Саратовской
# области," (dash may be -, –, —). The MoD uses this format on some days; on
# others it gives only a total + a region list (no per-region counts). The wording
# drifts a lot between posts, so we capture loosely (a count, an optional "БПЛА"
# unit, a dash, then the region phrase up to the next comma/bullet/number) and
# normalise the phrase in parse_breakdown. Variants this must tolerate:
#   "42 – над территорией Саратовской области"   (canonical)
#   "57 БПЛА – над территорией Волгоградской …"    (БПЛА unit, ~Mar 2026)
#   "9 БПЛА – над акваторией Каспийского моря"     (sea area, not a territory)
#   "39 – над Московским регионом"                 (region, no "территорией")
#   "1 – территорией Белгородской области"         ("над" dropped)
#   "восемь – над территорией Белгородской …"      (count spelled out, low days)
# The count is a digit OR a spelled-out numeral (1–3 words); a non-numeral word
# phrase is filtered out in parse_breakdown via _ru_numeral. The "в том числе N …,
# летевших на Москву" sub-clause has no dash, so it is correctly NOT matched (a
# subset of the Moscow line, not a separate region).
# The multi-word part is lazy ({0,2}?) so the count stays minimal and the "БПЛА"
# unit is consumed by the dedicated group below (not swallowed into the numeral,
# which would make "один БПЛА" fail to parse); it only expands for genuine
# multi-word numerals like "двадцать три".
# Optional verb that some bullets insert between "БПЛА" and the dash/над. When
# present it may also replace the dash entirely ("4 БПЛА сбито над …" / "10
# БПЛА сбиты над …" — no dash). Anchoring on a verb OR a dash followed by
# "над" lets the regexes tolerate either form without matching the headline
# (which has no verb between its count and the rest of the sentence).
# Optional verb token allowed between БПЛА (or count) and the dash/над. The
# bare suffix is masculine-singular (governs counts ending in 1 but not 11,
# e.g. "Тридцать один БПЛА уничтожен"); "ы"/"о" cover plural and neuter forms.
# "перехвачен[ыо]" added after msg 47783 used "перехвачены" in a per-region
# bullet alongside the more common "уничтожен"/"сбит".
# Optionally a single AD verb OR a paired one ("перехвачены и уничтожены",
# msg 44421 Oct 2024) between the count/unit and the dash/над. The paired
# form became common in older bullets where the channel double-named the
# action.
_VERB_OPT = (
    r"(?:"
    r"(?:уничтожен[ыо]?|сбит[оы]?|перехвачен[ыо]?)"
    r"(?:\s+и\s+(?:уничтожен[ыо]?|сбит[оы]?|перехвачен[ыо]?))?"
    r"\s+"
    r")?"
)
_DASH_OR_NAD = r"(?:[-–—]\s*(?:над\s+|в\s+)?|над\s+|в\s+)"
# Bullet glyphs the channel uses between items: WHITE (▫️) and BLACK (▪️)
# small squares. Both pre-2025 and post-2025 posts mix the two freely; the
# region capture must stop at either.
_BULLET = "▫▪"
# Stop the region phrase at the next item, in any of these bullet-less forms:
#   " и <count> БПЛА …"      — "Брянской области и один БПЛА – …"   (msg 54759)
#   " и <count> – …"         — "Курской области и один – над …"     (msg 48889)
#   " и <count> над …"       — "Белгородской и два над …"           (msg 48494)
#   " по <count> …"          — "Ростовской областей, по два БПЛА…"  (msg 49522)
#   " и по <count> …"        — "Орловской областей и по одному – …" (msg 49931)
#   ", <count> БПЛА …"       — "Липецкой областей, девять БПЛА – …" (msg 48833 —
#                              for PO_ITEM_RE only, since REGION_ITEM_RE's region
#                              group already excludes `,`; harmless overlap)
#   ", <count> в <Region> …"  — "Ростовской областях, один в …"     (msg 44303 —
#                              older "в <region>" preposition variant)
# The "по" marker NEVER appears mid-region-name in this channel — it's always
# the start of a distributive bullet — so a bare `по <count>` is unambiguous.
# The "и <count> (БПЛА|–|над|в)" alternation covers all four possible follow-ups
# after a conjunction-joined trailing count.
_BOUNDARY_PATTERN = (
    rf"(?:"
    rf"\s+(?:"
    rf"(?:и\s+)?по\s+(?:\d+|[А-Яа-яЁё]+)"
    rf"|и\s+(?:\d+|[А-Яа-яЁё]+(?:\s+[А-Яа-яЁё]+){{0,2}})\s+(?:БПЛА|[-–—]|над\s|в\s)"
    rf")"
    rf"|,\s*(?:\d+|[А-Яа-яЁё]+(?:\s+[А-Яа-яЁё]+){{0,2}})\s+(?:БПЛА|[-–—]|в\s)"
    rf")"
)
_NEXT_ITEM_LA = rf"(?!{_BOUNDARY_PATTERN})"
# The MoD occasionally repeats "украинских" in the breakdown ("19 украинских
# БпЛА – над …", msg 49133) instead of dropping it as in the headline form.
# Tolerate either ordering before the БПЛА unit.
_UA_OPT = r"(?:украин\w+\s+)?"
# Count group: digits OR a 1–3 word Russian numeral. Multi-word numerals are
# matched greedily *up to but not including* "БПЛА" or one of the verbs in
# _VERB_OPT — that way "Тридцать один БПЛА" extends to "Тридцать один" (31)
# instead of stopping at "Тридцать" (30, lazy default), while "один БПЛА"
# stays at "один" because БПЛА is excluded, and "одному сбито над …" stays
# at "одному" because "сбито" is excluded (otherwise _count_to_int would
# reject the verb word and the bullet would be silently dropped).
_COUNT_GROUP = (
    r"(\d+|[А-Яа-яЁё]+(?:\s+"
    r"(?!(?:БПЛА|уничтожен[ыо]?|сбит[оы]?|перехвачен[ыо]?)\b)"
    r"[А-Яа-яЁё]+){0,2})"
)
REGION_ITEM_RE = re.compile(
    rf"{_COUNT_GROUP}\s*{_UA_OPT}(?:БПЛА\s*)?{_VERB_OPT}{_DASH_OR_NAD}"
    rf"((?:{_NEXT_ITEM_LA}[^,.;{_BULLET}\d])+)",
    re.I,
)
# Distributive "по N" form: ONE count applies to MULTIPLE regions listed in the
# same bullet, e.g. "по 8 БПЛА – над территориями Брянской и Тульской областей"
# means 8 over Bryansk AND 8 over Tula (16 drones total, two breakdown rows).
# The region phrase runs until the next bullet, period, or — in bullet-less
# posts — the next `и <count> БПЛА` boundary (otherwise the phrase swallows
# subsequent items and inflates the breakdown sum).
# `_NEXT_ITEM_BOUNDARY` matches the position right before the next item in a
# bullet-less post — same alternation as _NEXT_ITEM_LA, used as the trailing
# `(?=…|.|▫|▪)` end assertion on PO_ITEM_RE so the lazy region group has a
# valid stopping point.
_NEXT_ITEM_BOUNDARY = _BOUNDARY_PATTERN
PO_ITEM_RE = re.compile(
    rf"по\s+{_COUNT_GROUP}\s*(?:БПЛА\s*)?{_VERB_OPT}{_DASH_OR_NAD}"
    rf"((?:{_NEXT_ITEM_LA}[^.{_BULLET}])+?)(?=[.{_BULLET}]|{_NEXT_ITEM_BOUNDARY}|$)",
    re.I,
)
# Region-first INVERTED bullet ("Над территорией X уничтожено N БПЛА"),
# common in late-2024 posts mixed with standard noun-first bullets in
# the same post (msg 44107, 45925, 46082, 46184, …). The region runs
# lazily until the engine finds a verb + count + БПЛА — the verb anchor
# keeps the lazy group from chewing past the bullet end.
REGION_FIRST_BULLET_RE = re.compile(
    rf"над\s+(?:территори\w+|акватори\w+)\s+([^.,;{_BULLET}]+?)\s+"
    rf"(?:уничтожен[ыо]?|сбит[оы]?|перехвачен[ыо]?)"
    rf"(?:\s+и\s+(?:уничтожен[ыо]?|сбит[оы]?|перехвачен[ыо]?))?\s+"
    rf"(\d+|[А-Яа-яЁё]+(?:\s+[А-Яа-яЁё]+){{0,2}})\s+БПЛА",
    re.I,
)
# Noun-first bullet using the same surface form as the noun-first
# headline ("N украинских <unit> уничтожен[ы] над <region>"). Late-2024
# posts often had NO separate verb-first total — the noun-first phrase
# was the first bullet, and parse_report's drones reconcile step then
# recomputes the true total from the breakdown sum (msg 45017, 45204).
NOUN_FIRST_BULLET_RE = re.compile(
    rf"{_HEAD_NUM}\s+украин\w+\s+{_UNIT_NOUN}(?:\s+\w+){{0,3}}\s+{_AD_VERB}\s+{_DASH_OR_NAD}"
    rf"((?:{_NEXT_ITEM_LA}[^,.;{_BULLET}\d])+)",
    re.I,
)
# Singular bullet ("Также украинский БпЛА уничтожен над акваторией X") —
# count is implicit 1, no numeral. The match pattern mirrors the singular
# headline detector; the bullet form just appends "над <region>" so the
# region can be captured alongside.
SINGULAR_BULLET_RE = re.compile(
    rf"украинский\s+{_UNIT_NOUN}(?:\s+\w+){{0,3}}\s+{_AD_VERB}\s+{_DASH_OR_NAD}"
    rf"((?:{_NEXT_ITEM_LA}[^,.;{_BULLET}\d])+)",
    re.I,
)
# Leading "территорией "/"акваторией " noun stripped off the captured phrase so
# the region name itself remains (e.g. "Брянской области", "Азовского моря").
_REGION_NOUN_RE = re.compile(r"^(?:территори\w+|акватори\w+)\s+", re.I)
# Trailing-noun handoff: in "над территориями A и B областей" the genitive
# plural noun follows the LAST region; the earlier bare-adjective regions
# share it. Map plural → singular so the per-region rows are consistent with
# the canonical "<adj> области" form used by single-region bullets.
_PLURAL_TO_SINGULAR = {
    "областей": "области",
    "морей":    "моря",
    "краёв":    "края",
    "краев":    "края",
    # Prepositional plural — appears in "в Курской и Ростовской областях"
    # (msg 44303, older "в <region>" preposition variant).
    "областях": "области",
    "морях":    "моря",
    "краях":    "края",
}

# Spelled-out Russian cardinals as they appear in per-region counts. Low-count
# days (≤ a few dozen drones over any one region) write the number as a word.
_RU_UNITS = {
    "ноль": 0, "один": 1, "одного": 1, "одна": 1, "одно": 1, "одному": 1, "два": 2, "две": 2,
    "три": 3, "четыре": 4, "пять": 5, "шесть": 6, "семь": 7, "восемь": 8, "девять": 9,
    "десять": 10, "одиннадцать": 11, "двенадцать": 12, "тринадцать": 13,
    "четырнадцать": 14, "пятнадцать": 15, "шестнадцать": 16, "семнадцать": 17,
    "восемнадцать": 18, "девятнадцать": 19,
}
_RU_TENS = {
    "двадцать": 20, "тридцать": 30, "сорок": 40, "пятьдесят": 50, "шестьдесят": 60,
    "семьдесят": 70, "восемьдесят": 80, "девяносто": 90,
}
_RU_HUNDREDS = {
    "сто": 100, "двести": 200, "триста": 300, "четыреста": 400, "пятьсот": 500,
}


def _ru_numeral(text: str) -> int | None:
    """Parse a spelled-out Russian cardinal (e.g. 'двадцать три' → 23). Returns
    None if any word isn't a numeral, so non-numeric phrases are rejected."""
    total = 0
    matched = False
    for w in text.lower().split():
        for table in (_RU_HUNDREDS, _RU_TENS, _RU_UNITS):
            if w in table:
                total += table[w]
                matched = True
                break
        else:
            return None  # a non-numeral word — not a spelled-out number
    return total if matched else None


def _extract_drones(flat: str) -> tuple[int, str] | None:
    """Headline drone count + tag of which surface form matched.

    Walks the three headline forms in order. finditer (not search) so a
    first match whose count phrase _count_to_int can't resolve doesn't
    drop the whole post — keep trying. The singular implicit form
    contributes a fixed count of 1 (no numeral in the text).

    The tag ('verb_first' / 'noun_first' / 'singular') tells the caller
    whether the count came from a true headline or a noun-first phrase
    that may actually be the first bullet of a bullet-less list; the
    caller can then reconcile drones against the breakdown sum.
    """
    for m in COUNT_VERB_FIRST_RE.finditer(flat):
        n = _count_to_int(m.group(1))
        if n is not None and n <= MAX_PLAUSIBLE:
            return n, "verb_first"
    for m in COUNT_NOUN_FIRST_RE.finditer(flat):
        n = _count_to_int(m.group(1))
        if n is not None and n <= MAX_PLAUSIBLE:
            return n, "noun_first"
    if COUNT_SINGULAR_RE.search(flat) or COUNT_SINGULAR_VERB_FIRST_RE.search(flat):
        return 1, "singular"
    return None


_LEADING_CONJ = re.compile(r"^\s*и\s+", re.I)

def _count_to_int(token: str) -> int | None:
    """A breakdown count is either digits or a spelled-out numeral.

    The regex's count group is greedy and may have absorbed a connective
    phrase before reaching the actual numeral:
      * " и один …"          → "и один"       (msg 54759 — last item joined
                                                by the "и" conjunction)
      * " из которых девять "  → "из которых девять" (msg 47131 — "of which N")
    Strip any leading non-numeral words so the trailing numeral resolves
    instead of the whole phrase being rejected."""
    token = _LEADING_CONJ.sub("", token).strip()
    if token.isdigit():
        return int(token)
    words = token.lower().split()
    while words and not (words[0] in _RU_HUNDREDS
                         or words[0] in _RU_TENS
                         or words[0] in _RU_UNITS):
        words.pop(0)
    return _ru_numeral(" ".join(words)) if words else None

MAX_PLAUSIBLE = 5000  # guard against a runaway parse

# MoD "Сводка о ходе проведения СВО" summary posts. In 2025 a weekly variant
# ("с DD month по DD month YYYY") carried cumulative Ukrainian *equipment* losses
# (no personnel); a daily variant uses "по состоянию на DD month YYYY". These
# appear to have stopped on the channel in 2026. We capture them RAW (header +
# full text) for later parsing — see DATASETS.md §3.
# Сводки come in multiple parts. Part 1 always carries the formal header
# ("Министерства обороны Российской Федерации о ходе проведения специальной
# военной операции"); follow-on parts (part 2+, msg 51524 Apr 2025) drop
# the header and open straight with operational recap content. Several
# markers reliably identify continuation posts and the sibling "Главное за
# день" daily wrap-up posts (msg 52583 May 2025), and none of them appear
# in standalone AD intercept reports:
#   * "См. часть N"  — back-reference to part 1
#   * "Всего с начала проведения специальной военной операции"  — running
#     cumulative-stats footer at the bottom of every Сводка
#   * "Главное за день" / "#ИтогиДня"  — the channel's daily wrap-up format,
#     which recaps the day's AD totals in passing rather than reporting
#     a single intercept window
# Without these the post matches AD_GATE (via incidental "ПВО" mentions)
# but no headline regex, getting dropped entirely — and the gap-day
# warning then flags the day as "no AD report" when really there just
# isn't a standalone intercept post.
SVODKA_GATE = re.compile(
    r"обороны\s+Российской\s+Федерации\s+о\s+ходе\s+проведения\s+специальной\s+военной\s+операции"
    r"|см\.\s+часть\s+\d"
    r"|Всего\s+с\s+начала\s+проведения\s+специальной\s+военной\s+операции"
    r"|Главное\s+за\s+день"
    r"|#ИтогиДня"
    # "Тезисы брифинга …" briefing transcripts (msg 59941, Dec 2025 Putin
    # residence attack recap) — multi-region, multi-day, with time-window
    # sub-bullets that wrecked the standard breakdown parser. Treat as a
    # summary; the headline drone count ("девяносто одного") sits outside
    # any verb-first/noun-first form so parse_report can't extract it
    # cleanly without a dedicated briefing-transcript pass we don't yet
    # have. Store raw for a future structured parser.
    r"|Тезисы\s+брифинга",
    re.I,
)
# Subset of SVODKA_GATE that identifies daily-wrap-up posts specifically,
# so parse_summary can tag them with a distinct `kind` ('main_of_day')
# rather than the generic 'svodka'.
_MAIN_OF_DAY_MARKER = re.compile(r"Главное\s+за\s+день|#ИтогиДня", re.I)
_BRIEFING_MARKER = re.compile(r"Тезисы\s+брифинга", re.I)
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
def _strip_md(text: str) -> str:
    """Remove Telegram Markdown so the web and telethon backends parse to the
    same text. telethon returns the post's Markdown source (**bold**, italics,
    [label](url) links); the web preview returns it already rendered to plain
    text. Left in, the markers leak into parsed fields (e.g. a `**` glued onto a
    region name) — which both dirties the data and makes the same post look
    edited across sources, spuriously inserting a new version."""
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)  # [label](url) → label
    # Drop SOFT HYPHEN (U+00AD) — typographic invisible char that occasionally
    # slips into MoD posts (e.g. msg 53965 between "БПЛА " and the en-dash)
    # and breaks dash-anchored regexes by separating the dash from its noun.
    return text.replace("*", "").replace("_", "").replace("­", "")


def _parse_window(text: str, posted_msk: datetime):
    """Return (start, end, kind) as MSK datetimes (or None) + kind string."""
    start = end = None
    kind = "other"

    m = NIGHT_DATED_RE.search(text)
    if m:
        h1, d1, mon1, h2, d2, mon2 = m.groups()
        mo1, mo2 = MONTHS.get(mon1.lower()), MONTHS.get(mon2.lower())
        if mo1 and mo2:
            yr = posted_msk.year

            def mk(y, mo, d, hh):  # tolerate "24.00" → next-day 00:00
                extra, hh = divmod(int(hh), 24)
                return datetime(y, mo, int(d), hh, 0, tzinfo=MSK) + timedelta(days=extra)

            end = mk(yr, mo2, d2, h2)
            # start is the prior boundary; roll the year back if it wraps Dec→Jan
            yr1 = yr - 1 if mo1 > mo2 else yr
            start = mk(yr1, mo1, d1, h1)
            kind = "night"

    if start is None and NIGHT_PHRASE_RE.search(text):
        # Overnight report ("during the past night"), ending the posted morning.
        # Default boundary is 20:00 (prev day) → 07:00 (posted day), but the
        # channel usually states explicit hours — read them when present so a
        # late "с 23.00 … до 7.00" isn't recorded as the 20:00 default.
        start_h, end_h = 20, 7
        mh = NIGHT_HOURS_RE.search(text)
        if mh:
            start_h, end_h = int(mh.group(1)), int(mh.group(2))
        midnight = posted_msk.replace(hour=0, minute=0, second=0, microsecond=0)
        end = midnight + timedelta(hours=end_h)               # posted-day morning
        start = midnight + timedelta(hours=start_h)
        if start >= end:        # crosses midnight (e.g. 20:00→07:00) → prev day
            start -= timedelta(days=1)
        kind = "night"

    if start is None:
        m = DAY_RANGE_RE.search(text)
        if m:
            h1, mi1 = int(m.group(1)), int(m.group(2))
            h2, mi2 = int(m.group(3)), int(m.group(4))
            base = posted_msk.replace(minute=0, second=0, microsecond=0)

            def at(hh: int, mi: int) -> datetime:  # tolerate "24.00" → next-day 00:00
                extra, hh = divmod(hh, 24)
                return (base + timedelta(days=extra)).replace(hour=hh, minute=mi)

            start, end = at(h1, mi1), at(h2, mi2)
            crosses_midnight = end <= start
            if crosses_midnight:
                end += timedelta(days=1)
            # Use minute precision for the night cutoff: a 07:00 end IS the
            # overnight handoff (night), but 07:20 is already daytime.
            end_minutes = h2 * 60 + mi2
            kind = "night" if crosses_midnight or h1 >= 18 or end_minutes <= 7 * 60 else "day"

    if start is None:
        return None, None, "other"

    # A report always describes a window that has already happened. If we built a
    # start that's after the post's own timestamp, we attached it to the wrong
    # calendar day — e.g. an evening "с 20.00 до 23.00" update published just
    # after midnight describes the PREVIOUS evening (the same-day regexes anchor
    # on the post date). Shift the whole window back one day.
    if start > posted_msk:
        start -= timedelta(days=1)
        end -= timedelta(days=1)

    return start, end, kind


def _parse_regions(text: str):
    m = REGION_RE.search(text)
    if not m:
        return 0, ""
    clause = m.group(1).split(".")[0].strip()
    clause = re.sub(r"\s+", " ", clause)
    # rough region count: comma-separated items plus trailing " и X"
    parts = [p for p in re.split(r",|\s+и\s+", clause) if p.strip()]
    return len(parts), clause[:300]


def _split_po_regions(phrase: str) -> list[str]:
    """Split a distributive-"по N" region phrase into individual region names.

    Input shape: "над территориями A, B, ..., Y и Z областей" — one shared
    "над <noun>" prefix, regions separated by `,` and the final ` и `, and a
    trailing plural noun ("областей", "морей") that semantically belongs to
    each region. Output applies the canonical "<adj> области" form so the
    per-region rows merge with single-region bullets in the rest of the post.
    """
    parts = [p.strip(" .,") for p in re.split(r",\s*|\s+и\s+", phrase) if p.strip()]
    if not parts:
        return []
    # Strip leading "над " / "территориями " / "акваториями " (either or both,
    # in either order) from each part. PO_ITEM_RE has already eaten the first
    # "над" from the very front of the phrase, but later parts (joined by "и"
    # / commas) may carry their own "над" — e.g. "над территорией X области
    # и над Московским регионом" splits to "над Московским регионом" for the
    # second region.
    prefix = re.compile(r"^(?:над\s+)?(?:территори\w+|акватори\w+)?\s*", re.I)
    parts = [prefix.sub("", p).strip(" .,") for p in parts]
    parts = [p for p in parts if p]
    if not parts:
        return []
    # Pull the trailing plural noun off the last region (if any) and
    # propagate its singular form to earlier bare-adjective regions.
    last = parts[-1]
    for plural, singular in _PLURAL_TO_SINGULAR.items():
        if last.endswith(" " + plural) or last == plural:
            parts[-1] = (last[: -len(plural)].rstrip() + " " + singular).strip()
            for i in range(len(parts) - 1):
                # Bare adj (no embedded space) → append the singular noun.
                if " " not in parts[i]:
                    parts[i] = parts[i] + " " + singular
            break
    return parts


def parse_breakdown(text: str) -> list[tuple[str, int]]:
    """Extract per-region (name, count) pairs when the post itemizes them.

    Returns [] for the total-only format. Requires ≥2 items (a single match in
    the total-only wording would be spurious).

    Two item shapes are handled:
      * Single-region bullets ("N БПЛА – над территорией X области") — the
        common case, handled by REGION_ITEM_RE.
      * Distributive "по N" bullets ("по N БПЛА – над территориями X и Y
        областей") — one count, multiple regions; expanded via
        PO_ITEM_RE + _split_po_regions so the per-region sum equals the
        reported total.
    """
    # The MoD often appends one or more wider-window summary blocks AFTER the
    # immediate-window breakdown — same post, second total, second bullet list.
    # The headline COUNT_RE catches only the first total, but parse_breakdown
    # would otherwise sweep up bullets from BOTH halves, inflating the sum.
    # Truncate at the earliest of these footer markers so only the headline's
    # own breakdown remains:
    #   "📊 Всего за время налета …"   — bar-chart footer with a date suffix
    #                                    (".05" parses as a phantom count)
    #   "➡️ Всего за ночь …"           — newer "total this night" arrow form
    #   "Всего"                        — older "Всего, начиная с …" running total
    # All three reliably mark wider-window summaries in this channel; "Всего"
    # is also a common Russian adverb but never appears mid-bullet in MoD posts.
    cutoffs = [text.find(m) for m in ("📊", "➡️", "Всего")]
    cuts = [c for c in cutoffs if c >= 0]
    if cuts:
        text = text[: min(cuts)]
    items = []
    # First pass: distributive "по N" items. Track the matched spans so the
    # second pass (single-region regex) doesn't double-count their counts.
    consumed_spans: list[tuple[int, int]] = []
    for m in PO_ITEM_RE.finditer(text):
        count = _count_to_int(m.group(1))
        if count is None:
            continue
        regions = _split_po_regions(m.group(2))
        if len(regions) < 2:
            # No multi-region expansion needed — let the standard regex
            # handle it on the second pass instead.
            continue
        for r in regions:
            items.append((r, count))
        # Extend the consumed span backward over a preceding " и " conjunction
        # (msg 47783: "… Тамбовской области и по одному сбито …"). After
        # blanking, that "и" would otherwise dangle into the previous bullet's
        # region capture — the boundary lookahead can't fire across blanked
        # bullet glyphs, so the "и" needs to be erased too.
        start = m.start()
        back = re.search(r"\s+и\s+$", text[:start])
        if back:
            start = back.start()
        consumed_spans.append((start, m.end()))

    def _blank(text: str, spans: list[tuple[int, int]]) -> str:
        # Overwrite consumed spans with the black-square bullet glyph (which is
        # in REGION_ITEM_RE's region-exclusion set) rather than spaces. Plain
        # spaces leave a hole the next-item lookahead can't anchor on, so a
        # region capture preceding the consumed span (e.g. "… Тамбовской области
        # и …" before a deleted "по одному …") would walk past the "и" into the
        # gap. The sentinel terminates the region group cleanly.
        if not spans:
            return text
        chars = list(text)
        for s, e in spans:
            for i in range(s, e):
                chars[i] = "▪"
        return "".join(chars)
    residual = _blank(text, consumed_spans)

    # Second pass: region-first inverted bullets ("над територiей X уничтожено
    # N БПЛА"). Run before the standard pass so the consumed text doesn't get
    # a phantom REGION_ITEM_RE match starting at the count inside the bullet.
    rf_spans: list[tuple[int, int]] = []
    for m in REGION_FIRST_BULLET_RE.finditer(residual):
        count = _count_to_int(m.group(2))
        if count is None:
            continue
        name = re.sub(r"\s+", " ", m.group(1)).strip(" .,")
        if name:
            items.append((name, count))
            rf_spans.append((m.start(), m.end()))
    residual = _blank(residual, rf_spans)

    # Third pass: noun-first bullets ("N украинских <unit> уничтожен[ы] над
    # территорией X"). These are usually the OPENING bullet of a list whose
    # remaining items use the short standard form; capturing them here keeps
    # the count+region tied together so parse_report can detect a noun-first
    # "headline" that was actually just the first bullet.
    nf_spans: list[tuple[int, int]] = []
    for m in NOUN_FIRST_BULLET_RE.finditer(residual):
        count = _count_to_int(m.group(1))
        if count is None:
            continue
        name = _REGION_NOUN_RE.sub("", m.group(2))
        name = re.sub(r"\s+", " ", name).strip(" .,")
        if name:
            items.append((name, count))
            nf_spans.append((m.start(), m.end()))
    residual = _blank(residual, nf_spans)

    # Fourth pass: singular implicit bullets ("Также украинский БпЛА уничтожен
    # над акваторией X") — count is fixed at 1, no numeral in the text.
    sg_spans: list[tuple[int, int]] = []
    for m in SINGULAR_BULLET_RE.finditer(residual):
        name = _REGION_NOUN_RE.sub("", m.group(1))
        name = re.sub(r"\s+", " ", name).strip(" .,")
        if name:
            items.append((name, 1))
            sg_spans.append((m.start(), m.end()))
    residual = _blank(residual, sg_spans)

    # Fifth pass: standard single-region bullets on whatever's left.
    # Use a manual cursor instead of findall so a count phrase the regex
    # absorbed but _count_to_int rejects doesn't swallow the next valid item:
    # _COUNT_GROUP is greedy up to 3 words, so "беспилотных летательных
    # аппаратов" can match as the count, fail _count_to_int, and findall
    # would then advance past the whole match (taking "два БПЛА – над
    # территорией Московского региона" with it). Advancing by 1 char on
    # failure lets the next position retry from "два".
    pos = 0
    while pos < len(residual):
        m = REGION_ITEM_RE.search(residual, pos)
        if m is None:
            break
        count = _count_to_int(m.group(1))
        if count is None:
            pos = m.start() + 1
            continue
        name = _REGION_NOUN_RE.sub("", m.group(2))          # drop "территорией "/"акваторией "
        name = re.sub(r"\s+", " ", name).strip(" .,")
        if name:
            items.append((name, count))
        pos = m.end()

    # Merge duplicate region names — sums counts when the same area appears
    # in both a "по" expansion and a standalone bullet (or, rarely, in two
    # sub-window bullets within a single post). Without this `store()` trips
    # the (post_id, scraped_at, region) PK on ad_regions.
    merged: dict[str, int] = {}
    order: list[str] = []
    for name, count in items:
        if name in merged:
            merged[name] += count
        else:
            merged[name] = count
            order.append(name)
    items = [(name, merged[name]) for name in order]
    return items if len(items) >= 2 else []


def parse_report(text: str, post_id: int, posted_at_utc: datetime) -> Report | None:
    """Parse one AD intercept post; return None if it isn't one."""
    flat = re.sub(r"\s+", " ", _strip_md(html.unescape(text))).strip()
    if not AD_GATE.search(flat) or "беспилотн" not in flat.lower():
        return None
    # Сводка posts often carry "ПВО уничтожено N беспилотных летательных
    # аппаратов" inside their daily-stats block, satisfying AD_GATE. Reject
    # them up front so a future wording variant doesn't slip through as a
    # spurious AD report — parse_summary handles them on the next pass.
    if SVODKA_GATE.search(flat):
        return None
    extracted = _extract_drones(flat)
    if extracted is None:
        return None
    drones, drones_form = extracted
    posted_msk = posted_at_utc.astimezone(MSK)
    start, end, kind = _parse_window(flat, posted_msk)
    # attribute to the MSK date of the window end; fall back to posted MSK date
    report_date = (end or posted_msk).date().isoformat()

    # Prefer the itemized per-region counts when present; else the loose clause.
    breakdown = parse_breakdown(flat)
    # When the headline form was noun-first or singular (no separate verb-first
    # total), the "headline" count may actually be the first bullet of a
    # bullet-less list — e.g. "N украинских БПЛА уничтожены над X, M – над Y,
    # K – над Z". In that case the true total is the sum of all bullets, not
    # just the first one. Trust the breakdown when it sums higher than the
    # noun-first headline (max() keeps verb-first headlines authoritative).
    if drones_form != "verb_first" and breakdown:
        drones = max(drones, sum(c for _, c in breakdown))
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
        raw_text=flat,  # full text (uncapped) so a parser fix can re-derive in
                        # place from stored rows, like the GSUA scraper — the DB
                        # is tiny and AD posts are short.
        breakdown=breakdown,
    )


def parse_summary(text: str, post_id: int, posted_at_utc: datetime) -> Summary | None:
    """Detect a MoD Сводка summary post and capture it raw (header + full text).

    Numbers are intentionally NOT parsed yet (see DATASETS.md §3). Returns None
    for non-summary posts (incl. the air-defense intercept reports)."""
    flat = re.sub(r"\s+", " ", html.unescape(text)).strip()
    if not SVODKA_GATE.search(flat):
        return None
    # Briefing and main-of-day markers checked first — both carry incidental
    # "с D по D" date phrases that would otherwise satisfy SVODKA_WEEKLY_RE
    # and get mis-tagged as a weekly Сводка (msg 59941's "с 28 по 29 декабря
    # 2025" inside a "Тезисы брифинга" was the trigger).
    if _BRIEFING_MARKER.search(flat):
        # "Тезисы брифинга" briefing transcripts — multi-region, time-
        # windowed AD recaps that don't fit the standard single-window
        # model. Distinct kind so we can build a structured parser later.
        kind, period = "briefing", None
    elif _MAIN_OF_DAY_MARKER.search(flat):
        # "Главное за день" daily wrap-ups carry no period header — they're
        # the day they're posted on. Distinct kind so a future pass can
        # extract their "сбиты N БПЛА" recap separately from Сводка parts.
        kind, period = "main_of_day", None
    elif (w := SVODKA_WEEKLY_RE.search(flat)):
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


def _norm_summary(text: str) -> str:
    """Source-agnostic form of a summary's text, for change detection.

    Summaries are stored raw (unparsed), so unlike AD reports we have no parsed
    fields to compare — we compare the text instead. The web and telethon
    backends format the same post differently (see _strip_md), so normalize the
    Markdown + whitespace away: web↔telethon dedups, while a genuine wording edit
    still changes the normalized text and inserts a new version."""
    return re.sub(r"\s+", " ", _strip_md(text)).strip()


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
def iter_telethon(channel: str, offset_date=None):
    """Yield (post_id, posted_at_utc, text) NEWEST→OLDEST via the Telegram API.

    A generator, so the caller's --since date break stops fetching early (used for
    bounded historical backfill). Without --since it walks the full history.
    Needs TELEGRAM_API_ID/HASH; the session (RU_MOD_SESSION, default
    'ru_mod_session') is created on first run via an interactive login — point it
    at an existing authorised session to skip that.
    """
    api_id = os.environ.get("TELEGRAM_API_ID")
    api_hash = os.environ.get("TELEGRAM_API_HASH")
    if not api_id or not api_hash:
        raise SystemExit("ERROR: set TELEGRAM_API_ID and TELEGRAM_API_HASH for --source telethon")
    from telethon import TelegramClient
    from telethon.tl.types import Message

    session = os.environ.get("RU_MOD_SESSION", "ru_mod_session")
    with TelegramClient(session, int(api_id), api_hash) as client:
        client.flood_sleep_threshold = 60
        for msg in client.iter_messages(channel, offset_date=offset_date):  # newest first (from offset_date if given)
            if isinstance(msg, Message) and msg.text:
                yield msg.id, msg.date.astimezone(timezone.utc), msg.text


# ── storage ─────────────────────────────────────────────────────────────────
# Append-only & versioned: a Telegram post (post_id) can be EDITED after we first
# store it, so each scrape that sees changed content inserts a NEW row tagged with
# `scraped_at` rather than overwriting — no version is ever lost (mirrors the
# ru_losses model). All reads go through the latest scraped_at per post_id.
SCHEMA = """
CREATE TABLE IF NOT EXISTS ad_reports (
  post_id      INTEGER NOT NULL,
  scraped_at   TEXT NOT NULL,
  posted_at    TEXT NOT NULL,
  window_start TEXT,
  window_end   TEXT,
  window_kind  TEXT,
  report_date  TEXT NOT NULL,
  drones       INTEGER NOT NULL,
  region_count INTEGER,
  regions      TEXT,
  raw_text     TEXT,
  notes        TEXT,        -- derived caveat (NULL = clean); set by _flag_overlaps
  PRIMARY KEY (post_id, scraped_at)
);
CREATE INDEX IF NOT EXISTS ix_ad_date ON ad_reports(report_date);
-- Latest stored version of each post.
CREATE VIEW IF NOT EXISTS ad_latest AS
  SELECT r.* FROM ad_reports r
  JOIN (SELECT post_id, MAX(scraped_at) AS ms FROM ad_reports GROUP BY post_id) l
    ON r.post_id = l.post_id AND r.scraped_at = l.ms;
-- Per-region counts, populated only for posts that itemize them; versioned with
-- their post via scraped_at.
CREATE TABLE IF NOT EXISTS ad_regions (
  post_id     INTEGER NOT NULL,
  scraped_at  TEXT NOT NULL,
  report_date TEXT NOT NULL,
  region      TEXT NOT NULL,
  drones      INTEGER NOT NULL,
  PRIMARY KEY (post_id, scraped_at, region)
);
CREATE INDEX IF NOT EXISTS ix_adr_region ON ad_regions(region);
-- Days verified to have no standalone AD intercept post (the MoD was active
-- — usually a Сводка was posted — but didn't issue a discrete ПВО report).
-- Used by _warn_gap_days to suppress re-flagging dates we've already
-- audited; the frontend deliberately does NOT render these as 0 rows
-- because the day's actual intercept count is unknown (the Сводка stats
-- aren't parsed yet). A gap on the chart is the honest signal.
-- Populated manually via `python ingest.py --mark-silent YYYY-MM-DD '<note>'`.
CREATE TABLE IF NOT EXISTS silent_days (
  report_date TEXT PRIMARY KEY,
  note        TEXT,
  recorded_at TEXT NOT NULL
);
CREATE VIEW IF NOT EXISTS daily_ad AS
  SELECT report_date AS date,
         SUM(drones)  AS drones_destroyed,
         COUNT(*)     AS reports
  FROM ad_latest GROUP BY report_date;
CREATE VIEW IF NOT EXISTS region_totals AS
  SELECT g.region,
         SUM(g.drones)           AS drones,
         COUNT(DISTINCT g.post_id) AS reports
  FROM ad_regions g
  JOIN (SELECT post_id, MAX(scraped_at) AS ms FROM ad_reports GROUP BY post_id) l
    ON g.post_id = l.post_id AND g.scraped_at = l.ms
  GROUP BY g.region;
-- MoD Сводка summary posts captured raw (cumulative UA losses, not yet parsed);
-- versioned on edit, same as ad_reports.
CREATE TABLE IF NOT EXISTS summaries (
  post_id    INTEGER NOT NULL,
  scraped_at TEXT NOT NULL,
  posted_at  TEXT NOT NULL,
  kind       TEXT,
  period     TEXT,
  raw_text   TEXT NOT NULL,
  PRIMARY KEY (post_id, scraped_at)
);
"""


def _apply_schema(conn: sqlite3.Connection) -> None:
    """Run SCHEMA + any view/column migrations. Idempotent.

    `daily_ad` was changed to UNION in silent_days rows after the view
    first shipped, and `notes` was added to ad_reports later still —
    CREATE VIEW/TABLE IF NOT EXISTS won't replace existing definitions,
    so drop the view first and ALTER the column in if missing.
    """
    conn.execute("DROP VIEW IF EXISTS daily_ad")
    conn.executescript(SCHEMA)
    if "notes" not in {r[1] for r in conn.execute("PRAGMA table_info(ad_reports)")}:
        conn.execute("ALTER TABLE ad_reports ADD COLUMN notes TEXT")


def store(db_path: Path, reports: list[Report], summaries: list[Summary] = []) -> tuple[int, dict[str, int], int, str | None]:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    try:
        _apply_schema(conn)
        # Microsecond precision so two edits seen close together (or back-to-back
        # store() calls) get distinct version keys.
        scraped = datetime.now(timezone.utc).isoformat(timespec="microseconds")

        # Latest stored content per post, for change detection. We compare the
        # PARSED fields (not raw_text) so the same report ingested via two sources
        # — the web preview vs telethon, whose text normalization differs slightly
        # — dedups instead of looking like an edit. A real edit changes one of
        # these parsed values and so still inserts a new version.
        #
        # region_count is included so a re-scrape that recovers MORE per-region
        # lines than a previous (e.g. truncated) parse is detected as a change —
        # the `regions` string is capped at 300 chars and so is blind to extra
        # regions past the cap, but region_count isn't.
        latest_ad = {
            row[0]: tuple(row[1:])
            for row in conn.execute(
                "SELECT post_id, drones, window_start, window_end, window_kind, region_count, regions "
                "FROM ad_latest"
            )
        }
        latest_sum = {
            row[0]: _norm_summary(row[1])
            for row in conn.execute(
                "SELECT s.post_id, s.raw_text FROM summaries s "
                "JOIN (SELECT post_id, MAX(scraped_at) AS ms FROM summaries GROUP BY post_id) l "
                "ON s.post_id = l.post_id AND s.scraped_at = l.ms"
            )
        }

        inserted = 0
        inserted_ids: set[int] = set()
        for r in reports:
            content = (r.drones, r.window_start, r.window_end, r.window_kind, r.region_count, r.regions)
            if latest_ad.get(r.post_id) == content:
                continue  # unchanged — no new version
            inserted_ids.add(r.post_id)
            conn.execute(
                "INSERT INTO ad_reports "
                "(post_id,scraped_at,posted_at,window_start,window_end,window_kind,report_date,"
                " drones,region_count,regions,raw_text) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (r.post_id, scraped, r.posted_at, r.window_start, r.window_end, r.window_kind,
                 r.report_date, r.drones, r.region_count, r.regions, r.raw_text),
            )
            for region, n in r.breakdown:
                conn.execute(
                    "INSERT INTO ad_regions (post_id,scraped_at,report_date,region,drones) "
                    "VALUES (?,?,?,?,?)",
                    (r.post_id, scraped, r.report_date, region, n),
                )
            inserted += 1

        # Track summary inserts by kind so the run summary can show which
        # specific kinds (svodka_daily / briefing / main_of_day / …) were
        # newly captured this run — a single "N summaries" line obscured
        # which one actually landed, especially when refetching a small
        # window expecting one specific kind (e.g. a briefing re-ingest).
        sum_inserted_by_kind: dict[str, int] = {}
        for s in summaries:
            if latest_sum.get(s.post_id) == _norm_summary(s.raw_text):
                continue
            conn.execute(
                "INSERT INTO summaries (post_id,scraped_at,posted_at,kind,period,raw_text) "
                "VALUES (?,?,?,?,?,?)",
                (s.post_id, scraped, s.posted_at, s.kind, s.period, s.raw_text),
            )
            sum_inserted_by_kind[s.kind] = sum_inserted_by_kind.get(s.kind, 0) + 1

        conn.commit()
        total = conn.execute("SELECT COUNT(*) FROM ad_reports").fetchone()[0]
        latest = conn.execute("SELECT MAX(report_date) FROM ad_reports").fetchone()[0]
        pairs = _flag_overlaps(conn)
        conn.commit()
        if pairs:
            # An overlap is "this run" only if one of the two posts was just
            # inserted; the rest are pre-existing in the DB (don't re-alarm on them).
            run_pairs = [p for p in pairs if p[0] in inserted_ids or p[2] in inserted_ids]
            if run_pairs:
                ids = ", ".join(f"{p[0]} (overlaps {p[2]})" for p in run_pairs)
                print(f"WARNING: {len(run_pairs)} overlapping report window(s) in THIS run "
                      f"— post {ids} — possible double-count, noted in ad_reports.notes. "
                      f"({len(pairs)} total in DB.)", file=sys.stderr)
            else:
                print(f"note: {len(pairs)} pre-existing overlapping window(s) in DB; "
                      f"none new this run. See ad_reports.notes.", file=sys.stderr)

        # Breakdown integrity: an itemized report whose per-region counts don't
        # sum to its total has a missed region line — flag it like overlaps.
        mismatches = _breakdown_mismatches(conn)
        if mismatches:
            run_m = [m for m in mismatches if m[0] in inserted_ids]
            if run_m:
                detail = ", ".join(f"post {pid}: {bd}/{tot}" for pid, _sa, tot, bd in run_m)
                print(f"WARNING: {len(run_m)} itemized report(s) this run whose per-region "
                      f"counts don't sum to the total ({detail}) — likely a missed region "
                      f"line. ({len(mismatches)} total in DB.)", file=sys.stderr)
            else:
                print(f"note: {len(mismatches)} itemized report(s) in DB with an incomplete "
                      f"per-region breakdown; none new this run.", file=sys.stderr)
    finally:
        conn.close()
    return inserted, sum_inserted_by_kind, total, latest


def _overlap_pairs(conn) -> list[tuple[int, str, int, str]]:
    """Detect overlapping windows among the latest version of each post.

    Returns (post_id, scraped_at, neighbor_post_id, note) for the later-starting
    report of each overlapping adjacency — i.e. the one whose window begins before
    the previous report's window ended. That later report is the ambiguous one: in
    the common case its overnight count may re-include drones already reported in a
    separate evening update (the MoD posts both, and overnight reports often state
    no start time, so we assume 20:00). Overlap is a property of the latest
    versions only.
    """
    rows = conn.execute(
        "SELECT post_id, scraped_at, window_start, window_end FROM ad_latest "
        "WHERE window_start IS NOT NULL AND window_end IS NOT NULL ORDER BY window_start"
    ).fetchall()
    out: list[tuple[int, str, int, str]] = []
    prev_id = prev_end = None
    for pid, sa, ws, we in rows:
        if prev_end and ws < prev_end:
            note = (f"window may overlap preceding report (post {prev_id}, "
                    f"ends {prev_end[11:16]}) — possible double-count")
            out.append((pid, sa, prev_id, note))
        if prev_end is None or we > prev_end:
            prev_end, prev_id = we, pid
    return out


def _overlap_count(conn) -> int:
    return len(_overlap_pairs(conn))


def _breakdown_mismatches(conn) -> list[tuple[int, str, int, int]]:
    """Latest itemized reports whose per-region counts don't sum to the report
    total. A mismatch means a region line was missed (e.g. a new wording the
    REGION_ITEM_RE doesn't cover) — the same kind of drift we want surfaced at
    scrape time rather than discovered later. Returns (post_id, scraped_at,
    total, breakdown_sum). Total-only reports (no ad_regions rows) are excluded
    by the join, so they don't count as mismatches."""
    return conn.execute(
        "SELECT a.post_id, a.scraped_at, a.drones, SUM(g.drones) "
        "FROM ad_latest a JOIN ad_regions g "
        "  ON g.post_id = a.post_id AND g.scraped_at = a.scraped_at "
        "GROUP BY a.post_id, a.scraped_at HAVING SUM(g.drones) <> a.drones"
    ).fetchall()


def _flag_overlaps(conn) -> list[tuple[int, str, int, str]]:
    """Refresh the overlap note on every report: write it on the latest version of
    each overlapping report, clear it everywhere else. Idempotent — recomputed
    from the current latest set each run, so it can't go stale. Returns the pairs.
    """
    conn.execute("UPDATE ad_reports SET notes = NULL WHERE notes IS NOT NULL")
    pairs = _overlap_pairs(conn)
    for pid, sa, _neighbor, note in pairs:
        conn.execute("UPDATE ad_reports SET notes = ? WHERE post_id = ? AND scraped_at = ?",
                     (note, pid, sa))
    return pairs


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
    ap.add_argument(
        "--since", metavar="YYYY-MM-DD",
        help="re-scan posts on/after this MSK date instead of stopping at the last stored id. "
             "Lets edits to recent posts be re-checked (a new version is stored only when content "
             "changed). Use latest-stored-date minus a couple days in CI; an older date for backfill.",
    )
    ap.add_argument(
        "--until", metavar="YYYY-MM-DD",
        help="only process posts on/before this MSK date — pair with --since for a bounded "
             "backfill window (e.g. one month). telethon starts fetching at this date.",
    )
    ap.add_argument("--selftest", action="store_true", help="parse built-in samples, no network")
    ap.add_argument(
        "--mark-silent", nargs=2, metavar=("YYYY-MM-DD", "NOTE"),
        help="Record that the MoD posted no standalone AD intercept on this MSK date "
             "(usually because only Сводки went out that day). Adds a 0-drone row to "
             "daily_ad via the silent_days table, and suppresses the gap-day warning "
             "for the date. Verify with probe_gap.py before marking.",
    )
    args = ap.parse_args()

    if args.selftest:
        return selftest()
    if args.mark_silent:
        return mark_silent_day(Path(args.out), args.mark_silent[0], args.mark_silent[1]) or 0
    for name, val in (("--since", args.since), ("--until", args.until)):
        if val and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", val):
            ap.error(f"{name} must be YYYY-MM-DD")

    out = Path(args.out)

    reports: list[Report] = []
    summaries: list[Summary] = []
    if args.source == "web":
        # With --since we re-scan a recent date window (id-stop off) so edits get
        # re-checked; otherwise stop at the last stored post id.
        since_id = 0 if (args.since or args.backfill) else max_stored_id(out)
        print(f"==> web preview t.me/s/{args.channel} "
              f"(since={args.since or f'id>{since_id}'}, backfill={args.backfill})")
        src = iter_web(args.channel, since_id, args.max_pages, args.sleep, args.backfill or bool(args.since))
    else:
        # telethon can start at --until (newest-first from that date), so a window
        # deep in history doesn't re-fetch everything more recent.
        offset_date = datetime.fromisoformat(f"{args.until}T23:59:59+03:00") if args.until else None
        print(f"==> telethon @{args.channel} (newest→oldest, "
              f"window {args.since or 'start'}…{args.until or 'now'})")
        src = iter_telethon(args.channel, offset_date=offset_date)

    scanned = 0
    # Track the MSK-date span this run examined so _warn_gap_days can list
    # dates in that span with no stored AD report — catches posts the gate
    # or parser is silently dropping (channel was active but DB has nothing).
    scan_min: str | None = None
    scan_max: str | None = None
    for pid, posted, text in src:
        msk_date = posted.astimezone(MSK).date().isoformat()
        # Date window (newest→oldest): skip newer than --until, stop past --since.
        if args.until and msk_date > args.until:
            continue
        if args.since and msk_date < args.since:
            break
        scanned += 1
        if scan_min is None or msk_date < scan_min:
            scan_min = msk_date
        if scan_max is None or msk_date > scan_max:
            scan_max = msk_date
        r = parse_report(text, pid, posted)
        if r:
            reports.append(r)
            continue
        s = parse_summary(text, pid, posted)
        if s:
            summaries.append(s)

    inserted, sum_inserted_by_kind, total, latest = store(out, reports, summaries)
    # Per-kind breakdown of summary parses (what we read this run) AND
    # inserts (what was new vs. already in the DB at this content version).
    sum_parsed_by_kind: dict[str, int] = {}
    for s in summaries:
        sum_parsed_by_kind[s.kind] = sum_parsed_by_kind.get(s.kind, 0) + 1
    def _kinds(d: dict[str, int]) -> str:
        return ", ".join(f"{k} {v}" for k, v in sorted(d.items()))
    sum_total = sum(sum_inserted_by_kind.values())
    parsed_str = f"{len(summaries)} parsed" + (f" [{_kinds(sum_parsed_by_kind)}]" if sum_parsed_by_kind else "")
    new_str = f"{sum_total} new" + (f" [{_kinds(sum_inserted_by_kind)}]" if sum_inserted_by_kind else "")
    print(f"==> scanned {scanned} posts; AD: {len(reports)} parsed → {inserted} new; "
          f"summaries: {parsed_str} → {new_str}; "
          f"DB total {total} (latest {latest}) → {out}")
    _warn_gap_days(out, scan_min, scan_max)
    return 0


def _warn_gap_days(out: Path, scan_min: str | None, scan_max: str | None) -> None:
    """Print a WARNING listing dates in [scan_min, scan_max] with no stored
    ad_reports row. Run after store() so freshly-ingested rows count.

    Today's MSK date is excluded — the channel's overnight report often
    lands several hours into the new day, so an in-progress day with no
    report yet isn't a signal worth surfacing on every CI run.
    """
    if not scan_min or not scan_max:
        return
    today = datetime.now(MSK).date().isoformat()
    if scan_max >= today:
        scan_max = (date.fromisoformat(today) - timedelta(days=1)).isoformat()
    if scan_max < scan_min:
        return
    with sqlite3.connect(out) as conn:
        covered = {d for (d,) in conn.execute(
            "SELECT DISTINCT report_date FROM ad_latest "
            "WHERE report_date BETWEEN ? AND ?",
            (scan_min, scan_max),
        )}
        # Skip dates we've already verified as MoD-silent — re-flagging them
        # every run isn't useful, the silent_days row is the record.
        silent = {d for (d,) in conn.execute(
            "SELECT report_date FROM silent_days "
            "WHERE report_date BETWEEN ? AND ?",
            (scan_min, scan_max),
        )}
    gaps: list[str] = []
    d = date.fromisoformat(scan_min)
    end = date.fromisoformat(scan_max)
    while d <= end:
        s = d.isoformat()
        if s not in covered and s not in silent:
            gaps.append(s)
        d += timedelta(days=1)
    if not gaps:
        return
    head = ", ".join(gaps[:10])
    more = f" (+{len(gaps) - 10} more)" if len(gaps) > 10 else ""
    print(f"WARNING: {len(gaps)} day(s) in [{scan_min}, {scan_max}] "
          f"with no AD report in DB — verify with probe_gap.py, then mark "
          f"confirmed-silent ones via --mark-silent: {head}{more}")


def mark_silent_day(db_path: Path, report_date: str, note: str) -> None:
    """Record that a date had no standalone MoD AD intercept post, so
    daily_ad surfaces a 0 instead of a gap and the warning above stops
    re-flagging it. Idempotent — re-marking just updates the note."""
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", report_date):
        raise SystemExit(f"ERROR: --mark-silent date must be YYYY-MM-DD, got {report_date!r}")
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    try:
        _apply_schema(conn)
        # Guard against marking a date that already has a real AD report —
        # silent_days is for verified-empty days, not for overriding real data.
        n = conn.execute(
            "SELECT COUNT(*) FROM ad_latest WHERE report_date = ?",
            (report_date,),
        ).fetchone()[0]
        if n:
            raise SystemExit(
                f"ERROR: {report_date} already has {n} AD report(s) in ad_latest; "
                f"silent_days is for days with no standalone intercept post."
            )
        recorded_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
        conn.execute(
            "INSERT INTO silent_days (report_date, note, recorded_at) VALUES (?, ?, ?) "
            "ON CONFLICT(report_date) DO UPDATE SET note=excluded.note, recorded_at=excluded.recorded_at",
            (report_date, note, recorded_at),
        )
        conn.commit()
        print(f"==> marked {report_date} as silent (note: {note!r}) → {db_path}")
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
