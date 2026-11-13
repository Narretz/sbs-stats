"""Tests for the weather ingest (ingest.py) and the shared client (openmeteo.py).

No network: `fetch` is replaced by a fake that answers any range with
synthetic hourly rows, the way Open-Meteo would.
"""
from __future__ import annotations

import io
import logging
import sqlite3
import sys
import urllib.error
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ingest  # noqa: E402
import openmeteo  # noqa: E402
from sectors import SECTORS  # noqa: E402

# 2026-11-13 10:30 UTC = 12:30 Kyiv (EET, UTC+2).
NOW = datetime(2026, 11, 13, 10, 30, tzinfo=timezone.utc)
TODAY = date(2026, 11, 13)


def fake_fetch(value=1.0, calls=None, skip=()):
    """A fetch answering every hour of [start, end] with `value` in each field."""
    def fetch(base, sectors, start, end):
        if calls is not None:
            calls.append((base, start, end))
        out = []
        for _ in sectors:
            rows, t = [], datetime.combine(start, datetime.min.time())
            while t.date() <= end:
                row = {"time": t.strftime("%Y-%m-%dT%H:%M")}
                for c in openmeteo.HOURLY:
                    row[c] = None if c in skip else value
                rows.append(row)
                t += timedelta(hours=1)
            out.append(rows)
        return out
    return fetch


@pytest.fixture
def conn(tmp_path):
    c = ingest.connect(tmp_path / "weather.db")
    ingest.sync_sectors(c)
    yield c
    c.close()


def q(conn, sql, *args):
    return conn.execute(sql, args).fetchall()


# ── live ────────────────────────────────────────────────────────────────────

def test_live_splits_past_and_future(conn):
    calls = []
    assert ingest.run_live(conn, NOW, fetch=fake_fetch(calls=calls))
    assert calls == [(ingest.FORECAST_URL, TODAY - timedelta(days=3), TODAY + timedelta(days=1))]
    n = len(SECTORS)
    # 3 days back + today's hours up to 12:00 (12:00 < 12:30) are past.
    assert q(conn, "SELECT COUNT(*) FROM hourly") == [(n * (72 + 13),)]
    assert q(conn, "SELECT MIN(time), MAX(time) FROM forecast") == [("2026-11-13T13:00", "2026-11-14T23:00")]
    assert q(conn, "SELECT COUNT(*) FROM forecast") == [(n * (11 + 24),)]


def test_rows_settle_at_48_hours(conn):
    ingest.run_live(conn, NOW, fetch=fake_fetch())
    key = SECTORS[0].key
    # 12:30 Kyiv now → everything before 2026-11-11T12:30 is settled.
    assert q(conn, "SELECT settled FROM hourly WHERE sector=? AND time='2026-11-11T12:00'", key) == [(1,)]
    assert q(conn, "SELECT settled FROM hourly WHERE sector=? AND time='2026-11-11T13:00'", key) == [(0,)]


def test_a_later_run_refines_unsettled_hours_only(conn):
    ingest.run_live(conn, NOW, fetch=fake_fetch(1.0))
    later = NOW + timedelta(hours=1)
    ingest.run_live(conn, later, fetch=fake_fetch(2.0))
    key = SECTORS[0].key
    settled = q(conn, "SELECT visibility FROM hourly WHERE sector=? AND time='2026-11-10T12:00'", key)
    recent = q(conn, "SELECT visibility, settled FROM hourly WHERE sector=? AND time='2026-11-13T09:00'", key)
    # Hour 13:00 was forecast at 12:30, and is history at 13:30.
    moved = q(conn, "SELECT visibility FROM hourly WHERE sector=? AND time='2026-11-13T13:00'", key)
    assert settled == [(1.0,)]
    assert recent == [(2.0, 0)]
    assert moved == [(2.0,)]
    assert q(conn, "SELECT COUNT(*) FROM forecast WHERE time <= '2026-11-13T13:00'") == [(0,)]


def test_an_unchanged_rerun_writes_no_hourly_rows(conn):
    ingest.run_live(conn, NOW, fetch=fake_fetch())
    assert ingest.store(conn, list(SECTORS), fake_fetch()(None, SECTORS, TODAY, TODAY),
                        datetime(2026, 11, 13, 12, 30), "x", "forecast", False)[0] == 0


def test_snapshot_once_a_day_from_0600(conn):
    early = datetime(2026, 11, 13, 3, 30, tzinfo=timezone.utc)   # 05:30 Kyiv
    ingest.run_live(conn, early, fetch=fake_fetch())
    assert q(conn, "SELECT COUNT(*) FROM forecast_snapshot") == [(0,)]

    ingest.run_live(conn, NOW, fetch=fake_fetch(1.0))
    rows = q(conn, "SELECT snapshot_date, MIN(time), MAX(time), COUNT(*) FROM forecast_snapshot")
    assert rows == [("2026-11-13", "2026-11-13T00:00", "2026-11-14T23:00", len(SECTORS) * 48)]

    # A later run the same day leaves the morning's snapshot as it was.
    ingest.run_live(conn, NOW + timedelta(hours=2), fetch=fake_fetch(9.0))
    assert q(conn, "SELECT DISTINCT visibility FROM forecast_snapshot") == [(1.0,)]
    assert q(conn, "SELECT snapshot FROM runs ORDER BY fetched_at") == [(0,), (1,), (0,)]


