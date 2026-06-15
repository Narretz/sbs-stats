#!/usr/bin/env python3
"""Tests for scripts/missile_attacks/ingest.py — run with: pytest scripts/missile_attacks

No network: everything goes through parse_rows() + build() on in-memory CSV text
and a temp SQLite file. Covers the append-on-edit versioning, idempotent re-runs,
the daily aggregate view, the header-drift guard, and the shrink guard.
"""
import sqlite3

import pytest

import ingest

# build()'s real floor is 1000 (a sane full dataset); these fixtures are tiny.
ingest.MIN_ROWS_FLOOR = 0

HEADER = "time_start,time_end,model,launched,destroyed,launch_place,target,source"

# Two models in one overnight attack (shared window), plus a same-day daytime row.
CSV_V1 = "\n".join(
    [
        HEADER,
        "2024-11-17 23:40:00,2024-11-18 07:10:00,Shahed-136/131,120,90,south,Kyiv,kpszsu/posts/a",
        "2024-11-17 23:40:00,2024-11-18 07:10:00,Kh-101/Kh-555,12,10,Caspian Sea,Kyiv,kpszsu/posts/a",
        "2024-11-20 09:00:00,2024-11-20 11:00:00,Iskander-M,3,0,Kursk,Sumy,kpszsu/posts/b",
    ]
)


def _build(tmp_path, csv_text, name="t.db"):
    header, rows = ingest.parse_rows(csv_text)
    return ingest.build(tmp_path / name, header, rows)


def test_initial_insert_and_daily_view(tmp_path):
    inserted, distinct, latest = _build(tmp_path, CSV_V1)
    assert inserted == 3
    assert distinct == 3  # three distinct natural keys
    assert latest == "2024-11-20"

    conn = sqlite3.connect(tmp_path / "t.db")
    # attack_date is derived from time_start, so the overnight pair lands on the 17th.
    daily = dict(conn.execute("SELECT date, launched FROM daily_totals").fetchall())
    assert daily["2024-11-17"] == 132  # 120 + 12, one window two models
    assert daily["2024-11-20"] == 3
    conn.close()


def test_idempotent_rerun_adds_nothing(tmp_path):
    _build(tmp_path, CSV_V1)
    inserted, _, _ = _build(tmp_path, CSV_V1)
    assert inserted == 0


def test_edit_appends_new_version_and_latest_wins(tmp_path):
    _build(tmp_path, CSV_V1)
    # piterfm revises the Shahed 'destroyed' count for that attack: 90 -> 105.
    corrected = CSV_V1.replace(
        "2024-11-17 23:40:00,2024-11-18 07:10:00,Shahed-136/131,120,90,south,Kyiv,kpszsu/posts/a",
        "2024-11-17 23:40:00,2024-11-18 07:10:00,Shahed-136/131,120,105,south,Kyiv,kpszsu/posts/a",
    )
    inserted, distinct, _ = _build(tmp_path, corrected)
    assert inserted == 1  # only the changed row
    assert distinct == 3  # still three keys

    conn = sqlite3.connect(tmp_path / "t.db")
    # Both versions retained in the base table...
    assert conn.execute("SELECT COUNT(*) FROM missile_attacks").fetchone()[0] == 4
    # ...but the latest view shows the corrected value.
    got = conn.execute(
        "SELECT destroyed FROM missile_attacks_latest "
        "WHERE model = 'Shahed-136/131'"
    ).fetchone()[0]
    assert got == 105
    conn.close()


def test_float_formatted_counts(tmp_path):
    # pandas serializes int columns containing NaNs as floats ("600.0"), and a
    # missing count comes through empty — both must ingest cleanly.
    csv_text = "\n".join(
        [
            HEADER,
            "2024-12-01 22:00:00,2024-12-02 06:00:00,Shahed-136/131,600.0,580.0,south,Kyiv,kpszsu/posts/c",
            "2024-12-01 22:00:00,2024-12-02 06:00:00,Kh-101/Kh-555,,,Caspian Sea,Kyiv,kpszsu/posts/c",
        ]
    )
    _build(tmp_path, csv_text)
    conn = sqlite3.connect(tmp_path / "t.db")
    launched = conn.execute(
        "SELECT launched FROM missile_attacks_latest WHERE model = 'Shahed-136/131'"
    ).fetchone()[0]
    assert launched == 600  # stored as INTEGER, not 600.0
    missing = conn.execute(
        "SELECT launched FROM missile_attacks_latest WHERE model = 'Kh-101/Kh-555'"
    ).fetchone()[0]
    assert missing is None
    conn.close()


def test_source_disambiguates_same_day_same_model(tmp_path):
    # Real-data case: same date+model+target, different command posts → distinct
    # rows that must both persist (this is why `source` is in the key).
    csv_text = "\n".join(
        [
            HEADER,
            "2025-05-21,2025-05-21,Orlan-10,1,1,,south,PvKPivden/posts/x",
            "2025-05-21,2025-05-21,Orlan-10,5,5,,south,PvKPivden/posts/y",
        ]
    )
    inserted, distinct, _ = _build(tmp_path, csv_text)
    assert inserted == 2
    assert distinct == 2
    conn = sqlite3.connect(tmp_path / "t.db")
    total = conn.execute("SELECT launched FROM daily_totals WHERE date='2025-05-21'").fetchone()[0]
    assert total == 6  # 1 + 5, both reports counted
    conn.close()


