"""Tests for the SBS sub-unit ingest.

Run from this directory:  pytest -q test_ingest.py

All offline. The payloads here are trimmed copies of real ones, kept because
each encodes a way this API misleads a naive reader — a zeroed stub that looks
like data, a period slot serving a different year, a unit that genuinely
reports nothing.
"""
from __future__ import annotations

import sqlite3
import sys
from datetime import date, datetime, timezone
from pathlib import Path

import pytest

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))
sys.path.insert(0, str(SCRIPT_DIR.parent))

import check_db  # noqa: E402
import discover as dsc  # noqa: E402
import ingest as ing  # noqa: E402


# ─── Fixtures ────────────────────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def _no_request_pacing(monkeypatch):
    """Nothing in this suite makes a real request, so nothing should wait.

    Without this the ingest's 0.4s inter-read gap fires between every
    monkeypatched fetch and the suite takes ten times as long for no coverage.
    TestPacedFetch sets its own interval, which wins — this fixture runs first.
    """
    monkeypatch.setattr(ing, "REQUEST_INTERVAL_S", 0.0)
    monkeypatch.setattr(ing, "_last_fetch_at", 0.0)


def subdivision(sid: str, div: str, title_en: str, title_uk: str = "x") -> dict:
    return {"_id": sid, "division_id": div, "title": title_uk, "title_en": title_en,
            "color": "#fff", "displayOrder": int(div)}


def period(pid: str, sid: str, kind: str, start: str | None, end: str | None) -> dict:
    p = {"_id": pid, "periodType": kind, "subdivision": {"_id": sid}}
    if start:
        p["startDate"] = start
    if end:
        p["endDate"] = end
    return p


def listing(key: str, items: list[dict]) -> dict:
    return {"data": {key: items, "pagination": {"current": 1, "pages": 1, "total": len(items)}}}


GROUPING = dsc.GROUPING_SUBDIVISION_ID


@pytest.fixture
def two_units():
    subs = listing("subdivisions", [
        subdivision(GROUPING, "0", "USF Grouping"),
        subdivision("aaa", "3", "Fenix", "Фенікс"),
        subdivision("bbb", "9", "Flying Skull"),
    ])
    pers = listing("periods", [
        # Fenix: live, two months, a year.
        period("f-daily", "aaa", "daily", None, None),
        period("f-prev", "aaa", "prev_day", None, None),
        period("f-m8", "aaa", "monthly_8", "2026-08-01T00:00:00.000Z", "2026-08-31T23:59:59.999Z"),
        period("f-m9", "aaa", "monthly_9", "2026-09-01T00:00:00.000Z", "2026-09-30T23:59:59.999Z"),
        period("f-y", "aaa", "yearly_2026", "2026-01-01T00:00:00.000Z", "2026-12-31T23:59:59.999Z"),
        # Flying Skull: retired — no daily, and its monthly_8 slot still points
        # at ITS August, a year earlier than Fenix's.
        period("s-m8", "bbb", "monthly_8", "2025-08-01T00:00:00.000Z", "2025-08-31T23:59:59.999Z"),
        # Neither a month nor a year: must be classified as neither.
        period("f-custom", "aaa", "custom", "2025-06-10T21:00:00.000Z", None),
    ])
    return dsc.discover(subs, pers)


# ─── Discovery ───────────────────────────────────────────────────────────────

