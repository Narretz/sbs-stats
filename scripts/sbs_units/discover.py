#!/usr/bin/env python3
"""
discover.py
-----------
Turns the sbs-group.army `/subdivisions` and `/periods` endpoints into the two
things `ingest.py` needs: a registry of units, and a map from (unit, grain,
bucket) to the period id that serves it.

Why this is its own module: addressing a statistic on this API means naming a
(subdivisionId, periodId) pair, and neither half is derivable. The period ids
are opaque, they are NOT stable names for a calendar bucket (see the slot-reuse
note below), and the list of subdivisions changes as units form and retire. So
every run rediscovers both, and everything downstream works from names it read
this run rather than ids anyone wrote down.

Run directly to print what it found:

    python3 scripts/sbs_units/discover.py
    python3 scripts/sbs_units/discover.py --json
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
# `scripts/` isn't a package, so the parent goes on sys.path for the shared
# helpers. `fetch_and_update` owns the HTTP retry loop, the Kyiv month
# conversion and the payload guards; duplicating any of them here would mean
# two behaviours to keep in step.
if str(SCRIPT_DIR.parent) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR.parent))

from fetch_and_update import (  # noqa: E402
    BASE_PUBLIC_URL,
    _is_month_period,
    _period_month,
    fetch_json,
)
from ingest_log import ann, get_logger  # noqa: E402

log = get_logger("sbs-units")

# Same `?limit=500` reasoning as the USF ingest: the endpoint paginates at 50
# and serves every subdivision's periods together, so the default page holds
# barely a fifth of them. Here it matters far more — the USF ingest only needed
# one subdivision's worth and got it by luck of ordering; this one needs them
# all by definition.
SUBDIVISIONS_URL = f"{BASE_PUBLIC_URL}/subdivisions?limit=500"
PERIODS_URL = f"{BASE_PUBLIC_URL}/periods?limit=500"

# The grouping-level subdivision. It is the sum of (most of) the others and is
# already tracked in its own right by `scripts/fetch_and_update.py` -> sbs.db,
# so this ingest skips it rather than storing a second, differently-versioned
# copy of the same numbers.
GROUPING_SUBDIVISION_ID = "68b0c85589944c4bfb2a5edc"


@dataclass
class Unit:
    """One subdivision, with what the periods say about its lifespan."""
    slug: str
    subdivision_id: str
    division_id: str | None
    title_uk: str | None
    title_en: str | None
    color: str | None
    display_order: int | None
    # A unit is "active" when it still has a live daily period. That is the
    # only signal the API gives for retirement — nothing is flagged, the
    # periods simply stop being issued. Deriving it means a unit that retires
    # next month is handled without anyone editing a list.
    active: bool = False
    months: list[str] = field(default_factory=list)      # "YYYY-MM", ascending
    years: list[str] = field(default_factory=list)       # "YYYY", ascending

    @property
    def first_month(self) -> str | None:
        return self.months[0] if self.months else None

    @property
    def last_month(self) -> str | None:
        return self.months[-1] if self.months else None


def slugify(title: str) -> str:
    """A URL-safe name for a unit, derived from its English title.

    Derived rather than hand-maintained, but the ingest stores it alongside the
    subdivision id and warns when an existing id's slug changes — so a renamed
    unit surfaces as a finding instead of silently becoming a second unit with
    an empty history.
    """
    s = title.strip().lower()
    s = s.replace("'", "").replace("’", "").replace("ʼ", "")
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return s.strip("-") or "unit"


def _warn_if_truncated(data: dict, what: str) -> None:
    pagination = data.get("pagination") or {}
    pages = pagination.get("pages")
    if isinstance(pages, int) and pages > 1:
        log.warning(
            f"{what} returned page {pagination.get('current')} of {pages} "
            f"(total {pagination.get('total')}). Raise the limit or paginate — "
            "a short page looks exactly like a unit or a month not existing.",
            extra=ann(title="sbs-units: listing truncated"),
        )


def _is_year_period(period: dict) -> bool:
    """True when a period spans exactly one calendar year.

    Deliberately looser than `_is_month_period`: several of these are labelled
    with a partial span ("2025 (11.06 - 31.12)") because the unit did not exist
    for the whole year, yet still carry Jan 1 -> Dec 31 as their dates. The
    bucket is the year either way; what it actually covers is the unit's own
    lifespan, which is why the stored rows are not comparable across units.
    """
    start_s, end_s = period.get("startDate"), period.get("endDate")
    if not start_s or not end_s:
        return False
    try:
        start = datetime.fromisoformat(start_s.replace("Z", "+00:00"))
        end = datetime.fromisoformat(end_s.replace("Z", "+00:00"))
    except ValueError:
        return False
    return (start.month, start.day) == (1, 1) and (end.month, end.day) == (12, 31) \
        and start.year == end.year


@dataclass
class Discovery:
    units: list[Unit]
    # (subdivision_id, "YYYY-MM") -> period id
    monthly: dict[tuple[str, str], str]
    # (subdivision_id, "YYYY") -> period id
    yearly: dict[tuple[str, str], str]
    # subdivision_id -> {"daily": id, "prev_day": id}
    intraday: dict[str, dict[str, str]]

    def stats_url(self, subdivision_id: str, period_id: str) -> str:
        return f"{BASE_PUBLIC_URL}/statistics/{subdivision_id}/{period_id}"


def discover(
    subdivisions_raw: dict | None = None,
    periods_raw: dict | None = None,
) -> Discovery:
    """Build the registry. Arguments are for tests; production fetches."""
    subdivisions_raw = subdivisions_raw or fetch_json(SUBDIVISIONS_URL)
    periods_raw = periods_raw or fetch_json(PERIODS_URL)

    sub_data = subdivisions_raw.get("data", {})
    per_data = periods_raw.get("data", {})
    _warn_if_truncated(sub_data, "/subdivisions")
    _warn_if_truncated(per_data, "/periods")

    units: dict[str, Unit] = {}
    for s in sub_data.get("subdivisions", []):
        sid = s.get("_id")
        if not sid or sid == GROUPING_SUBDIVISION_ID:
            continue
        title_en = s.get("title_en") or s.get("title") or sid
        units[sid] = Unit(
            slug=slugify(title_en),
            subdivision_id=sid,
            division_id=s.get("division_id"),
            title_uk=s.get("title"),
            title_en=s.get("title_en"),
            color=s.get("color"),
            display_order=s.get("displayOrder"),
        )

    monthly: dict[tuple[str, str], str] = {}
    yearly: dict[tuple[str, str], str] = {}
    intraday: dict[str, dict[str, str]] = {}

    for p in per_data.get("periods", []):
        sid = (p.get("subdivision") or {}).get("_id")
        pid = p.get("_id")
        if not sid or not pid or sid not in units:
            continue
        kind = p.get("periodType") or ""
        if kind in ("daily", "prev_day"):
            intraday.setdefault(sid, {})[kind] = pid
            continue
        start_s = p.get("startDate")
        if not start_s:
            continue
        # Order matters: a monthly period also starts on the 1st, so the
        # narrower test has to run first.
        if _is_month_period(p):
            monthly[(sid, _period_month(start_s))] = pid
        elif _is_year_period(p):
            yearly[(sid, _period_month(start_s)[:4])] = pid

    for sid, unit in units.items():
        unit.active = "daily" in intraday.get(sid, {})
        unit.months = sorted(m for (s, m) in monthly if s == sid)
        unit.years = sorted(y for (s, y) in yearly if s == sid)

    ordered = sorted(
        units.values(),
        key=lambda u: (u.display_order if u.display_order is not None else 999, u.slug),
    )
    return Discovery(units=ordered, monthly=monthly, yearly=yearly, intraday=intraday)


def main() -> None:
    parser = argparse.ArgumentParser(description="Show what the SBS API exposes per unit")
    parser.add_argument("--json", action="store_true", help="machine-readable output")
    args = parser.parse_args()

    d = discover()
    if args.json:
        print(json.dumps(
            [{
                "slug": u.slug, "subdivision_id": u.subdivision_id,
                "division_id": u.division_id, "title_en": u.title_en,
                "title_uk": u.title_uk, "active": u.active,
                "months": u.months, "years": u.years,
                "daily": sorted(d.intraday.get(u.subdivision_id, {})),
            } for u in d.units],
            ensure_ascii=False, indent=2,
        ))
        return

    print(f"{len(d.units)} units (excluding the USF grouping)\n")
    head = f"{'slug':22s} {'div':>3s} {'act':>3s} {'mo':>3s} {'months':17s} {'yrs':10s} intraday"
    print(head)
    print("-" * len(head))
    for u in d.units:
        span = f"{u.first_month or '—'}..{u.last_month or '—'}"
        print(
            f"{u.slug:22s} {str(u.division_id):>3s} {'y' if u.active else 'n':>3s} "
            f"{len(u.months):>3d} {span:17s} {','.join(u.years) or '—':10s} "
            f"{','.join(sorted(d.intraday.get(u.subdivision_id, {}))) or '—'}"
        )


if __name__ == "__main__":
    main()
