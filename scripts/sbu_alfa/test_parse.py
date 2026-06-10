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


@pytest.mark.parametrize("name, expected, period", [
    ("march", MARCH_EXPECTED, "2026-03"),
    ("april", APRIL_EXPECTED, "2026-04"),
    ("may",   MAY_EXPECTED,   "2026-05"),
])
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
    for name, expected in [("march", MARCH_EXPECTED), ("april", APRIL_EXPECTED), ("may", MAY_EXPECTED)]:
        got = _by_cat(_parsed(name))
        extra = set(got) - set(expected)
        assert not extra, f"{name}: unexpected categories {extra}"