class TestDiscovery:
    def test_grouping_is_excluded(self, two_units):
        assert GROUPING not in {u.subdivision_id for u in two_units.units}

    def test_active_is_derived_from_the_daily_period(self, two_units):
        by = {u.slug: u for u in two_units.units}
        assert by["fenix"].active is True
        # Nothing in the payload says "retired" — the periods just stop.
        assert by["flying-skull"].active is False

    def test_months_and_years_are_collected_per_unit(self, two_units):
        by = {u.slug: u for u in two_units.units}
        assert by["fenix"].months == ["2026-08", "2026-09"]
        assert by["fenix"].years == ["2026"]
        assert by["flying-skull"].months == ["2025-08"]
        assert by["flying-skull"].years == []

    def test_monthly_slots_are_keyed_by_stated_month_not_slot_name(self, two_units):
        # Both units have a `monthly_8`; they are different Augusts.
        assert two_units.monthly[("aaa", "2026-08")] == "f-m8"
        assert two_units.monthly[("bbb", "2025-08")] == "s-m8"

    def test_a_custom_span_is_neither_month_nor_year(self, two_units):
        assert all(pid != "f-custom" for pid in two_units.monthly.values())
        assert all(pid != "f-custom" for pid in two_units.yearly.values())

    @pytest.mark.parametrize("title,slug", [
        ("Magyar's Birds", "magyars-birds"),
        ("K-2", "k-2"),
        ("9 SUSBr", "9-susbr"),
        ("Steppe Predators", "steppe-predators"),
        ("Flying Skull", "flying-skull"),
    ])
    def test_slugify(self, title, slug):
        assert dsc.slugify(title) == slug


# ─── Capture buckets ─────────────────────────────────────────────────────────

class TestCaptureBucket:
    def test_daily_buckets_by_day(self):
        now = datetime(2026, 9, 15, 18, 0, tzinfo=timezone.utc)   # 21:00 Kyiv
        assert ing.capture_bucket("daily", now) == "2026-09-15"

    @pytest.mark.parametrize("day,monday", [
        ("2026-09-14", "2026-09-14"),   # Monday itself
        ("2026-09-15", "2026-09-14"),
        ("2026-09-20", "2026-09-14"),   # Sunday still belongs to that week
        ("2026-09-21", "2026-09-21"),
    ])
    def test_monthly_buckets_by_iso_week(self, day, monday):
        now = datetime.fromisoformat(f"{day}T08:00:00+00:00")
        assert ing.capture_bucket("monthly", now) == monday

    def test_the_boundary_is_kyiv_not_utc(self):
        # 22:00 UTC is already 01:00 the next day in Kyiv, and Kyiv is the day
        # the DATA is keyed by — so a run then belongs to the new day. Under
        # UTC bucketing it would file the new day's provisional row under the
        # old day's bucket.
        assert ing.capture_bucket(
            "daily", datetime(2026, 9, 15, 22, 0, tzinfo=timezone.utc)) == "2026-09-16"
        # …and the week rolls with it.
        assert ing.capture_bucket(
            "monthly", datetime(2026, 9, 20, 22, 0, tzinfo=timezone.utc)) == "2026-09-21"

    def test_both_scheduled_runs_land_in_one_bucket(self):
        # The workflow fires at 09:00 and 21:00 Kyiv. Both must bucket to the
        # same day, or the twice-daily schedule would double the row count
        # instead of just improving freshness.
        for hour_utc in (6, 18):   # 09:00 and 21:00 Kyiv
            assert ing.capture_bucket(
                "daily", datetime(2026, 9, 15, hour_utc, tzinfo=timezone.utc)
            ) == "2026-09-15"

    def test_frequency_does_not_create_rows(self):
        # The property the whole storage model rests on: two runs in one day
        # land in one bucket, so polling more often changes freshness only.
        a = datetime(2026, 9, 15, 3, 0, tzinfo=timezone.utc)
        b = datetime(2026, 9, 15, 20, 0, tzinfo=timezone.utc)
        assert ing.capture_bucket("daily", a) == ing.capture_bucket("daily", b)
        assert ing.capture_bucket("monthly", a) == ing.capture_bucket("monthly", b)


# ─── Refresh windows ─────────────────────────────────────────────────────────

