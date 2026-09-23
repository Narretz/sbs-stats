"""Tests for the SBS ingest's payload guards.

Run from this directory:  pytest -q test_fetch_and_update.py

Everything here is offline — the guards exist precisely because the API
answers HTTP 200 for things that are not data, so the interesting cases are
hand-built payloads rather than live ones.
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

import fetch_and_update as fu  # noqa: E402


def _period(pid: str, start: str, end: str, subdivision: str | None = None) -> dict:
    return {
        "_id": pid,
        "startDate": start,
        "endDate": end,
        "subdivision": {"_id": subdivision or fu.SUBDIVISION_ID},
    }


# ─── Month derivation ────────────────────────────────────────────────────────

class TestPeriodMonth:
    @pytest.mark.parametrize("start,expected", [
        # Monthly periods come back as a plain UTC midnight…
        ("2026-09-01T00:00:00.000Z", "2026-09"),
        ("2025-12-01T00:00:00.000Z", "2025-12"),
        # …while the custom ones are Kyiv midnight expressed in UTC. Both have
        # to land on the month a reader would name.
        ("2025-06-10T21:00:00.000Z", "2025-06"),
    ])
    def test_month_of(self, start, expected):
        assert fu._period_month(start) == expected


# ─── status ──────────────────────────────────────────────────────────────────

class TestPayloadIsUsable:
    def test_completed_is_usable(self):
        assert fu._payload_is_usable({"status": "completed"}, "x") is True

    def test_not_collected_is_rejected(self):
        # What an unrecognised (subdivision, period) pair returns: HTTP 200,
        # every counter zeroed. Writing it would store zeros as if reported.
        assert fu._payload_is_usable(
            {"status": "not_collected", "totalTargetsHit": 0}, "x"
        ) is False

    def test_missing_status_is_rejected(self):
        assert fu._payload_is_usable({"totalTargetsHit": 5}, "x") is False

    def test_a_real_month_of_zeros_is_still_usable(self):
        # 194 ОПМБр genuinely reported 0 for 2026-08. Zero is not a sentinel
        # in this API — only `status` separates "nothing happened" from
        # "nothing was collected".
        assert fu._payload_is_usable(
            {"status": "completed", "totalTargetsHit": 0}, "x"
        ) is True


# ─── startDate ───────────────────────────────────────────────────────────────

class TestPayloadPeriodStart:
    def test_reads_the_stated_day(self):
        assert fu._payload_period_start(
            {"startDate": "2026-09-14T00:00:00.000Z"}, "x"
        ) == "2026-09-14"

    @pytest.mark.parametrize("bad", [None, "", "2026-09", 20260914])
    def test_unusable_values_return_none(self, bad):
        assert fu._payload_period_start({"startDate": bad}, "x") is None

    def test_unparseable_returns_none(self):
        assert fu._payload_period_start({"startDate": "not-a-date-at-all"}, "x") is None

    def test_agrees_with_period_month(self):
        # The date and the month a single payload yields must never disagree;
        # they go through one conversion for exactly this reason.
        start = "2026-03-01T00:00:00.000Z"
        assert fu._payload_period_start({"startDate": start}, "x")[:7] == (
            fu._period_month(start)
        )


# ─── /periods discovery ──────────────────────────────────────────────────────

class TestDiscoverMonthlyUrls:
    def test_keys_by_stated_start_not_by_period_id(self, monkeypatch):
        # The twelve `monthly_N` slots are re-pointed every year, so the id is
        # not a stable name for a month — only startDate is. Here the same id
        # shape carries a 2025 month and a 2026 one.
        monkeypatch.setattr(fu, "fetch_json", lambda url: {"data": {
            "pagination": {"current": 1, "pages": 1, "total": 2},
            "periods": [
                _period("aaa", "2025-08-01T00:00:00.000Z", "2025-08-31T23:59:59.999Z"),
                _period("bbb", "2026-08-01T00:00:00.000Z", "2026-08-31T23:59:59.999Z"),
            ],
        }})
        urls = fu.discover_monthly_urls()
        assert sorted(urls) == ["2025-08", "2026-08"]
        assert urls["2025-08"].endswith("/aaa")
        assert urls["2026-08"].endswith("/bbb")

    def test_other_subdivisions_are_ignored(self, monkeypatch):
        monkeypatch.setattr(fu, "fetch_json", lambda url: {"data": {
            "pagination": {"current": 1, "pages": 1, "total": 2},
            "periods": [
                _period("ours", "2026-08-01T00:00:00.000Z", "2026-08-31T23:59:59.999Z"),
                _period("theirs", "2026-07-01T00:00:00.000Z", "2026-07-31T23:59:59.999Z",
                        subdivision="deadbeefdeadbeefdeadbeef"),
            ],
        }})
        assert sorted(fu.discover_monthly_urls()) == ["2026-08"]

    def test_partial_period_is_not_a_month(self, monkeypatch):
        # "11.06.2025 - now" and the yearly periods must not be mistaken for
        # calendar months.
        monkeypatch.setattr(fu, "fetch_json", lambda url: {"data": {
            "pagination": {"current": 1, "pages": 1, "total": 2},
            "periods": [
                _period("custom", "2025-06-10T21:00:00.000Z", "2026-09-15T00:00:00.000Z"),
                _period("yearly", "2026-01-01T00:00:00.000Z", "2026-12-31T23:59:59.999Z"),
            ],
        }})
        assert fu.discover_monthly_urls() == {}

    def test_truncated_page_warns(self, monkeypatch, caplog):
        # `/periods` serves every subdivision and defaults to 50 of ~245. A
        # truncated page looks downstream exactly like "that month doesn't
        # exist yet", so it has to announce itself.
        monkeypatch.setattr(fu, "fetch_json", lambda url: {"data": {
            "pagination": {"current": 1, "pages": 5, "total": 245},
            "periods": [
                _period("a", "2026-08-01T00:00:00.000Z", "2026-08-31T23:59:59.999Z"),
            ],
        }})
        with caplog.at_level("WARNING"):
            fu.discover_monthly_urls()
        assert any("truncat" in r.message or "page 1 of 5" in r.message
                   for r in caplog.records)

    def test_single_page_does_not_warn(self, monkeypatch, caplog):
        monkeypatch.setattr(fu, "fetch_json", lambda url: {"data": {
            "pagination": {"current": 1, "pages": 1, "total": 1},
            "periods": [
                _period("a", "2026-08-01T00:00:00.000Z", "2026-08-31T23:59:59.999Z"),
            ],
        }})
        with caplog.at_level("WARNING"):
            fu.discover_monthly_urls()
        assert not caplog.records


def test_periods_url_asks_for_every_page():
    # Not a style check: the default of 50 is smaller than the number of
    # periods the endpoint holds, and which ones land on page 1 is not ours
    # to decide.
    assert "limit=500" in fu.PERIODS_URL
