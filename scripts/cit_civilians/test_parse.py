#!/usr/bin/env python3
"""
Golden-value tests for scripts/cit_civilians/parse.py.

    python3 -m pytest scripts/cit_civilians/test_parse.py -q

Fixtures under fixtures/ are verbatim post texts captured from the t.me/s
preview, chosen to cover every format era and every awkward construction the
archive contains — retractions, restatements, deaths of the previously
injured, multi-date corrections, weekend posts, the 2023 format with no
window, and one negative fixture that must not parse at all.

RECONCILIATION is the load-bearing assertion: each post states its own totals,
so a fixture that reconciles proves the region rows, the corrections and the
signs all agree with the source. Two fixtures deliberately do NOT reconcile —
see NON_RECONCILING — because CIT's own arithmetic differs from its own
breakdown there, and pretending otherwise would mean tuning the parser to
reproduce a source error.
"""
from __future__ import annotations

import pathlib
import sys
from datetime import datetime, timezone

import pytest

SCRIPT_DIR = pathlib.Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from parse import (  # noqa: E402
    BASIS_MULTI,
    BASIS_SPLIT,
    BASIS_WINDOW_MULTIDAY,
    KIND_ADJUSTMENT,
    KIND_AMENDMENT,
    KIND_DAILY,
    REASON_DIED_OF_WOUNDS,
    REASON_EXCLUDED,
    TYPE_DAILY,
    TYPE_WEEKEND,
    is_summary,
    parse,
)

FIXTURES = SCRIPT_DIR / "fixtures"


