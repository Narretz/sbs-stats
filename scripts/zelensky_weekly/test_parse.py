#!/usr/bin/env python3
"""
Golden-value tests for scripts/zelensky_weekly/parse.py.

    bash scripts/test_python.sh scripts/zelensky_weekly

Fixtures under fixtures/ are verbatim post texts from @V_Zelenskiy_official,
captured from the t.me/s preview. Each one is here for the trap it contains,
named in its GOLDEN stanza; when a new wording breaks the parser, add the post
and a stanza.
"""
from __future__ import annotations

import pathlib
import sys
from datetime import datetime

import pytest

SCRIPT_DIR = pathlib.Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from parse import parse, week_bounds  # noqa: E402

FIXTURES = SCRIPT_DIR / "fixtures"


def _post(post_id: int) -> str:
    return (FIXTURES / f"post{post_id}.txt").read_text(encoding="utf-8")


def _utc(s: str) -> datetime:
    return datetime.fromisoformat(s + "+00:00")


# (post_id, posted_at UTC, period, week_ref, {category: (value, bound)}, why)
GOLDEN = [
    (19086, "2026-05-17T07:44:25", "2026-W20", "this",
     {"drones": (3170, "at_least"), "bombs": (1300, "at_least"), "missiles": (74, "exact")},
     "the standard Sunday shape; bombs as «КАБів»"),
    (13715, "2025-03-30T10:41:05", "2025-W13", "this",
     {"bombs": (1310, "exact"), "drones": (1000, "at_least"), "missiles": (9, "exact")},
     "week named in one sentence, counted in the next; «дев’ять ракет» spelled out"),
    (12904, "2025-01-05T10:00:40", "2025-W01", "this",
     {"drones": (630, "at_least"), "bombs": (740, "approx"), "missiles": (50, "at_most")},
     "a nightly «103 шахеди» sentence right before the tally"),
    (12315, "2024-11-03T09:10:44", "2024-W44", "this",
     {"drones": (500, "at_most"), "bombs": (900, "at_least"), "missiles": (30, "approx")},
     "night and week in ONE sentence; the night's 50 drones must not be taken"),
    (13020, "2025-01-19T10:03:19", "2025-W03", "this",
     {"drones": (550, "approx"), "missiles": (60, "at_most"), "bombs": (660, "at_least")},
     "an earlier week sentence counts SHOT DOWN (збили) — not the tally"),
    (15011, "2025-07-07T08:04:39", "2025-W27", "last",
     {"drones": (1270, "approx"), "missiles": (39, "exact"), "bombs": (1000, "at_most")},
     "Monday «за минулий тиждень»; «майже тисяча КАБів»"),
    (15591, "2025-08-11T10:22:10", "2025-W32", "last",
     {"bombs": (1000, "at_least"), "drones": (1400, "at_most")},
     "«більше тисячі авіабомб»; two weapons only"),
    (18804, "2026-04-27T09:02:19", "2026-W17", "last",
     {"drones": (1900, "approx"), "bombs": (1400, "at_most"), "missiles": (60, "approx")},
     "Monday «упродовж минулого тижня»"),
    (11507, "2024-09-01T08:00:00", "2024-W35", "last",
     {"missiles": (160, "at_least"), "bombs": (780, "exact"), "drones": (400, "exact")},
     "SUNDAY «минулого тижня» = the week ending today (26 Aug mass strike)"),
    (11243, "2024-07-28T08:00:00", "2024-W30", "this",
     {"bombs": (700, "approx"), "drones": (100, "at_least")},
     "«більш як 100 «шахедів»»; the week phrase comes last"),
    (20861, "2026-09-13T09:04:22", "2026-W37", "this",
     {"drones": (2100, "approx")},
     "a single-weapon tally"),
    (20347, "2026-08-09T07:28:41", "2026-W32", "this",
     {"missiles": (61, "exact")},
     "single weapon; the «серед них 56» breakdown has no noun"),
    (16622, "2025-10-26T07:19:42", "2025-W43", "this",
     {"drones": (1200, "at_most"), "bombs": (1360, "at_least"), "missiles": (50, "at_least")},
     "the verb comes after all three counters"),
    (16623, "2025-10-26T16:57:40", "2025-W43", "this",
     {"drones": (1200, "at_most"), "missiles": (50, "exact")},
     "the evening repeat of 16622, without bombs (the view must prefer 16622)"),
    (16624, "2025-10-26T18:40:47", "2025-W43", "this",
     {"drones": (1200, "at_most"), "missiles": (50, "exact")},
     "English: «almost 1,200 attack drones»"),
    (19650, "2026-06-27T09:01:24", "2026-W26", "this",
     {"drones": (1400, "approx"), "bombs": (1500, "at_most"), "missiles": (19, "exact")},
     "posted Saturday"),
]