class TestMonthsToFetch:
    def _unit(self, months):
        u = dsc.Unit(slug="u", subdivision_id="s", division_id="1", title_uk=None,
                     title_en="U", color=None, display_order=1)
        u.months = months
        return u

    def test_current_month_and_revision_tail(self):
        u = self._unit(["2026-06", "2026-07", "2026-08", "2026-09"])
        # 2026-09-05: September is current, August ended 4 days ago.
        got = ing.months_to_fetch(u, date(2026, 9, 5), None, False)
        assert got == ["2026-09", "2026-08"]

    def test_tail_closes_after_ten_days(self):
        u = self._unit(["2026-08", "2026-09"])
        assert ing.months_to_fetch(u, date(2026, 9, 20), None, False) == ["2026-09"]

    def test_all_returns_everything_newest_first(self):
        u = self._unit(["2026-07", "2026-08", "2026-09"])
        assert ing.months_to_fetch(u, date(2026, 9, 20), None, True) == \
            ["2026-09", "2026-08", "2026-07"]

    def test_months_caps_the_list(self):
        u = self._unit(["2026-08", "2026-09"])
        assert ing.months_to_fetch(u, date(2026, 9, 5), 1, False) == ["2026-09"]


# ─── Payload validation, via read_period ─────────────────────────────────────

class TestReadPeriod:
    def _unit(self):
        return dsc.Unit(slug="fenix", subdivision_id="aaa", division_id="3",
                        title_uk=None, title_en="Fenix", color=None, display_order=3)

    def _disc(self):
        return dsc.Discovery(units=[], monthly={}, yearly={}, intraday={})

    def test_a_good_payload_parses(self, monkeypatch):
        monkeypatch.setattr(ing, "fetch_json", lambda url: {"data": {
            "status": "completed", "startDate": "2026-08-01T00:00:00.000Z",
            "dataCollectedAt": "2026-09-01T00:00:00.000Z",
            "personnel": {"killed": 5, "wounded": 6}, "flights": {"strike": 1, "recon": 2},
            "totalTargetsHit": 10, "totalTargetsDestroyed": 4,
            "totalPersonnelCasualties": 11,
            "targetsByType": [{"targetClassId": 1, "hit": 3, "destroyed": 1}],
        }})
        got = ing.read_period(self._disc(), self._unit(), "p", "monthly 2026-08", "2026-08")
        assert got["total_targets_hit"] == 10
        assert got["targets"][1]["hit"] == 3
        assert got["stated_start"] == "2026-08-01"

    def test_not_collected_stub_is_refused(self, monkeypatch):
        # An unrecognised (subdivision, period) pair answers HTTP 200 with
        # every counter zeroed. Storing it would invent a month of nothing.
        monkeypatch.setattr(ing, "fetch_json", lambda url: {"data": {
            "status": "not_collected", "targetsByType": [],
            "personnel": {"killed": 0, "wounded": 0}, "totalTargetsHit": 0,
        }})
        assert ing.read_period(self._disc(), self._unit(), "p", "monthly 2026-08", "2026-08") is None

    def test_a_real_month_of_zeros_is_kept(self, monkeypatch):
        # 194 ОПМБр genuinely reported 0 across 2026-08. Zero is not a
        # sentinel; only `status` separates the two cases.
        monkeypatch.setattr(ing, "fetch_json", lambda url: {"data": {
            "status": "completed", "startDate": "2026-08-01T00:00:00.000Z",
            "personnel": {"killed": 0, "wounded": 0}, "flights": {"strike": 0, "recon": 0},
            "totalTargetsHit": 0, "targetsByType": [],
        }})
        got = ing.read_period(self._disc(), self._unit(), "p", "monthly 2026-08", "2026-08")
        assert got is not None and got["total_targets_hit"] == 0

    def test_wrong_year_from_a_reused_slot_is_refused(self, monkeypatch):
        # The retired units keep their own months in the same `monthly_N`
        # slots, so a slot name is never a safe way to address a month.
        monkeypatch.setattr(ing, "fetch_json", lambda url: {"data": {
            "status": "completed", "startDate": "2025-08-01T00:00:00.000Z",
            "personnel": {}, "flights": {}, "totalTargetsHit": 461,
            "targetsByType": [],
        }})
        assert ing.read_period(self._disc(), self._unit(), "p", "monthly 2026-08", "2026-08") is None

    def test_daily_takes_its_date_from_the_payload(self, monkeypatch):
        # No expected bucket is passed for the daily grain — the endpoint
        # states which day it covers and that becomes the row's date.
        monkeypatch.setattr(ing, "fetch_json", lambda url: {"data": {
            "status": "completed", "startDate": "2026-09-14T00:00:00.000Z",
            "personnel": {}, "flights": {}, "totalTargetsHit": 251,
            "targetsByType": [],
        }})
        got = ing.read_period(self._disc(), self._unit(), "p", "prev_day", None)
        assert got["stated_start"] == "2026-09-14"