def test_duplicate_key_within_download_aborts(tmp_path):
    # If two rows are identical on the FULL key (incl. source), the key is
    # insufficient — abort loudly rather than emit a raw IntegrityError.
    csv_text = "\n".join(
        [
            HEADER,
            "2025-05-21,2025-05-21,Orlan-10,1,1,,south,PvKPivden/posts/x",
            "2025-05-21,2025-05-21,Orlan-10,5,5,,south,PvKPivden/posts/x",
        ]
    )
    with pytest.raises(RuntimeError, match="duplicate natural key"):
        _build(tmp_path, csv_text)


@pytest.mark.parametrize(
    "model, expected",
    [
        ("Shahed-136/131", "drone"),
        ("Orlan-10 and ZALA and Supercam", "drone"),
        ("X-101/X-555", "cruise"),
        ("X-101/X-555 and Kalibr", "cruise"),
        ("Iskander-M", "ballistic"),
        ("X-47 Kinzhal", "ballistic"),
        ("Iskander-M and Iskander-K", "ballistic"),  # cruise+ballistic → ballistic
        ("GBU", "other"),
        ("Totally New Weapon", "other"),  # unmapped → other
    ],
)
def test_classify(model, expected):
    cat, _ = ingest.classify(model)
    assert cat == expected


def test_classify_reports_unmapped():
    _, unk = ingest.classify("Shahed-136/131 and Mystery-9000")
    assert unk == ["Mystery-9000"]


def test_daily_by_category_view(tmp_path):
    csv_text = "\n".join(
        [
            HEADER,
            # one night: drones + cruise + ballistic, same window/source
            "2025-01-10 20:00:00,2025-01-11 06:00:00,Shahed-136/131,100,80,south,Kyiv,kpszsu/posts/n",
            "2025-01-10 20:00:00,2025-01-11 06:00:00,Kalibr,8,6,Black Sea,Kyiv,kpszsu/posts/n",
            "2025-01-10 20:00:00,2025-01-11 06:00:00,Iskander-M,4,1,Kursk,Kyiv,kpszsu/posts/n",
        ]
    )
    _build(tmp_path, csv_text)
    conn = sqlite3.connect(tmp_path / "t.db")
    got = dict(
        (cat, (l, d))
        for cat, l, d in conn.execute(
            "SELECT category, launched, destroyed FROM daily_by_category WHERE date='2025-01-10'"
        )
    )
    assert got == {"drone": (100, 80), "cruise": (8, 6), "ballistic": (4, 1)}
    conn.close()


def test_model_casing_is_canonicalized(tmp_path):
    # piterfm sometimes flips casing on a known model; the natural key must stay
    # stable so a re-ingest doesn't create an orphan row.
    canonical = "\n".join([HEADER,
        "2025-03-01 02:00:00,2025-03-01 03:00:00,Intercontinental Ballistic Missile,1,0,Kapustin Yar,Kyiv,kpszsu/posts/x"])
    flipped = "\n".join([HEADER,
        "2025-03-01 02:00:00,2025-03-01 03:00:00,intercontinental ballistic MISSILE,1,0,Kapustin Yar,Kyiv,kpszsu/posts/x"])
    inserted1, distinct1, _ = _build(tmp_path, canonical)
    inserted2, distinct2, _ = _build(tmp_path, flipped)
    assert (inserted1, distinct1) == (1, 1)
    assert (inserted2, distinct2) == (0, 1)  # same key after normalization
    conn = sqlite3.connect(tmp_path / "t.db")
    models = [r[0] for r in conn.execute("SELECT model FROM missile_attacks")]
    assert models == ["Intercontinental Ballistic Missile"]
    conn.close()


def test_header_drift_aborts(tmp_path):
    bad = "time_start,model,launched\n2024-11-17 23:40:00,Shahed,120"  # no destroyed/time_end/source
    with pytest.raises(RuntimeError, match="missing required columns"):
        _build(tmp_path, bad)


def test_shrink_guard_aborts(tmp_path):
    _build(tmp_path, CSV_V1)
    shrunk = "\n".join(CSV_V1.splitlines()[:2])  # header + 1 row (2 keys gone, tol 1)
    with pytest.raises(RuntimeError, match="shrinking dataset"):
        _build(tmp_path, shrunk)


def test_small_shrink_within_tolerance_warns(tmp_path, monkeypatch, capsys):
    # A 1-key drop on a large stored set is within tolerance (e.g. upstream
    # normalized casing of a key column) — should warn and proceed.
    monkeypatch.setattr(ingest, "SHRINK_TOLERANCE_ABS", 20)
    monkeypatch.setattr(ingest, "SHRINK_TOLERANCE_FRAC", 0.5)  # tiny fixture
    _build(tmp_path, CSV_V1)
    shrunk = "\n".join(CSV_V1.splitlines()[:3])  # header + 2 rows (1 key gone)
    inserted, distinct, _ = _build(tmp_path, shrunk)
    assert inserted == 0  # nothing new
    assert distinct == 3  # orphan remains in DB
    assert "within tolerance" in capsys.readouterr().err