@pytest.mark.parametrize(
    "post_id,posted,period,week_ref,expected,why", GOLDEN, ids=[str(g[0]) for g in GOLDEN]
)
def test_golden(post_id, posted, period, week_ref, expected, why):
    r = parse(_post(post_id), _utc(posted))
    assert r.report_type == "weekly", why
    assert r.period == period, why
    assert r.week_ref == week_ref, why
    assert {c.category: (c.value, c.bound) for c in r.counters} == expected, why
    assert r.warnings == [], why


def test_english_is_tagged():
    assert parse(_post(16624), _utc("2025-10-26T18:40:47")).lang == "en"
    assert parse(_post(16622), _utc("2025-10-26T07:19:42")).lang == "uk"


# (post_id, posted_at UTC, why) — posts with a week-ish sentence and numbers
# that are NOT a whole-week tally.
NEGATIVE = [
    (19445, "2026-06-10T09:00:45", "«Від початку тижня … за неповні три доби» — the week so far"),
    (15101, "2025-07-13T08:32:15", "«сотні збиттів … шахедів за цей тиждень» — hundreds, and shot down"),
    (14696, "2025-06-15T10:14:06", "«За цей місяць» — month-to-date, a different series"),
    (13867, "2025-04-14T10:48:16", "«Лише від початку квітня» — month-to-date"),
]


@pytest.mark.parametrize("post_id,posted,why", NEGATIVE, ids=[str(n[0]) for n in NEGATIVE])
def test_not_a_tally(post_id, posted, why):
    assert parse(_post(post_id), _utc(posted)).report_type == "unknown", why


# ── sentence-level cases, no fixture needed ─────────────────────────────────

SUNDAY = _utc("2026-05-17T08:00:00")
WEDNESDAY = _utc("2026-05-13T08:00:00")


def test_midweek_this_week_is_partial():
    text = "За цей тиждень Росія вже застосувала понад 900 ударних дронів і 40 ракет."
    r = parse(text, WEDNESDAY)
    assert r.report_type == "weekly_partial"
    assert r.period == "2026-W20"


def test_bare_thousands_is_not_a_count():
    # «тисячі дронів» is "thousands of drones", not 1000.
    text = "За цей тиждень тисячі дронів і 40 ракет різних типів."
    r = parse(text, SUNDAY)
    assert {c.category: c.value for c in r.counters} == {"missiles": 40}


def test_space_grouped_and_thousand_multiplier():
    text = "За цей тиждень — понад 3 170 ударних дронів, 1,5 тисячі КАБів та 74 ракети."
    r = parse(text, SUNDAY)
    assert {c.category: c.value for c in r.counters} == {
        "drones": 3170, "bombs": 1500, "missiles": 74,
    }


def test_breakdown_after_total_is_ignored():
    text = ("Протягом тижня Росія застосувала 99 ракет різних типів, "
            "зокрема 40 балістичних ракет, та 1450 ударних дронів.")
    r = parse(text, SUNDAY)
    assert {c.category: c.value for c in r.counters} == {"missiles": 99, "drones": 1450}
    assert r.warnings and "repeats a weapon" in r.warnings[0]


def test_unread_weapon_is_warned():
    # A weapon the tally names with a number the parser can't read.
    text = "За цей тиждень понад 1000 ударних дронів і ракет різних типів — 40."
    r = parse(text, SUNDAY)
    assert any("missiles" in w for w in r.warnings)


def test_next_week_is_not_a_tally():
    text = "Наступного тижня очікуємо 30 ракет для Patriot і 100 дронів-перехоплювачів."
    assert parse(text, SUNDAY).report_type == "unknown"


@pytest.mark.parametrize("posted,ref,start", [
    ("2026-05-17T07:00:00", "this", "2026-05-11"),   # Sunday
    ("2026-05-16T07:00:00", "this", "2026-05-11"),   # Saturday
    ("2026-05-18T07:00:00", "this", "2026-05-11"),   # Monday: the week just ended
    ("2026-05-18T07:00:00", "last", "2026-05-11"),   # Monday "last week"
    ("2026-05-17T07:00:00", "last", "2026-05-11"),   # Sunday "last week": ending today
    ("2026-05-14T07:00:00", "last", "2026-05-04"),   # Thursday "last week"
    ("2026-05-17T22:30:00", "this", "2026-05-11"),   # 01:30 Monday in Kyiv: still that week
])
def test_week_bounds(posted, ref, start):
    monday, sunday = week_bounds(_utc(posted), ref)
    assert monday.isoformat() == start
    assert (sunday - monday).days == 6