# ─── Writing ─────────────────────────────────────────────────────────────────

def _payload(hit: int, killed: int = 1) -> dict:
    return {
        "data_collected_at": "2026-09-15T12:00:00.000Z",
        "last_updated": "2026-09-15T12:00:00.000Z",
        "personnel_killed": killed, "personnel_wounded": 0,
        "total_targets_hit": hit, "total_targets_destroyed": 0,
        "total_personnel_casualties": killed,
        "flights_strike": 0, "flights_recon": 0,
        "targets": {1: {"hit": hit, "destroyed": 0}},
    }


@pytest.fixture
def conn():
    c = sqlite3.connect(":memory:")
    ing.ensure_schema(c)
    yield c
    c.close()


class TestUpsertStats:
    def test_first_write_lands(self, conn):
        assert ing.upsert_stats(conn, ing.MONTHLY_TABLE, "fenix", "2026-09-01",
                                "2026-09-14", _payload(100), "t0") is True
        assert conn.execute("SELECT COUNT(*) FROM unit_monthly_stats").fetchone()[0] == 1

    def test_unchanged_values_write_nothing(self, conn):
        ing.upsert_stats(conn, ing.MONTHLY_TABLE, "fenix", "2026-09-01",
                         "2026-09-14", _payload(100), "t0")
        assert ing.upsert_stats(conn, ing.MONTHLY_TABLE, "fenix", "2026-09-01",
                                "2026-09-21", _payload(100), "t1") is False
        assert conn.execute("SELECT COUNT(*) FROM unit_monthly_stats").fetchone()[0] == 1

    def test_same_bucket_updates_in_place(self, conn):
        ing.upsert_stats(conn, ing.MONTHLY_TABLE, "fenix", "2026-09-01",
                         "2026-09-14", _payload(100), "t0")
        ing.upsert_stats(conn, ing.MONTHLY_TABLE, "fenix", "2026-09-01",
                         "2026-09-14", _payload(150), "t1")
        rows = conn.execute(
            "SELECT capture_bucket, total_targets_hit FROM unit_monthly_stats").fetchall()
        assert rows == [("2026-09-14", 150)]

    def test_a_new_bucket_appends(self, conn):
        ing.upsert_stats(conn, ing.MONTHLY_TABLE, "fenix", "2026-09-01",
                         "2026-09-14", _payload(100), "t0")
        ing.upsert_stats(conn, ing.MONTHLY_TABLE, "fenix", "2026-09-01",
                         "2026-09-21", _payload(150), "t1")
        rows = conn.execute(
            "SELECT capture_bucket, total_targets_hit FROM unit_monthly_stats "
            "ORDER BY capture_bucket").fetchall()
        assert rows == [("2026-09-14", 100), ("2026-09-21", 150)]

    def test_a_downward_revision_is_stored_not_dropped(self, conn):
        # Closed months move in both directions in this source; the newest
        # capture wins whichever way it went.
        ing.upsert_stats(conn, ing.MONTHLY_TABLE, "fenix", "2026-08-01",
                         "2026-09-07", _payload(100), "t0")
        ing.upsert_stats(conn, ing.MONTHLY_TABLE, "fenix", "2026-08-01",
                         "2026-09-14", _payload(97), "t1")
        newest = conn.execute(
            "SELECT total_targets_hit FROM unit_monthly_stats WHERE date='2026-08-01' "
            "ORDER BY capture_bucket DESC LIMIT 1").fetchone()
        assert newest[0] == 97

    def test_the_two_daily_rows_for_one_date_coexist(self, conn):
        # Today's provisional reading, then tomorrow's settled one for the
        # same date. Different capture buckets, so both survive.
        ing.upsert_stats(conn, ing.DAILY_TABLE, "fenix", "2026-09-15",
                         "2026-09-15", _payload(122), "t0")
        ing.upsert_stats(conn, ing.DAILY_TABLE, "fenix", "2026-09-15",
                         "2026-09-16", _payload(251), "t1")
        rows = conn.execute(
            "SELECT capture_bucket, total_targets_hit FROM unit_daily_stats "
            "WHERE date='2026-09-15' ORDER BY capture_bucket").fetchall()
        assert rows == [("2026-09-15", 122), ("2026-09-16", 251)]