# ── gaps and backfill ───────────────────────────────────────────────────────

def test_live_reaches_back_to_close_a_gap(conn):
    ingest.run_live(conn, NOW - timedelta(days=10), fetch=fake_fetch())
    calls = []
    ingest.run_live(conn, NOW, fetch=fake_fetch(calls=calls))
    assert calls[0][1] == date(2026, 11, 3)   # the day the last stored hour is on


def test_a_gap_past_the_live_reach_is_reported(conn, caplog):
    ingest.run_live(conn, NOW - timedelta(days=200), fetch=fake_fetch())
    calls = []
    with caplog.at_level(logging.WARNING, logger="weather"):
        ingest.run_live(conn, NOW, fetch=fake_fetch(calls=calls))
    assert calls[0][1] == TODAY - timedelta(days=ingest.LIVE_MAX_PAST_DAYS)
    assert "backfill_from=" in caplog.text


def test_backfill_walks_month_chunks_up_to_the_live_window(conn):
    calls = []
    assert ingest.run_backfill(conn, NOW, date(2026, 9, 1), fetch=fake_fetch(calls=calls),
                               pause=lambda s: None)
    assert [(s.isoformat(), e.isoformat()) for _, s, e in calls] == [
        ("2026-09-01", "2026-10-01"), ("2026-10-02", "2026-11-01"), ("2026-11-02", "2026-11-10")]
    assert all(base == ingest.ARCHIVE_URL for base, _, _ in calls)
    assert q(conn, "SELECT DISTINCT source, settled FROM hourly") == [("archive", 1)]
    assert q(conn, "SELECT COUNT(*) FROM forecast") == [(0,)]


def test_live_does_not_overwrite_settled_archive_rows(conn):
    ingest.run_backfill(conn, NOW, date(2026, 11, 1), fetch=fake_fetch(1.0), pause=lambda s: None)
    ingest.run_live(conn, NOW, fetch=fake_fetch(5.0))
    assert q(conn, "SELECT DISTINCT visibility FROM hourly WHERE time < '2026-11-11'") == [(1.0,)]


# ── checks ──────────────────────────────────────────────────────────────────

def test_a_field_gone_missing_is_reported(conn, caplog):
    with caplog.at_level(logging.WARNING, logger="weather"):
        ingest.run_live(conn, NOW, fetch=fake_fetch(skip={"visibility"}))
    assert "no visibility" in caplog.text


# ── client ──────────────────────────────────────────────────────────────────

def _http_error(code, reason="x"):
    return urllib.error.HTTPError("u", code, "msg", {}, io.BytesIO(f'{{"reason":"{reason}"}}'.encode()))


def test_fetch_retries_rate_limits_then_succeeds():
    answers = [_http_error(429, "Daily API request limit exceeded"), {"ok": 1}]
    slept = []

    def get(url):
        a = answers.pop(0)
        if isinstance(a, Exception):
            raise a
        return a
    assert openmeteo.fetch("u", sleep=slept.append, get=get) == {"ok": 1}
    assert slept == [openmeteo.RETRY_DELAYS_S[0]]


def test_fetch_gives_up_on_a_bad_request_at_once():
    def get(url):
        raise _http_error(400, "Cannot initialize WeatherVariable")
    with pytest.raises(openmeteo.OpenMeteoError, match="400: Cannot initialize"):
        openmeteo.fetch("u", sleep=lambda s: pytest.fail("no retry for a 400"), get=get)


def test_fetch_stops_after_the_last_retry():
    def get(url):
        raise urllib.error.URLError("reset")
    slept = []
    with pytest.raises(openmeteo.OpenMeteoError, match="after 4 attempts"):
        openmeteo.fetch("u", sleep=slept.append, get=get)
    assert slept == list(openmeteo.RETRY_DELAYS_S)


# ── main ────────────────────────────────────────────────────────────────────

def test_main_writes_the_db_and_the_changed_output(tmp_path, monkeypatch):
    monkeypatch.setattr(ingest, "_fetch", fake_fetch())
    monkeypatch.setattr(ingest.run_live, "__defaults__", (ingest._fetch,))
    out = tmp_path / "gh_output"
    monkeypatch.setenv("GITHUB_OUTPUT", str(out))
    db = tmp_path / "weather.db"
    assert ingest.main(["--db", str(db), "--now", "2026-11-13T10:30:00"]) == 0
    assert out.read_text() == "changed=true\n"
    conn = sqlite3.connect(db)
    assert conn.execute("SELECT COUNT(*) FROM sectors").fetchone() == (len(SECTORS),)
    assert conn.execute("SELECT mode FROM runs").fetchall() == [("live",)]


def test_main_reports_a_failed_fetch(tmp_path, monkeypatch, caplog):
    def boom(*a):
        raise openmeteo.OpenMeteoError("HTTP 429: limit (after 4 attempts)")
    monkeypatch.setattr(ingest.run_live, "__defaults__", (boom,))
    out = tmp_path / "gh_output"
    monkeypatch.setenv("GITHUB_OUTPUT", str(out))
    with caplog.at_level(logging.ERROR, logger="weather"):
        assert ingest.main(["--db", str(tmp_path / "w.db"), "--now", "2026-11-13T10:30:00"]) == 1
    assert out.read_text() == "changed=false\n"
    assert "after 4 attempts" in caplog.text
