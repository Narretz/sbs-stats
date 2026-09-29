#!/usr/bin/env python3
"""
parse.py — read the President's weekly strike tally out of one Telegram post.

Most Sundays (sometimes Saturday, occasionally Monday) the President's channel
closes a post with one sentence totalling the week's Russian strikes on
Ukraine, in three counters that are always the same three:

    За цей тиждень росіяни випустили по Україні понад 3170 ударних дронів,
    більше 1300 КАБів і 74 ракети різних типів, із них більшість – балістичні.

    Протягом тижня під ударом була більшість регіонів України. 1310 російських
    керованих авіаційних бомб, понад 1000 ударних дронів, більшість – «шахеди»,
    ще дев’ять ракет різних типів включно з балістикою.

What makes it harder than it looks:

* The tally is ONE sentence inside a long speech, and the sentence before it is
  often a *nightly* count ("Протягом цієї ночі Україну атакували 103
  «шахеди»…"). So the scope is the sentence, never the post: a sentence that
  names the week, or — when the week sentence carries no numbers — the one
  sentence straight after it.
* The wording, the order of the three counters and the bomb label
  ("керованих авіаційних бомб" / "керованих авіабомб" / "КАБів") all drift, and
  a small count is sometimes spelled out ("дев’ять ракет").
* Every figure is rounded and most carry a hedge (понад / більше / майже /
  близько). The hedge is kept as `bound` so a chart can say "≈" honestly.
* The week itself is never dated — "цього тижня" / "минулого тижня" — so the
  period is DERIVED from when the post went up (see `week_bounds`).

Posts in English ("Over the week, Russia launched more than 3,170 attack
drones…") are the same tally translated; they parse too, with `lang='en'`, and
the DB view prefers the Ukrainian post for a week (see schema.sql).
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

KYIV = ZoneInfo("Europe/Kyiv")

DRONES = "drones"
BOMBS = "bombs"
MISSILES = "missiles"
CATEGORIES = (DRONES, BOMBS, MISSILES)

# A sentence that names the week and carries the numbers itself is a tally
# with any number of the three counters — single-weapon weeks are real
# ("Лише за цей тиждень Росія випустила по Україні близько 2100 дронів.").
# The weaker "week named in one sentence, counted in the next" shape needs
# two, so a stray number in the following sentence can't pass for a tally.
MIN_CATEGORIES_NEXT_SENTENCE = 2


@dataclass
class Counter:
    category: str       # drones | bombs | missiles
    value: int
    bound: str          # exact | approx | at_least | at_most
    qualifier: str      # the hedge word verbatim ('' when bare)
    raw_label: str      # the matched phrase verbatim, e.g. "понад 3170 ударних дронів"


@dataclass
class Report:
    report_type: str                 # 'weekly' | 'weekly_partial' | 'unknown'
    lang: str | None = None          # 'uk' | 'en'
    week_ref: str | None = None      # 'this' | 'last'
    period: str | None = None        # ISO week, 'YYYY-Www'
    period_start: str | None = None  # Monday, 'YYYY-MM-DD'
    period_end: str | None = None    # Sunday, 'YYYY-MM-DD'
    counters: list[Counter] = field(default_factory=list)
    sentence: str = ""               # the tally sentence(s), verbatim
    warnings: list[str] = field(default_factory=list)


# ── numbers ─────────────────────────────────────────────────────────────────

# Small counts are sometimes spelled out. Only the forms that have been seen
# or are one inflection away; a missing word just means that counter is not
# found, which the "mentioned but not counted" warning in parse() surfaces.
_UK_WORDS = {
    "один": 1, "одна": 1, "одну": 1, "два": 2, "дві": 2, "три": 3,
    "чотири": 4, "п’ять": 5, "п'ять": 5, "шість": 6, "сім": 7, "вісім": 8,
    "дев’ять": 9, "дев'ять": 9, "десять": 10, "одинадцять": 11,
    "дванадцять": 12, "тринадцять": 13, "чотирнадцять": 14,
    "п’ятнадцять": 15, "п'ятнадцять": 15, "двадцять": 20, "тридцять": 30,
    "сорок": 40, "п’ятдесят": 50, "п'ятдесят": 50,
    "тисяча": 1000, "тисячу": 1000, "тисячі": 1000,
}
# Round words that are only a number behind a hedge: "майже тисяча КАБів",
# "більше тисячі авіабомб" are ~1000, but a bare "тисячі дронів" is
# "thousands of drones". ("сотні" — "hundreds" — is never a count, so it isn't
# in the table at all.)
_NEEDS_QUALIFIER = {"тисяча", "тисячу", "тисячі", "a thousand"}
_EN_WORDS = {
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6,
    "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12,
    "twenty": 20, "thirty": 30, "forty": 40, "fifty": 50,
    "a hundred": 100, "a thousand": 1000,
}

# "3170", "3 170" (incl. NBSP / narrow NBSP), "3,170" (EN thousands), plus an
# optional "тисяч(і)" / "thousand" multiplier ("понад 1,5 тисячі").
_DIGITS = r"\d{1,3}(?:[   ]\d{3})+|\d{1,3}(?:,\d{3})+|\d+(?:[.,]\d+)?"
_MULT_UK = r"(?:\s+тис(?:яч[аіу]?|\.))?"
_MULT_EN = r"(?:\s+thousand)?"


def _to_int(num: str, mult: str) -> int:
    s = re.sub(r"[   ]", "", num)
    if mult.strip():
        return round(float(s.replace(",", ".")) * 1000)
    return int(s.replace(",", "").replace(".", ""))


# ── hedges ──────────────────────────────────────────────────────────────────

_UK_QUAL = {
    "понад": "at_least", "більше ніж": "at_least", "більш ніж": "at_least",
    "більше як": "at_least", "більш як": "at_least",
    "більше": "at_least", "більш": "at_least", "щонайменше": "at_least",
    "майже": "at_most", "близько": "approx", "приблизно": "approx",
    "до": "approx", "ще": "exact",
}
_EN_QUAL = {
    "more than": "at_least", "over": "at_least", "at least": "at_least",
    "almost": "at_most", "nearly": "at_most", "about": "approx",
    "around": "approx", "approximately": "approx", "roughly": "approx",
    "some": "approx",
}


# ── weapon labels ───────────────────────────────────────────────────────────
# Matched against the head noun that follows the number, with up to a few
# modifiers in between ("1310 російських керованих авіаційних бомб"). Bombs are
# tried before drones before missiles only for readability — the three stems
# don't overlap.

_UK_WEAPON = [
    (BOMBS, r"(?:авіа)?бомб\w*|КАБ\w*|кабів"),
    (DRONES, r"дрон\w*|безпілотник\w*|БпЛА|«?шахед\w*»?"),
    (MISSILES, r"ракет\w*"),
]
_EN_WEAPON = [
    (BOMBS, r"(?:aerial\s+|air\s+)?bombs?|KABs?"),
    (DRONES, r"drones?|UAVs?|[\"“«]?Shaheds?[\"”»]?"),
    (MISSILES, r"missiles?"),
]

# Up to 4 modifier words between the number and the noun: no digits, no
# clause punctuation, so the gap can't swallow the next counter.
_GAP = r"(?:\s+[^\s\d,.;:–—()]+){0,4}?"


def _counter_re(quals: dict[str, str], words: dict[str, int], mult: str,
                weapons: list[tuple[str, str]]) -> re.Pattern:
    qual = "|".join(sorted((re.escape(q) for q in quals), key=len, reverse=True))
    word = "|".join(sorted((re.escape(w) for w in words), key=len, reverse=True))
    weapon = "|".join(f"(?P<{cat}>{pat})" for cat, pat in weapons)
    return re.compile(
        rf"(?:(?P<qual>{qual})\s+)?"
        rf"(?:(?P<num>{_DIGITS}){mult}|(?P<word>{word}))"
        rf"(?P<gap>{_GAP})\s+(?:{weapon})(?!\w)",
        re.IGNORECASE,
    )


_UK_COUNTER = _counter_re(_UK_QUAL, _UK_WORDS, _MULT_UK, _UK_WEAPON)
_EN_COUNTER = _counter_re(_EN_QUAL, _EN_WORDS, _MULT_EN, _EN_WEAPON)


# ── week markers ────────────────────────────────────────────────────────────

_UK_WEEK = re.compile(r"\bтижн(?:я|і|ем)\b|\bтиждень\b", re.IGNORECASE)
_EN_WEEK = re.compile(r"\bweek\b", re.IGNORECASE)
# Not a whole-week tally: next week, weeks ago, and "since the start of the
# week" — a mid-week running count ("Від початку тижня … за неповні три доби
# росіяни застосували … майже 530 дронів") that would pass for a low week.
_UK_NOT_THIS_WEEK = re.compile(
    r"наступн\w+\s+тижн|тижн\w*\s+(?:тому|раніше)|початку\s+тижн|\bдоб[аиу]\b",
    re.IGNORECASE,
)
_EN_NOT_THIS_WEEK = re.compile(
    r"next\s+week|weeks?\s+ago|since\s+the\s+(?:start|beginning)\s+of\s+the\s+week|\bdays\b",
    re.IGNORECASE,
)
_UK_LAST = re.compile(r"(?:минул|попередн)\w+\s+(?:тижн|тиждень)", re.IGNORECASE)
_EN_LAST = re.compile(r"last\s+week|previous\s+week", re.IGNORECASE)
# The number-bearing sentence straight after a week sentence is only taken
# when it isn't itself about a night or a day.
_UK_SHORTER = re.compile(r"\bноч\w*|\bніч\w*|\bдоб\w*|\bсьогодні|\bвчора", re.IGNORECASE)
_EN_SHORTER = re.compile(r"\bnight\b|\btoday\b|\byesterday\b|\bovernight\b", re.IGNORECASE)

# Counted as SHOT DOWN, not launched: "Тільки за цей тиждень Сили оборони
# України збили в нашому небі 33 ракети … та 311 ударних дронів". A different
# measure, so a sentence whose interception verb comes before its first count
# is not a tally. (After the count it is a breakdown — "застосувала 1000
# дронів, з них збито 900" — and the first-match rule already keeps 1000.)
_UK_SHOT_DOWN = re.compile(r"\bзби(?:ли|то|ти|вати|ває)\b|\bзнищ\w+|\bперехоп\w+", re.IGNORECASE)
_EN_SHOT_DOWN = re.compile(r"\bshot\s+down\b|\bintercept\w*|\bdowned\b|\bdestroyed\b", re.IGNORECASE)

# Sentence split: terminal punctuation followed by whitespace, or a newline.
# Deliberately NOT on "," — the three counters share one sentence.
_SENT_SPLIT = re.compile(r"(?<=[.!?…])\s+|\n+")

_CYRILLIC = re.compile(r"[а-яіїєґ]", re.IGNORECASE)


def _lang(text: str) -> str:
    letters = re.findall(r"[^\W\d_]", text)
    if not letters:
        return "uk"
    cyr = sum(1 for ch in letters if _CYRILLIC.match(ch))
    return "uk" if cyr * 2 >= len(letters) else "en"


def _counters(sentence: str, lang: str) -> tuple[list[Counter], list[str]]:
    """Every counter in `sentence`, first occurrence per category.

    First wins because a later mention of the same weapon is a breakdown of
    it ("99 ракет різних типів, зокрема 40 балістичних ракет", "понад 1000
    ударних дронів, більшість – «шахеди»"), never a second total.
    """
    rx, quals, words = (
        (_UK_COUNTER, _UK_QUAL, _UK_WORDS) if lang == "uk"
        else (_EN_COUNTER, _EN_QUAL, _EN_WORDS)
    )
    found: dict[str, Counter] = {}
    dupes: list[str] = []
    for m in rx.finditer(sentence):
        cat = next(c for c in CATEGORIES if m.group(c))
        if m.group("num"):
            mult = m.group(0)[m.end("num") - m.start(0):m.start("gap") - m.start(0)]
            value = _to_int(m.group("num"), mult)
        else:
            word = m.group("word").lower()
            if word in _NEEDS_QUALIFIER and not m.group("qual"):
                continue
            value = words[word]
        q = (m.group("qual") or "").lower()
        c = Counter(cat, value, quals.get(q, "exact"), m.group("qual") or "", m.group(0).strip())
        if cat in found:
            dupes.append(c.raw_label)
            continue
        found[cat] = c
    return [found[c] for c in CATEGORIES if c in found], dupes


def week_bounds(posted_at: datetime, week_ref: str) -> tuple[date, date]:
    """Monday–Sunday of the week a tally covers, from when it was posted.

    The post never dates the week, so this is a convention, not a reading.
    The rule is "the last Sunday-ending week that could be meant":

    * posted Saturday/Sunday (Kyiv) → the ISO week of the post, whether it
      says "this week" or "last week". On a Sunday "минулого тижня" means the
      week ending today: 2024-09-01's «понад 160 ракет» only fits the week of
      the 26 August mass strike, not the one before it.
    * posted Monday/Tuesday → the week that just ended, either wording.
    * posted Wednesday–Friday → "last week" is the previous ISO week; "this
      week" is the current one, and the caller marks it partial.
    """
    d = posted_at.astimezone(KYIV).date()
    monday = d - timedelta(days=d.weekday())
    if d.weekday() <= 1 or (week_ref == "last" and d.weekday() <= 4):
        monday -= timedelta(days=7)
    return monday, monday + timedelta(days=6)


def parse(text: str, posted_at: datetime) -> Report:
    lang = _lang(text)
    week_rx, not_rx, last_rx, shorter_rx, shot_rx, counter_rx = (
        (_UK_WEEK, _UK_NOT_THIS_WEEK, _UK_LAST, _UK_SHORTER, _UK_SHOT_DOWN, _UK_COUNTER)
        if lang == "uk"
        else (_EN_WEEK, _EN_NOT_THIS_WEEK, _EN_LAST, _EN_SHORTER, _EN_SHOT_DOWN, _EN_COUNTER)
    )

    def shot_down(sentence: str) -> bool:
        verb, first = shot_rx.search(sentence), counter_rx.search(sentence)
        return bool(verb and first and verb.start() < first.start())

    sentences = [s.strip() for s in _SENT_SPLIT.split(text) if s and s.strip()]

    for i, s in enumerate(sentences):
        if not week_rx.search(s) or not_rx.search(s):
            continue
        # "Минулої ночі Росія тероризувала Україну більш ніж 50 ударними
        # дронами, а за тиждень завдала … ударів понад 900 бомбами …" — a
        # night and the week in one sentence. When the shorter period comes
        # first, count only from the clause that names the week.
        week_at = week_rx.search(s).start()
        if shorter_rx.search(s[:week_at]):
            cut = max(s.rfind(ch, 0, week_at) for ch in ",;:–—")
            s = s[cut + 1:].strip() if cut >= 0 else s
        scope = s
        counters, dupes = _counters(s, lang)
        if not counters and i + 1 < len(sentences):
            # "Протягом тижня під ударом була більшість регіонів України. 1310
            # російських керованих авіаційних бомб, …" — the week is named in
            # one sentence and counted in the next.
            nxt = sentences[i + 1]
            if not week_rx.search(nxt) and not shorter_rx.search(nxt):
                more, more_dupes = _counters(nxt, lang)
                if len(more) >= MIN_CATEGORIES_NEXT_SENTENCE:
                    scope, counters, dupes = f"{s} {nxt}", more, more_dupes
        if not counters or shot_down(scope):
            continue

        week_ref = "last" if last_rx.search(scope) else "this"
        start, end = week_bounds(posted_at, week_ref)
        iso = start.isocalendar()
        # Posted Wednesday–Friday about "this week", the count can only be the
        # week so far. Stored — it is what was said — but as its own type, so
        # the weekly series never shows a three-day count as a low week.
        weekday = posted_at.astimezone(KYIV).weekday()
        partial = week_ref == "this" and 2 <= weekday <= 4
        report = Report(
            "weekly_partial" if partial else "weekly", lang, week_ref, f"{iso.year}-W{iso.week:02d}",
            start.isoformat(), end.isoformat(), counters, scope,
        )
        if dupes:
            report.warnings.append(
                f"tally sentence repeats a weapon; kept the first, ignored {dupes}"
            )
        # A weapon the tally NAMES but that no counter claimed is a number
        # this parser couldn't read (a spelled-out count, a new label, the
        # number after the noun). A weapon simply absent is the week's own
        # choice — single-weapon tallies are normal — and is not flagged.
        weapons = _UK_WEAPON if lang == "uk" else _EN_WEAPON
        have = {c.category for c in counters}
        for cat, pat in weapons:
            if cat not in have and re.search(rf"(?<!\w)(?:{pat})(?!\w)", scope, re.IGNORECASE):
                report.warnings.append(
                    f"tally mentions {cat} but no count was parsed for it"
                )
        return report

    return Report("unknown")