class TestIntervalGuard:
    def test_empty_db_has_no_age(self, conn):
        assert ing.hours_since_last_capture(conn, datetime.now(timezone.utc)) is None

    def test_age_is_measured_across_every_grain(self, conn):
        # The newest capture in ANY table counts — a run that wrote only daily
        # rows still means the API was polled.
        ing.upsert_stats(conn, ing.DAILY_TABLE, "fenix", "2026-09-15", "2026-09-15",
                         _payload(1), "2026-09-15T06:00:00+00:00")
        now = datetime(2026, 9, 15, 12, 0, tzinfo=timezone.utc)
        assert ing.hours_since_last_capture(conn, now) == pytest.approx(6.0)

    def test_naive_timestamps_are_read_as_utc(self, conn):
        ing.upsert_stats(conn, ing.MONTHLY_TABLE, "fenix", "2026-09-01", "2026-09-14",
                         _payload(1), "2026-09-15T06:00:00")
        now = datetime(2026, 9, 15, 9, 0, tzinfo=timezone.utc)
        assert ing.hours_since_last_capture(conn, now) == pytest.approx(3.0)


class TestUpsertUnits:
    def _unit(self, slug_title="Fenix", active=True):
        u = dsc.Unit(slug=dsc.slugify(slug_title), subdivision_id="aaa", division_id="3",
                     title_uk="Фенікс", title_en=slug_title, color="#fff", display_order=3)
        u.active = active
        u.months = ["2026-09"]
        return u

    def test_registry_is_keyed_on_subdivision_id(self, conn):
        ing.upsert_units(conn, [self._unit()], "t0")
        ing.upsert_units(conn, [self._unit()], "t1")
        assert conn.execute("SELECT COUNT(*) FROM units").fetchone()[0] == 1

    def test_a_rename_warns(self, conn, caplog):
        ing.upsert_units(conn, [self._unit("Fenix")], "t0")
        with caplog.at_level("WARNING"):
            ing.upsert_units(conn, [self._unit("Phoenix")], "t1")
        assert any("slug changed" in r.message for r in caplog.records)

    def test_losing_the_daily_period_warns(self, conn, caplog):
        ing.upsert_units(conn, [self._unit(active=True)], "t0")
        with caplog.at_level("WARNING"):
            ing.upsert_units(conn, [self._unit(active=False)], "t1")
        assert any("retired" in r.message for r in caplog.records)


# ─── check_db: the closed-month revision check ───────────────────────────────

