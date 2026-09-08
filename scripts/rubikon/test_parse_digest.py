#!/usr/bin/env python3
"""
Golden-value tests for scripts/rubikon/parse_digest.py — the «Итоги <месяца>»
published-episode series.

    python3 -m pytest scripts/rubikon/test_parse_digest.py -q

Fixtures under fixtures/digest-*.txt are the verbatim post texts, captured from
the t.me/s preview; non-digest-*.txt are negatives that must be rejected.
"""
from __future__ import annotations

import pathlib
import sys
from datetime import date

import pytest

SCRIPT_DIR = pathlib.Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from parse import parse as parse_recap  # noqa: E402
from parse_digest import (  # noqa: E402
    CATEGORY_ORDER,
    CATEGORY_TOTAL,
    KIND_EPISODE,
    KIND_TOTAL,
    parse,
)

FIXTURES = SCRIPT_DIR / "fixtures"


def _load(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


# (fixture, posted_at, period, headline, bound, {category: value})
# An empty dict = headline only: those months' posts carry no per-category
# breakdown at all (2026-04 onwards it was dropped; 2025-07/08 predate it).
GOLDEN: list[tuple[str, date, str, int, str, dict[str, int]]] = [
    ("digest-2025-07-post368.txt", date(2025, 8, 2), "2025-07", 1500, "at_least", {}),
    # 481's bulleted list is a THREE-MONTH Jun+Jul+Aug aggregate, so August
    # must come out headline-only. See _STRUCTURE_HEADER_RE.
    ("digest-2025-08-post481.txt", date(2025, 8, 31), "2025-08", 1750, "at_least", {}),
    ("digest-2025-09-post579.txt", date(2025, 9, 30), "2025-09", 1877, "exact", {
        "uav": 836, "ugv": 60, "radar_comms": 373, "personnel": 29, "vehicles": 187,
        "positions": 204, "towed_artillery": 12, "spg": 14, "armour": 133, "tanks": 7,
        "other": 22}),
    ("digest-2025-10-post682.txt", date(2025, 10, 31), "2025-10", 2063, "exact", {
        "uav": 721, "ugv": 130, "radar_comms": 382, "personnel": 107, "vehicles": 220,
        "positions": 327, "towed_artillery": 25, "spg": 26, "armour": 95, "tanks": 17,
        "other": 13}),
    ("digest-2025-11-post787.txt", date(2025, 11, 30), "2025-11", 2245, "exact", {
        "uav": 664, "ugv": 87, "radar_comms": 342, "personnel": 274, "vehicles": 231,
        "positions": 435, "artillery": 44, "armour": 140, "tanks": 15, "other": 13}),
    ("digest-2026-01-post1014.txt", date(2026, 2, 1), "2026-01", 2152, "exact", {
        "uav": 438, "ugv": 127, "radar_comms": 385, "personnel": 166, "vehicles": 374,
        "positions": 433, "artillery": 51, "armour": 110, "tanks": 19, "other": 49}),
    ("digest-2026-02-post1131.txt", date(2026, 2, 28), "2026-02", 1857, "exact", {
        "uav": 525, "ugv": 131, "radar_comms": 312, "personnel": 208, "vehicles": 230,
        "positions": 312, "artillery": 53, "armour": 70, "tanks": 7, "other": 9}),
    ("digest-2026-03-post1289.txt", date(2026, 3, 31), "2026-03", 3170, "exact", {
        "uav": 1160, "ugv": 203, "radar_comms": 603, "personnel": 219, "vehicles": 270,
        "positions": 433, "artillery": 67, "armour": 158, "tanks": 13, "vks_joint": 37,
        "other": 7}),
    ("digest-2026-04-post1459.txt", date(2026, 4, 30), "2026-04", 3568, "exact", {}),
    ("digest-2026-05-post1700.txt", date(2026, 5, 31), "2026-05", 4646, "exact", {}),
    ("digest-2026-06-post1986.txt", date(2026, 7, 1), "2026-06", 5232, "exact", {}),
    ("digest-2026-07-post2260.txt", date(2026, 7, 31), "2026-07", 4900, "exact", {}),
    ("digest-2026-08-post2521.txt", date(2026, 8, 31), "2026-08", 4700, "at_least", {}),
]

IDS = [g[2] for g in GOLDEN]


@pytest.mark.parametrize("fixture,posted,period,total,bound,cats", GOLDEN, ids=IDS)
def test_golden_values(fixture, posted, period, total, bound, cats) -> None:
    r = parse(_load(fixture), posted)
    assert r.report_type == "monthly_digest"
    assert r.period == period
    headline = [c for c in r.counters if c.kind == KIND_TOTAL]
    assert len(headline) == 1
    assert headline[0].category == CATEGORY_TOTAL
    assert (headline[0].value, headline[0].bound) == (total, bound)
    assert {c.category: c.value for c in r.counters if c.kind == KIND_EPISODE} == cats


@pytest.mark.parametrize("fixture", [g[0] for g in GOLDEN], ids=IDS)
def test_no_unmatched_bullets(fixture) -> None:
    """Drift detector: every "• Label - N" line must map to a category."""
    posted = next(g[1] for g in GOLDEN if g[0] == fixture)
    assert parse(_load(fixture), posted).unmatched == []


@pytest.mark.parametrize("fixture", [g[0] for g in GOLDEN], ids=IDS)
def test_ordered_and_unique(fixture) -> None:
    """One row per category, emitted in CATEGORY_ORDER.

    Uniqueness is load-bearing: the DB primary key is
    (post_id, scraped_at, category).
    """
    posted = next(g[1] for g in GOLDEN if g[0] == fixture)
    cats = [c.category for c in parse(_load(fixture), posted).counters]
    assert len(cats) == len(set(cats))
    assert cats == sorted(cats, key=CATEGORY_ORDER.index)


@pytest.mark.parametrize(
    "fixture,posted,total",
    [(g[0], g[1], g[3]) for g in GOLDEN if g[5]],
    ids=[g[2] for g in GOLDEN if g[5]],
)
def test_breakdown_sums_to_headline(fixture, posted, total) -> None:
    """Every published breakdown sums EXACTLY to its own headline (6 for 6).

    The parser reports a mismatch as a warning; this asserts the invariant
    actually holds for the fixtures, so a regression that drops or duplicates
    a bullet fails loudly here rather than only in the ingest log.
    """
    r = parse(_load(fixture), posted)
    assert sum(c.value for c in r.counters if c.kind == KIND_EPISODE) == total
    assert r.warnings == []


def test_unknown_bullet_is_flagged_not_dropped() -> None:
    """An unrecognised bullet surfaces in `unmatched` rather than vanishing."""
    text = _load("digest-2026-03-post1289.txt").replace(
        "• Танки - 13", "• Танки - 13\n• Морские дроны - 9"
    )
    r = parse(text, date(2026, 3, 31))
    assert r.report_type == "monthly_digest"
    assert r.unmatched == ["• Морские дроны - 9 (+85%)"]


def test_new_category_also_trips_the_sum_check() -> None:
    """A REAL new category trips two independent detectors, not one.

    The unit counts it in the headline as well as listing it, so the matched
    bullets no longer add up — which is caught even if the alias table somehow
    swallowed the line. Two signals for the same drift is the point: the sum
    check needs no vocabulary at all.
    """
    text = (
        _load("digest-2026-03-post1289.txt")
        .replace("составило 3170", "составило 3179")
        .replace("• Танки - 13", "• Танки - 13\n• Морские дроны - 9")
    )
    r = parse(text, date(2026, 3, 31))
    assert r.unmatched == ["• Морские дроны - 9 (+85%)"]
    assert any("breakdown sums to 3170" in w and "3179" in w for w in r.warnings)


def test_summer_aggregate_bullets_are_not_august() -> None:
    """Post 481's bullets cover Jun+Jul+Aug 2025 — they are not August's.

    The list has no "Структура основных типов пораженных целей" header, which
    is the gate. Without it, 425 ББМ (a quarter's worth) would land on August,
    where the real monthly figure is an order of magnitude smaller.
    """
    r = parse(_load("digest-2025-08-post481.txt"), date(2025, 8, 31))
    assert r.period == "2025-08"
    assert [c.category for c in r.counters] == [CATEGORY_TOTAL]


def test_july_2026_title_beats_body_typo() -> None:
    """Post 2260 is titled «Итоги июля 2026» but its body says "в июне 2026".

    June was already reported as 5232 by post 1986; trusting the body would
    overwrite June with July's 4900 and lose July entirely. Title wins, and
    the discrepancy is surfaced as a warning.
    """
    r = parse(_load("digest-2026-07-post2260.txt"), date(2026, 7, 31))
    assert r.period == "2026-07"
    assert any("title says month 7" in w for w in r.warnings)


def test_annual_summary_is_rejected() -> None:
    """«Итоги 2025» is a full-year total — it must not land on a monthly axis."""
    r = parse(_load("non-digest-annual-post903.txt"), date(2025, 12, 31))
    assert r.report_type == "unknown"
    assert r.period is None


def test_milestone_post_is_rejected() -> None:
    """The cumulative "10 000 пораженных целей" post is percentages, not a month."""
    r = parse(_load("non-digest-milestone-post665.txt"), date(2025, 10, 27))
    assert r.report_type == "unknown"


@pytest.mark.parametrize("fixture", [g[0] for g in GOLDEN], ids=IDS)
def test_digest_posts_are_not_recaps(fixture) -> None:
    """The two series' gates are disjoint — no post satisfies both parsers."""
    assert parse_recap(_load(fixture)).report_type == "unknown"


@pytest.mark.parametrize(
    "fixture", ["2026-01-post1016.txt", "2026-08-post2550.txt"],
)
def test_recap_posts_are_not_digests(fixture) -> None:
    """…and the reverse: a GS recap must not be read as a digest."""
    assert parse(_load(fixture), date(2026, 9, 3)).report_type == "unknown"