def _load(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def _parse(name: str):
    """Parse a fixture, taking posted_at from the filename where it has one."""
    stamp = name[:10]
    try:
        posted = datetime.fromisoformat(stamp).replace(tzinfo=timezone.utc)
    except ValueError:
        posted = datetime(2023, 10, 19, 20, 30, tzinfo=timezone.utc)
    return parse(_load(name), posted.replace(hour=20, minute=30))


ALL_SUMMARIES = [
    "2024-02-26-post2991.txt",
    "2024-08-26-post4584.txt",
    "2025-02-18-post5996.txt",
    "2025-09-01-post8027.txt",
    "2026-05-05-post10889.txt",
    "2026-07-09-post11884.txt",
    "2026-08-18-post12526.txt",
    "2026-08-31-post12729.txt",
    "2026-09-06-post12829-weekend.txt",
    "2026-09-07-post12844.txt",
    "2026-09-08-post12864.txt",
    "2026-09-09-post12886.txt",
    "nowindow-post2112.txt",
]

# Fixtures whose region rows genuinely cannot equal the post's own total.
# Each was hand-checked clause by clause; the parse is right and the source
# total is not. Keeping them here, with the arithmetic, stops a future "fix"
# from bending the parser to match a typo.
NON_RECONCILING = {
    # Every region line verified: 3+20+5+9+21+29+41+10+37+3+7+2+6+31 = 224
    # daily + 5 amendments = 229 injured. The post says 230.
    "2026-05-05-post10889.txt": "CIT's own total is one higher than its breakdown",
    # Weekend post; breakdown totals 159 injured against a stated 171.
    "2026-09-06-post12829-weekend.txt": "48-hour post, breakdown short of the stated total",
    # Breakdown totals 83 injured against a stated 84.
    "2024-08-26-post4584.txt": "CIT's own total is one higher than its breakdown",
}


@pytest.mark.parametrize("name", ALL_SUMMARIES)
def test_recognised_as_a_summary(name: str) -> None:
    report = _parse(name)
    assert report.report_type in (TYPE_DAILY, TYPE_WEEKEND)
    assert report.report_date is not None
    assert is_summary(_load(name))


@pytest.mark.parametrize("name", ALL_SUMMARIES)
def test_no_unmatched_paragraphs(name: str) -> None:
    """Every paragraph is either a region line, a correction, or boilerplate.

    An unmatched paragraph is a silently dropped region, which is the failure
    mode this dataset can least afford.
    """
    assert _parse(name).unmatched == []


@pytest.mark.parametrize("name", [n for n in ALL_SUMMARIES if n not in NON_RECONCILING])
def test_reconciles_with_the_posts_own_total(name: str) -> None:
    report = _parse(name)
    if report.reconciled is None:
        pytest.skip("2023-era post with no closing total line")
    assert (report.sum_killed, report.sum_injured) == \
           (report.stated_killed, report.stated_injured)


@pytest.mark.parametrize("name,reason", sorted(NON_RECONCILING.items()))
def test_known_non_reconciling_are_still_flagged(name: str, reason: str) -> None:
    """They must be recorded as not reconciling, not quietly accepted."""
    assert _parse(name).reconciled is False, reason


def test_negative_fixture_is_not_a_summary() -> None:
    text = _load("negative-post12830-updates.txt")
    assert not is_summary(text)
    assert parse(text, datetime(2026, 9, 6, tzinfo=timezone.utc)).report_type == "unknown"


# --- window and date handling ----------------------------------------------

def test_window_is_msk_and_the_end_date_wins() -> None:
    """20:00→20:00 MSK puts 20 of 24 hours on the end date, so that's the day."""
    report = _parse("2026-09-08-post12864.txt")
    assert report.window_start == "2026-09-07T17:00:00+00:00"   # 20:00 MSK
    assert report.window_end == "2026-09-08T17:00:00+00:00"
    assert report.report_date == "2026-09-08"
    assert report.window_days == 1


def test_weekend_post_spans_two_days() -> None:
    report = _parse("2026-09-06-post12829-weekend.txt")
    assert report.report_type == TYPE_WEEKEND
    assert report.window_days == 2
    assert report.date_basis == BASIS_WINDOW_MULTIDAY
    assert all(r.date_basis == BASIS_WINDOW_MULTIDAY
               for r in report.rows if r.kind == KIND_DAILY)


def test_2023_era_post_has_no_window() -> None:
    report = _parse("nowindow-post2112.txt")
    assert report.window_start is None
    assert report.stated_killed is None          # no "Таким образом" line yet
    assert report.reconciled is None
    assert report.rows and report.report_date == "2023-10-19"
    assert any("no 20:00–20:00 window" in w for w in report.warnings)


# --- the three row kinds ---------------------------------------------------

def test_occupied_and_government_held_parts_stay_separate() -> None:
    report = _parse("2026-09-08-post12864.txt")
    donetsk = {r.occupied: r for r in report.rows
               if r.region_key == "donetsk" and r.kind == KIND_DAILY}
    assert set(donetsk) == {0, 1}
    assert donetsk[0].killed == 0 and donetsk[0].injured == 5
    assert donetsk[1].killed == 3 and donetsk[1].injured == 20
    assert all(r.country == "UA" for r in donetsk.values())


def test_retraction_is_negative_and_outside_the_checksum() -> None:
    """"из подсчёта были исключены два ребёнка" — and CIT's own total keeps them."""
    report = _parse("2026-08-31-post12729.txt")
    retractions = [r for r in report.rows if r.reason == REASON_EXCLUDED]
    assert len(retractions) == 1
    assert retractions[0].kind == KIND_ADJUSTMENT
    assert (retractions[0].killed, retractions[0].injured) == (0, -2)
    assert retractions[0].event_date == "2026-08-28"
    # The post still reconciles, which is the proof that CIT excludes it.
    assert report.reconciled is True


def test_death_of_a_previously_injured_person_adds_a_kill_and_removes_an_injury() -> None:
    report = _parse("2026-07-09-post11884.txt")
    pair = [r for r in report.rows if r.event_date == "2026-07-01"]
    amendment = [r for r in pair if r.kind == KIND_AMENDMENT]
    adjustment = [r for r in pair if r.reason == REASON_DIED_OF_WOUNDS]
    assert len(amendment) == 1 and len(adjustment) == 1
    # CIT counts the death and does NOT decrement the injured; we do, outside
    # the checksum, so a revised view can't count one person twice.
    assert (amendment[0].killed, amendment[0].injured) == (1, 0)
    assert (adjustment[0].killed, adjustment[0].injured) == (0, -1)
    assert report.reconciled is True


def test_corrections_land_on_their_own_earlier_dates() -> None:
    report = _parse("2026-09-08-post12864.txt")
    amendments = [r for r in report.rows if r.kind == KIND_AMENDMENT]
    assert len(amendments) == 3
    assert {r.region_key for r in amendments} == {"kharkiv", "zaporizhzhia", "kherson"}
    assert all(r.event_date == "2026-09-07" for r in amendments)
    assert all(r.injured == 1 and r.killed == 0 for r in amendments)


def test_evenly_divisible_multi_date_correction_is_split_one_per_day() -> None:
    """"ещё трёх пострадавших … 5, 7 и 8 сентября" — three people, three days."""
    report = _parse("2026-09-09-post12886.txt")
    split = [r for r in report.rows if r.date_basis == BASIS_SPLIT]
    assert [r.event_date for r in split] == ["2026-09-05", "2026-09-07", "2026-09-08"]
    assert all(r.injured == 1 for r in split)


def test_indivisible_multi_date_correction_keeps_the_list_and_no_single_date() -> None:
    """"ещё семи пострадавших … за 26, 28 и 30 августа" — 7 people, 3 days.

    It does not divide, so inventing a per-day split would be fabrication. The
    row keeps the whole date list and no single `event_date`, which is what
    puts it in the `corrections_unattributed` view rather than on a chart.
    """
    report = _parse("2026-08-31-post12729.txt")
    multi = [r for r in report.rows if r.date_basis == BASIS_MULTI]
    assert len(multi) == 2
    kherson = [r for r in multi if r.region_key == "kherson"][0]
    assert kherson.injured == 7
    assert kherson.event_date is None
    assert kherson.event_dates == "2026-08-26,2026-08-28,2026-08-30"
    # …and it still counts toward the post's own total, which reconciles.
    assert report.reconciled is True