class TestLargeRevision:
    """`check_db`'s "large revision" notice, which asks whether the SOURCE
    changed a figure it had already settled.

    The trap these cover: a month is first captured partway through itself, so
    the earliest capture of a tracked month is a partial total. Measuring from
    there reports the month filling up as a revision — every unit, every run,
    forever, while a genuine retroactive edit to a closed month is exactly what
    the check is for.
    """

    # The month under test and the two capture buckets around its end. The
    # Mondays are real ISO-week Mondays, as `capture_bucket` produces.
    MONTH = "2026-08-01"
    MID_MONTH = "2026-08-17"    # captured while August was still running
    AFTER_CLOSE = "2026-09-07"  # first capture once August had ended
    LATER = "2026-09-14"

    @staticmethod
    def _tracked_unit(conn, slug="fenix", month="2026-08"):
        # active=0 so the daily-staleness checks stay quiet, and one month in
        # [first_month, last_month] so the uncaptured-month check does too.
        conn.execute(
            "INSERT INTO units (slug, subdivision_id, active, has_daily, "
            "first_month, last_month, scraped_at) VALUES (?, ?, 0, 0, ?, ?, 't0')",
            (slug, f"sid-{slug}", month, month),
        )

    @staticmethod
    def _capture(conn, bucket, hit, captured_at, slug="fenix", month="2026-08-01"):
        ing.upsert_stats(conn, ing.MONTHLY_TABLE, slug, month, bucket,
                         _payload(hit), captured_at)

    @staticmethod
    def _notices(caplog):
        return [r.message for r in caplog.records if "targets hit revised" in r.message]

    def test_an_in_progress_month_accruing_is_not_a_revision(self, conn, caplog):
        # The September regression: +10% between the first mid-month capture
        # and the latest one is the month filling up, and fired on 9 units.
        self._tracked_unit(conn, month="2026-09")
        self._capture(conn, "2026-09-07", 3062, "2026-09-07T09:00:00Z", month="2026-09-01")
        self._capture(conn, "2026-09-14", 3413, "2026-09-14T09:00:00Z", month="2026-09-01")
        with caplog.at_level("WARNING"):
            check_db.check(conn, date(2026, 9, 23))
        assert self._notices(caplog) == []

    def test_a_settled_month_edited_afterwards_is_reported(self, conn, caplog):
        self._tracked_unit(conn)
        self._capture(conn, self.MID_MONTH, 500, "2026-08-17T09:00:00Z")
        self._capture(conn, self.AFTER_CLOSE, 1000, "2026-09-07T09:00:00Z")
        self._capture(conn, self.LATER, 1100, "2026-09-14T09:00:00Z")
        with caplog.at_level("WARNING"):
            check_db.check(conn, date(2026, 9, 23))
        # Measured from the settled 1000, not the mid-month 500.
        assert self._notices(caplog) == [
            "fenix 2026-08: targets hit revised 1000 -> 1100 (+10.0%) after the "
            "month closed."
        ]

    def test_a_downward_edit_is_reported_too(self, conn, caplog):
        self._tracked_unit(conn)
        self._capture(conn, self.AFTER_CLOSE, 1000, "2026-09-07T09:00:00Z")
        self._capture(conn, self.LATER, 900, "2026-09-14T09:00:00Z")
        with caplog.at_level("WARNING"):
            check_db.check(conn, date(2026, 9, 23))
        assert "-10.0%" in self._notices(caplog)[0]

    def test_routine_drift_under_the_threshold_stays_quiet(self, conn, caplog):
        # The measured behaviour REVISION_PCT is set against: closed months
        # move by single digits in both directions.
        self._tracked_unit(conn)
        self._capture(conn, self.AFTER_CLOSE, 1000, "2026-09-07T09:00:00Z")
        self._capture(conn, self.LATER, 1004, "2026-09-14T09:00:00Z")
        with caplog.at_level("WARNING"):
            check_db.check(conn, date(2026, 9, 23))
        assert self._notices(caplog) == []

    def test_a_month_with_no_settled_capture_yet_is_skipped(self, conn, caplog):
        # August ended but was only ever read during itself — there is no
        # settled figure to compare against, so there is nothing to say.
        self._tracked_unit(conn)
        self._capture(conn, "2026-08-10", 400, "2026-08-10T09:00:00Z")
        self._capture(conn, self.MID_MONTH, 500, "2026-08-17T09:00:00Z")
        with caplog.at_level("WARNING"):
            check_db.check(conn, date(2026, 9, 23))
        assert self._notices(caplog) == []

    def test_one_settled_capture_alone_is_not_a_revision(self, conn, caplog):
        self._tracked_unit(conn)
        self._capture(conn, self.MID_MONTH, 500, "2026-08-17T09:00:00Z")
        self._capture(conn, self.AFTER_CLOSE, 1000, "2026-09-07T09:00:00Z")
        with caplog.at_level("WARNING"):
            check_db.check(conn, date(2026, 9, 23))
        assert self._notices(caplog) == []


