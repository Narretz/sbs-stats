#!/usr/bin/env python3
"""
Golden-value tests for scripts/rubikon/parse.py.

    python3 -m pytest scripts/rubikon/test_parse.py -q

Fixtures under fixtures/ are the verbatim post texts of every «Рубикон» monthly
recap published so far (2026-01 … 2026-08), captured from the t.me/s preview,
plus one negative fixture. When a new month publishes with previously-unseen
wording, add its fixture and a stanza to GOLDEN.
"""
from __future__ import annotations

import pathlib
import sys

import pytest

SCRIPT_DIR = pathlib.Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from parse import (  # noqa: E402
    CATEGORY_EW,
    CATEGORY_ORDER,
    CATEGORY_SORTIES,
    KIND_ENGAGED,
    KIND_EW,
    KIND_SORTIES,
    parse,
)

FIXTURES = SCRIPT_DIR / "fixtures"


def _load(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


# (fixture, expected period, {category: value}) — transcribed from the posts.
# Sparse categories are genuinely absent from the months that omit them:
# `atgm` only in Feb, `sam`/`aa_guns` only in Mar, `fixed_wing_uav` only in
# Feb/Mar, `command_posts` only in Jan/Mar, `fire_weapons` in every month
# except Mar.
GOLDEN: list[tuple[str, str, dict[str, int]]] = [
    ("2026-01-post1016.txt", "2026-01", {"combat_sorties": 48547, "personnel": 1308, "tanks": 20, "afv_ifv": 146, "apc": 36, "spg": 33, "towed_artillery": 35, "mlrs": 3, "mortars": 13, "fire_weapons": 1, "radar_ew": 170, "comms": 1405, "uav_control_points": 153, "command_posts": 1, "deployment_points": 365, "engineering_structures": 1082, "fortifications": 1056, "depots": 52, "life_support": 168, "engineering_vehicles": 16, "motorcycles": 91, "vehicles": 699, "decoys": 18, "uav": 463, "baba_yaga": 749, "ugv": 387, "uav_ew_suppressed": 3597}),
    ("2026-02-post1140.txt", "2026-02", {"combat_sorties": 43356, "personnel": 1297, "tanks": 11, "afv_ifv": 202, "apc": 35, "spg": 39, "towed_artillery": 41, "mlrs": 6, "mortars": 6, "atgm": 1, "fire_weapons": 3, "radar_ew": 147, "comms": 1209, "uav_control_points": 112, "deployment_points": 600, "engineering_structures": 1203, "fortifications": 1140, "depots": 51, "life_support": 167, "engineering_vehicles": 19, "motorcycles": 60, "vehicles": 667, "decoys": 22, "uav": 895, "baba_yaga": 695, "fixed_wing_uav": 105, "ugv": 388, "uav_ew_suppressed": 2137}),
    ("2026-03-post1311.txt", "2026-03", {"combat_sorties": 78499, "personnel": 1798, "tanks": 20, "afv_ifv": 290, "apc": 51, "spg": 35, "towed_artillery": 54, "mlrs": 5, "mortars": 10, "sam": 1, "aa_guns": 3, "radar_ew": 172, "comms": 1953, "uav_control_points": 221, "command_posts": 1, "deployment_points": 1548, "engineering_structures": 1479, "fortifications": 1391, "depots": 49, "life_support": 287, "engineering_vehicles": 20, "motorcycles": 98, "vehicles": 1059, "decoys": 26, "uav": 1457, "baba_yaga": 1657, "fixed_wing_uav": 464, "ugv": 693, "uav_ew_suppressed": 4504}),
    ("2026-04-post1477.txt", "2026-04", {"combat_sorties": 79906, "personnel": 1061, "tanks": 9, "afv_ifv": 199, "apc": 40, "spg": 30, "towed_artillery": 33, "mlrs": 2, "mortars": 3, "fire_weapons": 1, "radar_ew": 135, "comms": 1445, "uav_control_points": 193, "deployment_points": 1352, "engineering_structures": 1889, "fortifications": 976, "depots": 42, "life_support": 180, "engineering_vehicles": 32, "motorcycles": 83, "vehicles": 683, "decoys": 20, "uav": 1370, "baba_yaga": 1751, "ugv": 535, "uav_ew_suppressed": 5562}),
    ("2026-05-post1730.txt", "2026-05", {"combat_sorties": 108545, "personnel": 838, "tanks": 8, "afv_ifv": 178, "apc": 25, "spg": 39, "towed_artillery": 44, "mlrs": 4, "mortars": 6, "fire_weapons": 4, "radar_ew": 181, "comms": 1702, "uav_control_points": 388, "deployment_points": 1790, "engineering_structures": 1649, "fortifications": 1088, "depots": 61, "life_support": 212, "engineering_vehicles": 39, "motorcycles": 140, "vehicles": 907, "decoys": 20, "uav": 2177, "baba_yaga": 2281, "ugv": 864, "uav_ew_suppressed": 6454}),
    ("2026-06-post2007.txt", "2026-06", {"combat_sorties": 109166, "personnel": 807, "tanks": 13, "afv_ifv": 191, "apc": 12, "spg": 30, "towed_artillery": 51, "mlrs": 5, "mortars": 2, "fire_weapons": 7, "radar_ew": 210, "comms": 1598, "uav_control_points": 410, "deployment_points": 1981, "engineering_structures": 1742, "fortifications": 1142, "depots": 81, "life_support": 269, "engineering_vehicles": 30, "motorcycles": 128, "vehicles": 794, "decoys": 10, "uav": 2520, "baba_yaga": 2116, "ugv": 882, "uav_ew_suppressed": 4994}),
    ("2026-07-post2284.txt", "2026-07", {"combat_sorties": 124435, "personnel": 571, "tanks": 5, "afv_ifv": 158, "apc": 11, "spg": 30, "towed_artillery": 39, "mlrs": 2, "mortars": 2, "fire_weapons": 51, "radar_ew": 188, "comms": 1577, "uav_control_points": 298, "deployment_points": 2244, "engineering_structures": 1464, "fortifications": 1221, "depots": 119, "life_support": 319, "engineering_vehicles": 26, "motorcycles": 110, "vehicles": 767, "decoys": 9, "uav": 3086, "baba_yaga": 1926, "ugv": 937, "uav_ew_suppressed": 6976}),
    ("2026-08-post2550.txt", "2026-08", {"combat_sorties": 124720, "personnel": 538, "tanks": 5, "afv_ifv": 144, "apc": 9, "spg": 25, "towed_artillery": 33, "mlrs": 3, "mortars": 4, "fire_weapons": 4, "radar_ew": 220, "comms": 2030, "uav_control_points": 401, "deployment_points": 1889, "engineering_structures": 1458, "fortifications": 1473, "depots": 136, "life_support": 370, "engineering_vehicles": 32, "motorcycles": 93, "vehicles": 872, "decoys": 11, "uav": 3991, "baba_yaga": 2708, "ugv": 1036, "uav_ew_suppressed": 5672}),
]


@pytest.mark.parametrize("fixture,period,expected", GOLDEN, ids=[g[1] for g in GOLDEN])
def test_golden_values(fixture: str, period: str, expected: dict[str, int]) -> None:
    report = parse(_load(fixture))
    assert report.report_type == "monthly"
    assert report.period == period
    assert report.period_start == f"{period}-01"
    assert {c.category: c.value for c in report.counters} == expected


@pytest.mark.parametrize("fixture", [g[0] for g in GOLDEN], ids=[g[1] for g in GOLDEN])
def test_no_unmatched_lines(fixture: str) -> None:
    """Every "Label - N" line in the recap must map to a category.

    This is the drift detector: a renamed or brand-new counter shows up here
    (and as a WARNING in the ingest log) instead of silently vanishing.
    """
    assert parse(_load(fixture)).unmatched == []


@pytest.mark.parametrize("fixture", [g[0] for g in GOLDEN], ids=[g[1] for g in GOLDEN])
def test_counter_kinds(fixture: str) -> None:
    """Exactly one sorties counter, exactly one EW counter, rest are 'engaged'.

    The EW number ("подавлено N вражеских дронов") is drones jammed, not
    targets struck — it must never be filed under the "Поражены" list.
    """
    counters = parse(_load(fixture)).counters
    by_kind: dict[str, list[str]] = {}
    for c in counters:
        by_kind.setdefault(c.kind, []).append(c.category)
    assert by_kind[KIND_SORTIES] == [CATEGORY_SORTIES]
    assert by_kind[KIND_EW] == [CATEGORY_EW]
    assert CATEGORY_SORTIES not in by_kind[KIND_ENGAGED]
    assert CATEGORY_EW not in by_kind[KIND_ENGAGED]


@pytest.mark.parametrize("fixture", [g[0] for g in GOLDEN], ids=[g[1] for g in GOLDEN])
def test_counters_are_ordered_and_unique(fixture: str) -> None:
    """Counters come out in CATEGORY_ORDER, one row per category.

    Uniqueness matters beyond tidiness: the DB's primary key is
    (post_id, scraped_at, category), so a duplicate would fail the insert.
    """
    cats = [c.category for c in parse(_load(fixture)).counters]
    assert len(cats) == len(set(cats))
    assert cats == sorted(cats, key=CATEGORY_ORDER.index)


def test_unknown_category_is_flagged_not_dropped() -> None:
    """A category the channel has never used must surface in `unmatched`.

    This is the drift detector doing its job — the sibling
    test_no_unmatched_lines only proves it stays quiet on known wording, which
    a detector that never fires would also pass. The recap is a strict
    one-counter-per-line list, so every line is either claimed or flagged;
    there is no heuristic to fall through.

    The post is still parsed and stored, minus that counter — the raw text is
    kept, so adding an alias and re-running `ingest.py --reparse` recovers the
    value without a re-scrape.
    """
    text = _load("2026-08-post2550.txt").replace(
        "Танки - 5", "Танки - 5\nГаубицы М777 - 7\nКорабли - 2"
    )
    report = parse(text)
    assert report.report_type == "monthly"      # the month is not lost
    assert report.unmatched == ["Гаубицы М777 - 7", "Корабли - 2"]
    # …and the unknown lines did not sneak in under some other category.
    assert 7 not in [c.value for c in report.counters if c.category != "towed_artillery"]
    assert all(c.category in CATEGORY_ORDER for c in report.counters)


def test_non_recap_post_is_rejected() -> None:
    """The 30 Dec 2025 cumulative report must NOT enter the monthly series.

    It shares the recap's headline and even its "Поражены:" list, but covers
    14 Apr – 30 Dec 2025 on one axis of advance. Folding that into a monthly
    chart would add a ~9-month total as if it were one month.
    """
    report = parse(_load("non-recap-post899.txt"))
    assert report.report_type == "unknown"
    assert report.period is None
    assert report.counters == []


def test_partial_month_is_rejected() -> None:
    """A recap that stops short of the month's last day isn't a full month."""
    text = _load("2026-08-post2550.txt").replace("с 1 по 31 августа", "с 1 по 20 августа")
    assert parse(text).report_type == "unknown"


def test_hyphenated_label_is_not_split() -> None:
    """"Баба-Яга - 2 708" splits on the spaced dash, not the name's hyphen."""
    report = parse(_load("2026-08-post2550.txt"))
    baba = next(c for c in report.counters if c.category == "baba_yaga")
    assert baba.raw_label == "Баба-Яга"
    assert baba.value == 2708


def test_thousands_separators() -> None:
    """Grouped ("124 720") and ungrouped ("1209") numbers both parse."""
    aug = {c.category: c.value for c in parse(_load("2026-08-post2550.txt")).counters}
    feb = {c.category: c.value for c in parse(_load("2026-02-post1140.txt")).counters}
    assert aug["combat_sorties"] == 124720   # "124 720"
    assert feb["comms"] == 1209              # "1209", no separator
