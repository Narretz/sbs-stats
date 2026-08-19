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


def test_single_column_rename_orphan_excluded(tmp_path, monkeypatch, capsys):
    # Upstream renames one key column (here launch_place) on an existing attack.
    # The old key is orphaned in our append-only DB, but the download still
    # carries a sibling matching every *other* key column — so it must be
    # recognised as a normalization and excluded from the shrink guard, even
    # under the tightest tolerance (this abort would otherwise fire).
    monkeypatch.setattr(ingest, "SHRINK_TOLERANCE_ABS", 1)
    monkeypatch.setattr(ingest, "SHRINK_TOLERANCE_FRAC", 0.01)
    _build(tmp_path, CSV_V1)
    renamed = CSV_V1.replace("Caspian Sea", "Black Sea")  # Kh-101 row's launch_place
    inserted, distinct, _ = _build(tmp_path, renamed)
    assert inserted == 1  # the renamed key is a new version
    assert distinct == 4  # orphan (Caspian Sea) remains alongside the 3 fetched
    assert "single-column siblings" in capsys.readouterr().err


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


def test_upstream_added_column_migrates_existing_db(tmp_path, capsys):
    """piterfm grew the header (`status_data`, Aug 2026) — an existing DB built
    from the old header must gain the column instead of blowing up on it."""
    _build(tmp_path, CSV_V1)
    conn = sqlite3.connect(tmp_path / "t.db")
    assert "status_data" not in {
        r[1] for r in conn.execute("PRAGMA table_info(missile_attacks)")
    }
    conn.close()

    # Same three rows, one new trailing column — blank for the old rows.
    grown = "\n".join(
        line + ("," if i else ",status_data")
        for i, line in enumerate(CSV_V1.split("\n"))
    )
    inserted, distinct, _ = _build(tmp_path, grown)

    # Migration only: no values changed, so nothing is re-versioned.
    assert inserted == 0
    assert distinct == 3
    assert "added column(s) ['status_data']" in capsys.readouterr().err

    conn = sqlite3.connect(tmp_path / "t.db")
    cols = {r[1] for r in conn.execute("PRAGMA table_info(missile_attacks)")}
    assert "status_data" in cols
    # Pre-existing rows read as the blank cell the CSV carries, not NULL.
    assert conn.execute(
        "SELECT DISTINCT status_data FROM missile_attacks_latest"
    ).fetchall() == [("",)]
    conn.close()


def test_upstream_added_column_with_value_versions_the_row(tmp_path):
    """A populated new column is a real edit: the row gets a new version and the
    latest view returns the new value."""
    _build(tmp_path, CSV_V1)
    rows = CSV_V1.split("\n")
    grown = "\n".join(
        [rows[0] + ",status_data"]
        + [rows[1] + ",confirmed"]
        + [r + "," for r in rows[2:]]
    )
    inserted, distinct, _ = _build(tmp_path, grown)
    assert inserted == 1  # only the row that gained a value
    assert distinct == 3

    conn = sqlite3.connect(tmp_path / "t.db")
    got = dict(
        conn.execute(
            "SELECT model, status_data FROM missile_attacks_latest"
        ).fetchall()
    )
    assert got["Shahed-136/131"] == "confirmed"
    assert got["Iskander-M"] == ""
    conn.close()


# ── status_data='hidden': attacks reported without figures ────────────────────
# piterfm carries a placeholder 0 for a withheld count, so the raw row is
# indistinguishable from a real zero. The aggregate views resolve it: withheld
# rows contribute NULL (skipped by SUM) and are counted in `hidden`.
HEADER_STATUS = HEADER + ",status_data"

CSV_HIDDEN = "\n".join(
    [
        HEADER_STATUS,
        # disclosed: a real zero — nothing launched, and we were told so
        "2026-08-09 18:00:00,2026-08-10 09:00:00,Iskander-M,0,0,Kursk,Sumy,kpszsu/posts/a,",
        "2026-08-09 18:00:00,2026-08-10 09:00:00,Shahed-136/131,100,90,Kursk,Kyiv,kpszsu/posts/a,",
        # withheld: reported, figures not published — the 0s are placeholders
        "2026-08-10 18:00:00,2026-08-11 09:00:00,Iskander-M and 3M22 Zircon,0,0,Kursk,Kyiv,kpszsu/posts/b,hidden",
        "2026-08-10 18:00:00,2026-08-11 09:00:00,Shahed-136/131,200,180,Kursk,Kyiv,kpszsu/posts/b,",
    ]
)


def _rows(conn, sql):
    return conn.execute(sql).fetchall()