# ─── Request pacing ──────────────────────────────────────────────────────────

class TestPacedFetch:
    """`fetch_json` retrying a 429 saves the run; this is what stops the 429.

    ~60 reads a run used to go out as fast as the API answered, and `--all`
    makes several hundred.
    """

    @pytest.fixture(autouse=True)
    def _reset(self, monkeypatch):
        monkeypatch.setattr(ing, "_last_fetch_at", 0.0)

    def _clock(self, monkeypatch, slept: list[float]):
        now = {"t": 100.0}
        monkeypatch.setattr(ing.time, "monotonic", lambda: now["t"])
        monkeypatch.setattr(ing.time, "sleep", lambda s: (slept.append(s),
                                                          now.__setitem__("t", now["t"] + s)))
        monkeypatch.setattr(ing, "fetch_json", lambda url: {"data": {"url": url}})
        return now

    def test_the_first_read_does_not_wait(self, monkeypatch):
        slept: list[float] = []
        self._clock(monkeypatch, slept)
        assert ing._paced_fetch("http://x/1") == {"data": {"url": "http://x/1"}}
        assert slept == []

    def test_a_second_read_waits_out_the_interval(self, monkeypatch):
        slept: list[float] = []
        monkeypatch.setattr(ing, "REQUEST_INTERVAL_S", 0.4)
        self._clock(monkeypatch, slept)
        ing._paced_fetch("http://x/1")
        ing._paced_fetch("http://x/2")
        assert slept == [pytest.approx(0.4)]

    def test_a_slow_request_counts_towards_the_gap(self, monkeypatch):
        # The interval is measured from the END of the previous request, so an
        # API that already took longer than the interval is not made slower.
        slept: list[float] = []
        monkeypatch.setattr(ing, "REQUEST_INTERVAL_S", 0.4)
        now = self._clock(monkeypatch, slept)
        ing._paced_fetch("http://x/1")
        now["t"] += 2.0  # the caller spent 2s doing something else
        ing._paced_fetch("http://x/2")
        assert slept == []

    def test_zero_turns_the_pacing_off(self, monkeypatch):
        slept: list[float] = []
        monkeypatch.setattr(ing, "REQUEST_INTERVAL_S", 0.0)
        self._clock(monkeypatch, slept)
        ing._paced_fetch("http://x/1")
        ing._paced_fetch("http://x/2")
        assert slept == []

    def test_a_raising_fetch_still_advances_the_clock(self, monkeypatch):
        # Otherwise a burst of failures would ignore the pacing entirely,
        # which is the exact situation a 429 puts us in.
        slept: list[float] = []
        monkeypatch.setattr(ing, "REQUEST_INTERVAL_S", 0.4)
        self._clock(monkeypatch, slept)
        monkeypatch.setattr(ing, "fetch_json", lambda url: (_ for _ in ()).throw(RuntimeError("429")))
        with pytest.raises(RuntimeError):
            ing._paced_fetch("http://x/1")
        assert ing._last_fetch_at != 0.0
