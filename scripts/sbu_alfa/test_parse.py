#!/usr/bin/env python3
"""
test_parse.py — golden-value tests against the three known SBU Alpha articles.

Each fixture HTML in scripts/sbu_alfa/fixtures/ is parsed and compared against
the expected counter map. The expected values come from the source articles
themselves (verified against ssu.gov.ua for May, and mirrors for March/April).

Run: pytest scripts/sbu_alfa/test_parse.py -q
"""
from __future__ import annotations

from pathlib import Path

import pytest

from parse import extract_text, parse

FIXTURES = Path(__file__).resolve().parent / "fixtures"


def _parsed(name: str):
    html_str = (FIXTURES / f"{name}.html").read_text()
    return parse(extract_text(html_str))


def _by_cat(report) -> dict[str, tuple[int, str]]:
    return {c.category: (c.value, c.bound) for c in report.counters}


# Expected per the source articles. (value, bound)
MARCH_EXPECTED = {
    "enemy_kia":         (10_200, "at_least"),
    "targets_total":     (7_346,  "exact"),
    "targets_destroyed": (5_122,  "exact"),
    "targets_damaged":   (2_224,  "exact"),
    "drones":            (2_218,  "exact"),
    "comms":             (1_279,  "exact"),
    "fortifications":    (1_606,  "exact"),
    "vehicles_light":    (810,    "exact"),
    "vehicles_moto":     (422,    "exact"),
    "vehicles_trucks":   (187,    "exact"),
    "artillery":         (90,     "exact"),
    "armored_total":     (59,     "exact"),
    "mlrs":              (10,     "exact"),
}
APRIL_EXPECTED = {
    "enemy_kia":         (10_000, "at_least"),
    "targets_total":     (10_518, "exact"),
    "targets_destroyed": (7_649,  "exact"),
    "targets_damaged":   (2_869,  "exact"),
    "drones":            (4_204,  "exact"),
    "comms":             (1_427,  "exact"),
    "fortifications":    (1_556,  "exact"),
    "vehicles_light":    (1_138,  "exact"),
    "vehicles_moto":     (605,    "exact"),
    "vehicles_trucks":   (287,    "exact"),
    "artillery":         (97,     "exact"),
    "armored_total":     (69,     "exact"),
    "tanks":             (23,     "exact"),
    "ifvs":              (46,     "exact"),
    "air_defense":       (29,     "exact"),
    "radar":             (21,     "exact"),
    "mlrs":              (16,     "exact"),
    "aircraft":          (2,      "exact"),
}
MAY_EXPECTED = {
    "enemy_kia":            (8_000, "at_least"),
    "drones":               (5_535, "exact"),
    "vehicles_auto_total":  (2_807, "exact"),
    "comms":                (2_214, "exact"),
    "fortifications":       (1_781, "exact"),
    "depots":               (123,   "exact"),
    "artillery":            (101,   "exact"),
    "armored_total":        (62,    "exact"),
    "tanks":                (15,    "exact"),
    "ifvs":                 (47,    "exact"),
    "air_defense":          (35,    "exact"),
    "radar":                (23,    "exact"),
    "watercraft":           (22,    "exact"),
    "mlrs":                 (11,    "exact"),
}
# June 2026 uses varied phrasings the earlier months didn't (nominative
# case after 2/3/4 numerals, alternate long-form air-defense wording,
# "одиниць авіаційної техніки" instead of "літак") — the regexes are
# widened to cover both. It also introduces the "розрахунки БпЛА" (UAV-crew)
# category (now tracked as drone_crews).
JUNE_EXPECTED = {
    "enemy_kia":            (5_500, "at_least"),
    "drones":               (6_909, "exact"),
    "drone_crews":          (433,   "exact"),
    "vehicles_auto_total":  (2_402, "exact"),
    "comms":                (1_722, "exact"),
    "fortifications":       (1_395, "exact"),
    "depots":               (161,   "exact"),
    "artillery":            (78,    "exact"),
    "armored_total":        (33,    "exact"),
    "tanks":                (7,     "exact"),
    "ifvs":                 (26,    "exact"),
    "air_defense":          (14,    "exact"),
    "radar":                (34,    "exact"),
    "mlrs":                 (16,    "exact"),
    "aircraft":             (2,     "exact"),
    "watercraft":           (8,     "exact"),
}
# July 2026 exercises the three parser fixes: nominative "23 засоби ППО"
# (air_defense, was genitive-only), the "БК" abbreviation in "233 склади з БК"
# (depots), and "549 розрахунків БпЛА" (drone_crews).
JULY_EXPECTED = {
    "enemy_kia":            (6_000, "approx"),
    "drones":               (8_748, "exact"),
    "drone_crews":          (549,   "exact"),
    "vehicles_auto_total":  (3_297, "exact"),
    "comms":                (2_182, "exact"),
    "fortifications":       (1_207, "exact"),
    "depots":               (233,   "exact"),
    "artillery":            (54,    "exact"),
    "armored_total":        (67,    "exact"),
    "tanks":                (20,    "exact"),
    "ifvs":                 (47,    "exact"),
    "air_defense":          (23,    "exact"),
    "radar":                (22,    "exact"),
    "mlrs":                 (18,    "exact"),
    "aircraft":             (13,    "exact"),
    "watercraft":           (26,    "exact"),
}


_ALL = [
    ("march", MARCH_EXPECTED, "2026-03"),
    ("april", APRIL_EXPECTED, "2026-04"),
    ("may",   MAY_EXPECTED,   "2026-05"),
    ("june",  JUNE_EXPECTED,  "2026-06"),
    ("july",  JULY_EXPECTED,  "2026-07"),
]


@pytest.mark.parametrize("name, expected, period", _ALL)
def test_parse_counters(name, expected, period):
    report = _parsed(name)
    assert report.period == period, f"{name}: period {report.period} != {period}"
    assert report.report_type == "monthly_top1"
    got = _by_cat(report)
    for cat, (val, bound) in expected.items():
        assert cat in got, f"{name}: missing category {cat} (got {sorted(got)})"
        assert got[cat] == (val, bound), f"{name}: {cat} = {got[cat]} != {(val, bound)}"


def test_no_unexpected_categories():
    """If we silently start matching extra categories, surface that."""
    for name, expected, _ in _ALL:
        got = _by_cat(_parsed(name))
        extra = set(got) - set(expected)
        assert not extra, f"{name}: unexpected categories {extra}"


@pytest.mark.parametrize("name, expected, _period", _ALL)
def test_no_drift_on_known_fixtures(name, expected, _period):
    """Every counter line in the known articles is claimed by some category —
    so the drift detector stays silent. If SBU adds/renames a category, this is
    the safety net that turns a silent drop into a visible warning."""
    assert _parsed(name).unmatched == [], f"{name}: unexpected drift {_parsed(name).unmatched}"


def test_drift_detector_flags_a_missed_counter():
    """Remove drone_crews from the category table and confirm July's
    '549 розрахунків БпЛА' line surfaces as unmatched — while page chrome
    (dates, nav) outside the counter box does not."""
    import parse as _p
    saved = _p.CATEGORIES
    _p.CATEGORIES = [c for c in saved if c[0] != "drone_crews"]
    try:
        report = _parsed("july")
    finally:
        _p.CATEGORIES = saved
    assert any("розрахунк" in u for u in report.unmatched), report.unmatched
    # And nothing spurious from the surrounding page (only the one real miss).
    assert len(report.unmatched) == 1, report.unmatched
