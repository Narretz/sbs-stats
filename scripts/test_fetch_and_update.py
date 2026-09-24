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


# ─── Retry on a throttling or transient upstream ─────────────────────────────

class _Resp:
    """Minimal stand-in for a requests Response."""

    def __init__(self, status: int, payload: dict | None = None, retry_after=None):
        self.status_code = status
        self._payload = payload or {}
        self.headers = {} if retry_after is None else {"Retry-After": retry_after}

    def raise_for_status(self):
        if self.status_code >= 400:
            raise fu.requests.exceptions.HTTPError(
                f"{self.status_code} Client Error for url: http://x/{self.status_code}",
                response=self,
            )

    def json(self):
        return self._payload


class _Session:
    """Answers each get() with the next queued response."""

    def __init__(self, *responses):
        self.queue = list(responses)
        self.headers = {}
        self.calls = 0

    def update(self, _):  # headers.update
        pass

    def get(self, url, timeout=None):
        self.calls += 1
        item = self.queue.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


@pytest.fixture
def no_sleep(monkeypatch):
    """Run the backoff without actually waiting, and record what it asked for."""
    slept: list[float] = []
    monkeypatch.setattr(fu.time, "sleep", lambda s: slept.append(s))
    return slept


def _session(monkeypatch, *responses) -> _Session:
    s = _Session(*responses)
    monkeypatch.setattr(fu.requests, "Session", lambda: s)
    return s


class TestFetchJsonRetries:
    """The sub-units ingest fires ~60 requests a run. On 2026-09-16 one of them
    came back 429, `fetch_json` raised, and the run died before its upload — so
    everything it had captured was thrown away, for a dataset where a month
    missed before it rolls out of the API's window is unrecoverable.
    """

    def test_a_429_is_retried_not_raised(self, monkeypatch, no_sleep):
        s = _session(monkeypatch, _Resp(429), _Resp(200, {"data": {"ok": 1}}))
        assert fu.fetch_json("http://x/stats") == {"data": {"ok": 1}}
        assert s.calls == 2

    def test_retry_after_is_honoured_over_the_backoff(self, monkeypatch, no_sleep):
        _session(monkeypatch, _Resp(429, retry_after="7"), _Resp(200, {"data": {}}))
        fu.fetch_json("http://x/stats", backoff=5)
        assert no_sleep == [7.0]

    def test_an_absurd_retry_after_is_capped(self, monkeypatch, no_sleep):
        _session(monkeypatch, _Resp(429, retry_after="99999"), _Resp(200, {"data": {}}))
        fu.fetch_json("http://x/stats")
        assert no_sleep == [float(fu.MAX_RETRY_WAIT_S)]

    def test_a_junk_retry_after_falls_back_to_the_backoff(self, monkeypatch, no_sleep):
        _session(monkeypatch, _Resp(429, retry_after="soon"), _Resp(200, {"data": {}}))
        fu.fetch_json("http://x/stats", backoff=3)
        assert no_sleep == [3]

    def test_a_5xx_is_retried(self, monkeypatch, no_sleep):
        s = _session(monkeypatch, _Resp(503), _Resp(502), _Resp(200, {"data": {}}))
        fu.fetch_json("http://x/stats")
        assert s.calls == 3

    def test_a_404_is_not_retried(self, monkeypatch, no_sleep):
        # A missing period is a real answer, not congestion — retrying it four
        # more times just makes the failure slower.
        s = _session(monkeypatch, _Resp(404))
        with pytest.raises(fu.requests.exceptions.HTTPError):
            fu.fetch_json("http://x/stats")
        assert s.calls == 1

    def test_exhausting_the_retries_warns_before_raising(self, monkeypatch, no_sleep, caplog):
        _session(monkeypatch, *[_Resp(429) for _ in range(3)])
        with caplog.at_level("WARNING"):
            with pytest.raises(fu.requests.exceptions.HTTPError):
                fu.fetch_json("http://x/stats", retries=3)
        assert any("giving up" in r.message for r in caplog.records)

    def test_the_status_comes_from_the_response_not_the_message(self, monkeypatch, no_sleep):
        # The old code matched `"525" in str(e)`, so a 404 on a URL that merely
        # contained 525 was retried and a 429 never was.
        s = _session(monkeypatch, _Resp(404))
        with pytest.raises(fu.requests.exceptions.HTTPError):
            fu.fetch_json("http://x/525/stats")
        assert s.calls == 1

    def test_a_network_error_is_still_retried(self, monkeypatch, no_sleep):
        s = _session(
            monkeypatch,
            fu.requests.exceptions.ConnectionError("reset"),
            _Resp(200, {"data": {}}),
        )
        fu.fetch_json("http://x/stats")
        assert s.calls == 2
