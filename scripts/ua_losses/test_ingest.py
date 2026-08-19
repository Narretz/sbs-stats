"""Unit tests for the ua_losses ingest — parsing/join + append-version + guards.

The sheet parsers take plain row iterables (header first), so no real xlsx is
needed. `build()` is exercised against a tmp sqlite file.
"""
from datetime import datetime

import pytest

import ingest


# ── sheet parsing / join ──────────────────────────────────────────────────────
def test_index_byday_coerces_blanks_and_dates():
    rows = [
        ("Date", "Number", "ofwhich_Male", "meanAgeEvent", "CumNumber"),
        (datetime(2022, 2, 24), 10, 9, 31.256, 10),
        (datetime(2022, 2, 25), None, None, None, 10),  # a genuine zero day
    ]
    idx = ingest.index_byday(rows)
    assert idx["2022-02-24"] == (10, 9, 31.26)          # age rounded to 2dp
    assert idx["2022-02-25"] == (0, 0, None)            # blanks → 0, age → None


def test_index_status_reads_four_columns():
    rows = [
        ("Date", "Dead", "Missing", "Prisoner", "Released"),
        (datetime(2022, 2, 24), 7, 2, 1, 0),
    ]
    assert ingest.index_status(rows)["2022-02-24"] == (7, 2, 1, 0)


def test_join_defaults_missing_status_to_zero_and_filters_since():
    byday = {
        "2022-02-23": (5, 5, 40.0),   # pre-war, dropped by since
        "2022-02-24": (10, 9, 31.26),
        "2022-02-25": (0, 0, None),   # no status row
    }
    status = {"2022-02-24": (7, 2, 1, 0)}
    rows = ingest.join_daily(byday, status, since="2022-02-24")
    assert rows == [
        ("2022-02-24", 10, 7, 2, 1, 0, 9, 31.26),
        ("2022-02-25", 0, 0, 0, 0, 0, 0, None),
    ]


def test_join_all_dates_when_since_none():
    byday = {"2014-06-01": (3, 3, 33.0), "2022-02-24": (10, 9, 31.26)}
    rows = ingest.join_daily(byday, {}, since=None)
    assert [r[0] for r in rows] == ["2014-06-01", "2022-02-24"]


def test_date_iso_accepts_datetime_date_and_string():
    assert ingest._date_iso(datetime(2022, 2, 24, 5, 0)) == "2022-02-24"
    assert ingest._date_iso("2022-02-24") == "2022-02-24"
    assert ingest._date_iso("2022-02-24T00:00:00") == "2022-02-24"
    assert ingest._date_iso(None) is None
    assert ingest._date_iso("Date") is None  # a stray header echo


# ── build(): append-version semantics ─────────────────────────────────────────
def _rows(n, start_day=1, number=10):
    """n synthetic day-rows starting 2022-02-DD; all statuses = dead."""
    return [
        (f"2022-02-{start_day + i:02d}", number, number, 0, 0, 0, number, 30.0)
        for i in range(n)
    ]


def test_first_build_inserts_all_new(tmp_path, monkeypatch):
    monkeypatch.setattr(ingest, "MIN_ROWS_FLOOR", 3)
    db = tmp_path / "ua-losses.db"
    s = ingest.build(db, _rows(5), "2026-08-19T00:00:00+00:00")
    assert (s["new"], s["revised"], s["unchanged"], s["distinct"]) == (5, 0, 0, 5)


def test_rerun_identical_inserts_nothing(tmp_path, monkeypatch):
    monkeypatch.setattr(ingest, "MIN_ROWS_FLOOR", 3)
    db = tmp_path / "ua-losses.db"
    ingest.build(db, _rows(5), "2026-08-19T00:00:00+00:00")
    s = ingest.build(db, _rows(5), "2026-08-20T00:00:00+00:00")
    assert (s["new"], s["revised"], s["unchanged"]) == (0, 0, 5)


def test_revision_appends_new_version_not_overwrite(tmp_path, monkeypatch):
    monkeypatch.setattr(ingest, "MIN_ROWS_FLOOR", 3)
    db = tmp_path / "ua-losses.db"
    ingest.build(db, _rows(5), "2026-08-19T00:00:00+00:00")
    # A backfill bumps day 3's number 10 -> 12, and adds a new day.
    revised = _rows(5)
    revised[2] = ("2022-02-03", 12, 12, 0, 0, 0, 12, 30.0)
    revised.append(("2022-02-06", 4, 4, 0, 0, 0, 4, 29.0))
    s = ingest.build(db, revised, "2026-08-20T00:00:00+00:00")
    assert (s["new"], s["revised"], s["unchanged"], s["distinct"]) == (1, 1, 4, 6)

    import sqlite3
    conn = sqlite3.connect(db)
    try:
        # Both versions of day 3 are preserved (append-only).
        versions = conn.execute(
            "SELECT number FROM daily_losses WHERE date='2022-02-03' ORDER BY scraped_at"
        ).fetchall()
        assert [v[0] for v in versions] == [10, 12]
    finally:
        conn.close()


def test_floor_guard_aborts_without_writing(tmp_path):
    db = tmp_path / "ua-losses.db"
    with pytest.raises(RuntimeError, match="floor"):
        ingest.build(db, _rows(2), "2026-08-19T00:00:00+00:00")  # < default floor 365
    assert not db.exists()


def test_no_shrink_guard_aborts(tmp_path, monkeypatch):
    monkeypatch.setattr(ingest, "MIN_ROWS_FLOOR", 3)
    db = tmp_path / "ua-losses.db"
    ingest.build(db, _rows(6), "2026-08-19T00:00:00+00:00")
    with pytest.raises(RuntimeError, match="shrinking"):
        ingest.build(db, _rows(4), "2026-08-20T00:00:00+00:00")