class TestWithheldCounts:
    def test_stored_row_keeps_the_placeholder_verbatim(self, tmp_path):
        # The table mirrors upstream — resolving the flag is the views' job, and
        # the append-only model forbids rewriting a stored row either way.
        _build(tmp_path, CSV_HIDDEN)
        conn = sqlite3.connect(tmp_path / "t.db")
        row = _rows(conn, "SELECT launched, destroyed, status_data FROM missile_attacks_latest "
                          "WHERE model = 'Iskander-M and 3M22 Zircon'")
        assert row == [(0, 0, "hidden")]
        conn.close()

    def test_withheld_reads_null_but_a_disclosed_zero_reads_zero(self, tmp_path):
        # The whole point: both carry a literal 0 in the table, and they must
        # not come out of the views looking the same.
        _build(tmp_path, CSV_HIDDEN)
        conn = sqlite3.connect(tmp_path / "t.db")
        by_cat = {
            (d, c): (l, x, h)
            for d, c, l, x, h in _rows(
                conn, "SELECT date, category, launched, destroyed, hidden FROM daily_by_category")
        }
        assert by_cat[("2026-08-09", "ballistic")] == (0, 0, 0)      # disclosed zero
        assert by_cat[("2026-08-10", "ballistic")] == (None, None, 1)  # withheld
        conn.close()

    def test_partial_day_keeps_the_disclosed_sum(self, tmp_path):
        # A day with one withheld category and one disclosed still totals the
        # disclosed part — a lower bound, flagged by `hidden`, not a blank.
        _build(tmp_path, CSV_HIDDEN)
        conn = sqlite3.connect(tmp_path / "t.db")
        totals = {d: (l, r, h) for d, l, r, h in
                  _rows(conn, "SELECT date, launched, rows, hidden FROM daily_totals")}
        assert totals["2026-08-10"] == (200, 2, 1)  # drones only; `rows` still counts both
        conn.close()

    def test_views_are_rebuilt_on_an_existing_db(self, tmp_path):
        # Regression guard for the silent no-op: the views are created by every
        # build, and `CREATE VIEW IF NOT EXISTS` would keep whatever definition
        # the file was first built with — so a change here would never reach a
        # DB that already exists (i.e. the one in R2). Build once with the old
        # shape in place, then confirm a rebuild replaces it.
        _build(tmp_path, CSV_HIDDEN)
        conn = sqlite3.connect(tmp_path / "t.db")
        conn.execute("DROP VIEW daily_by_category")
        conn.execute("CREATE VIEW daily_by_category AS SELECT 1 AS date, 2 AS category, "
                     "3 AS launched, 4 AS destroyed")
        conn.commit()
        conn.close()

        _build(tmp_path, CSV_HIDDEN)
        conn = sqlite3.connect(tmp_path / "t.db")
        cols = [d[0] for d in conn.execute("SELECT * FROM daily_by_category LIMIT 1").description]
        assert "hidden" in cols
        conn.close()

    def test_views_are_valid_without_the_column(self, tmp_path):
        # A DB built before piterfm added `status_data` must still get views.
        _build(tmp_path, CSV_V1, name="old.db")
        conn = sqlite3.connect(tmp_path / "old.db")
        assert _rows(conn, "SELECT hidden FROM daily_by_category WHERE date='2024-11-20'") == [(0,)]
        conn.close()


# ── CI visibility when the upstream header grows ──────────────────────────────
# Migrating a new column is only half the job — someone has to look at what it
# means. `status_data` was migrated silently in Aug 2026 and nobody looked until
# its placeholder 0s had been charted as real zeros. These lock in that the run
# says so out loud, and that it stays quiet outside Actions.
class TestHeaderGrowthAnnotation:
    # Same rows as CSV_V1 with one column appended — the shrink guard rejects a
    # download that drops keys, so header growth has to be tested on its own.
    CSV_GROWN = "\n".join(
        [CSV_V1.splitlines()[0] + ",status_data"]
        + [line + ("," if i else ",hidden")
           for i, line in enumerate(CSV_V1.splitlines()[1:])]
    )

    def _grow(self, tmp_path, monkeypatch, capsys, **env):
        _build(tmp_path, CSV_V1)  # DB exists with the old header
        for k, v in env.items():
            monkeypatch.setenv(k, v)
        capsys.readouterr()
        _build(tmp_path, self.CSV_GROWN)
        return capsys.readouterr()

    def test_emits_a_workflow_warning_in_actions(self, tmp_path, monkeypatch, capsys):
        out = self._grow(tmp_path, monkeypatch, capsys, GITHUB_ACTIONS="true")
        line = next((l for l in out.out.splitlines() if l.startswith("::")), None)
        assert line is not None, "no workflow command emitted"
        assert line.startswith("::warning title=piterfm added a CSV column::")
        assert "status_data" in line
        # Workflow commands are parsed per line — a literal newline would
        # truncate the annotation at the break.
        assert "\n" not in line

    def test_writes_a_job_summary_block(self, tmp_path, monkeypatch, capsys):
        summary = tmp_path / "summary.md"
        summary.write_text("")
        self._grow(tmp_path, monkeypatch, capsys,
                   GITHUB_ACTIONS="true", GITHUB_STEP_SUMMARY=str(summary))
        text = summary.read_text()
        assert "piterfm added a CSV column" in text
        assert "status_data" in text

    def test_silent_outside_actions(self, tmp_path, monkeypatch, capsys):
        monkeypatch.delenv("GITHUB_ACTIONS", raising=False)
        out = self._grow(tmp_path, monkeypatch, capsys)
        assert "::" not in out.out
        assert "upstream header grew" in out.err  # the plain note still prints

    def test_no_annotation_when_the_header_is_unchanged(self, tmp_path, monkeypatch, capsys):
        _build(tmp_path, CSV_V1)
        monkeypatch.setenv("GITHUB_ACTIONS", "true")
        capsys.readouterr()
        _build(tmp_path, CSV_V1)
        assert "::warning" not in capsys.readouterr().out

    def test_no_annotation_on_a_first_build(self, tmp_path, monkeypatch, capsys):
        # A fresh DB gets every column from CREATE TABLE, so nothing is "added" —
        # a new dataset must not look like upstream drift.
        monkeypatch.setenv("GITHUB_ACTIONS", "true")
        capsys.readouterr()
        _build(tmp_path, CSV_V1, name="fresh.db")
        assert "::warning" not in capsys.readouterr().out
