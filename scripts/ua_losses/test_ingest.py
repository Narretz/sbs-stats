"""Unit tests for the ua_losses ingest — positional sheet parsing + append-version
+ guards. The sheet parsers take plain row iterables (header first), so no real
xlsx is needed. `build()` is exercised against a tmp sqlite file.
"""
from datetime import datetime

import pytest

import ingest


# ── positional sheet parsing (names churn across versions; positions don't) ────
def test_index_byday_reads_col1_regardless_of_header_name():
    # v1 used 'NumberDay', v12 'NumberHelp', v19 'Number' — all at column 1.
    rows = [
        ("Date", "NumberHelp", "AgeHelp", "MaleHelp"),
        (datetime(2022, 2, 24), 10, 3, 9),
        (datetime(2022, 2, 25), None, None, None),  # blank count → genuine 0
    ]
    idx = ingest.index_byday(rows)
    assert idx == {"2022-02-24": 10, "2022-02-25": 0}


def test_index_status_reads_four_positions_released_optional():
    with_released = [("Date", "Dead", "Missing", "Prisoner", "Released"),
                     (datetime(2022, 2, 24), 7, 2, 1, 3)]
    assert ingest.index_status(with_released)["2022-02-24"] == (7, 2, 1, 3)
    # Pre-Released versions (v12–v18): only three status columns → released 0.
    without = [("Date", "Dead", "Missing", "Prisoner"),
               (datetime(2022, 2, 24), 7, 2, 1)]
    assert ingest.index_status(without)["2022-02-24"] == (7, 2, 1, 0)


def test_join_uses_status_when_present_and_filters_since():
    byday = {"2022-02-23": 5, "2022-02-24": 10}
    status = {"2022-02-24": (7, 2, 1, 0)}
    rows = ingest.join_daily(byday, status, since="2022-02-24")
    assert rows == [("2022-02-24", 10, 7, 2, 1, 0)]  # pre-war 02-23 dropped


def test_join_falls_back_to_all_dead_when_no_status():
    # Deaths-only versions (v1–v11) have no ByDayStatus sheet → dead = number.
    byday = {"2022-03-01": 12}
    rows = ingest.join_daily(byday, {}, since=None)
    assert rows == [("2022-03-01", 12, 12, 0, 0, 0)]


def test_date_iso_accepts_datetime_date_and_string():
    assert ingest._date_iso(datetime(2022, 2, 24, 5, 0)) == "2022-02-24"
    assert ingest._date_iso("2022-02-24") == "2022-02-24"
    assert ingest._date_iso("2022-02-24T00:00:00") == "2022-02-24"
    assert ingest._date_iso(None) is None
    assert ingest._date_iso("Date") is None  # a stray header echo


# ── build(): append-version semantics ─────────────────────────────────────────
def _rows(n, start_day=1, number=10):
    """n synthetic day-rows starting 2022-02-DD; treated as all-dead."""
    return [
        (f"2022-02-{start_day + i:02d}", number, number, 0, 0, 0)
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


def test_reclassification_appends_new_version_not_overwrite(tmp_path, monkeypatch):
    monkeypatch.setattr(ingest, "MIN_ROWS_FLOOR", 3)
    db = tmp_path / "ua-losses.db"
    ingest.build(db, _rows(5), "2025-02-10T00:00:00+00:00")
    # A later snapshot reclassifies day 3: same total 10, but now 7 dead / 3 missing.
    revised = _rows(5)
    revised[2] = ("2022-02-03", 10, 7, 3, 0, 0)
    revised.append(("2022-02-06", 4, 4, 0, 0, 0))  # plus a newly-covered date
    s = ingest.build(db, revised, "2025-06-03T00:00:00+00:00")
    assert (s["new"], s["revised"], s["unchanged"], s["distinct"]) == (1, 1, 4, 6)

    import sqlite3
    conn = sqlite3.connect(db)
    try:
        # Both versions of day 3 are preserved (append-only) — the transition.
        versions = conn.execute(
            "SELECT dead, missing FROM daily_losses WHERE date='2022-02-03' ORDER BY scraped_at"
        ).fetchall()
        assert versions == [(10, 0), (7, 3)]
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
