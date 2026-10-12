"""
Unit tests for the Mediazona bundle parser (scripts/mediazona/ingest.py).

These lock in the blob-shape detection, which is the part that keeps breaking:
Mediazona re-encodes its chart data without notice and the ingest identifies
every blob by shape rather than by index. The Aug-2026 release wrapped the
roles blob and run-length-encoded its day series (see `_find_roles_blob`), so
both that encoding and the flat pre-Aug-2026 one are exercised here.

Run with: pytest -v test_ingest.py   (from scripts/mediazona/)
"""
import pytest

import ingest as ig


N_ROLES = len(ig.BLOB5_COLUMN_MAP)


def _flat_blob(n_days: int = 14) -> dict:
    """Pre-Aug-2026 shape: one equal-length int list per role index."""
    return {str(i): [i + 1] * n_days for i in range(N_ROLES)}


def _wrapped_blob(n_days: int = 14, years=(2023, 2024)) -> dict:
    """Aug-2026 shape: {years, days, dates}, each role a run-length-encoded
    series per cohort year. Encodes `[i+1, 0 × (n_days-2), i+1]` per cohort, so
    each role's summed daily series totals 2 * len(years) * (i + 1)."""
    return {
        "years": list(years),
        "days": n_days,
        "dates": {
            str(i): [[i + 1, -(n_days - 2), i + 1] for _ in years]
            for i in range(N_ROLES)
        },
    }


class TestRolesBlobDetection:
    def test_flat_blob_passes_through(self):
        blob = _flat_blob()
        out = ig._find_roles_blob([{"noise": 1}, blob])
        assert out == blob

    def test_wrapped_blob_is_flattened(self):
        out = ig._find_roles_blob([[1, 2, 3], _wrapped_blob()])
        assert sorted(out, key=int) == [str(i) for i in range(N_ROLES)]
        assert all(len(v) == 14 for v in out.values())
        # zeros expanded, cohorts summed elementwise
        assert out["0"] == [2] + [0] * 12 + [2]
        assert sum(out["3"]) == 2 * 2 * 4

    def test_wrapped_blob_survives_a_new_cohort_year(self):
        # Mediazona adds one series per year; the count must not be hardcoded.
        out = ig._find_roles_blob([_wrapped_blob(years=(2023, 2024, 2025, 2026))])
        assert sum(out["0"]) == 2 * 4 * 1

    def test_no_roles_blob_raises(self):
        with pytest.raises(RuntimeError, match="no roles blob"):
            ig._find_roles_blob([{"a": [1]}, [1, 2, 3], "x"])

    def test_cohort_count_mismatch_aborts(self):
        # A `dates` entry that disagrees with `years` means the wrapper changed
        # again — abort rather than silently sum the wrong number of cohorts.
        blob = _wrapped_blob(years=(2023, 2024))
        blob["dates"]["5"] = [[1, -12, 1]]
        with pytest.raises(RuntimeError, match="cohorts but the blob"):
            ig._find_roles_blob([blob])


class TestRunLengthDecode:
    def test_negative_runs_expand_to_zeros(self):
        assert ig._decode_rle([3, -4, 1, -2], 8) == [3, 0, 0, 0, 0, 1, 0, 0]

    def test_dense_series_is_unchanged(self):
        assert ig._decode_rle([1, 2, 0, 3], 4) == [1, 2, 0, 3]

    def test_wrong_length_aborts(self):
        with pytest.raises(RuntimeError, match="expands to 5 days, expected 8"):
            ig._decode_rle([3, -4], 8)

    def test_non_int_aborts(self):
        with pytest.raises(RuntimeError, match="non-int value"):
            ig._decode_rle([1, 2.5, 1], 3)


class TestOtherBlobDetection:
    def test_estimate_blob_found_by_key_set(self):
        blob = [{"w": "24.02.2022", "rnd": 1.0, "real": 1}]
        assert ig._find_estimate_blob([{"x": 1}, blob]) is blob

    def test_summary_blob_found_by_key_set(self):
        blob = [{"k": "нет данных", "o": 720, "v": 53884}]
        assert ig._find_roles_summary_blob([[{"w": 1}], blob]) is blob


class TestWeeklyAggregation:
    def test_days_bucket_into_thursday_anchored_weeks(self):
        daily = {str(i): [1] * 15 for i in range(N_ROLES)}
        rows = ig._aggregate_roles_blob_to_rows(daily)
        assert [r[0] for r in rows] == ["2022-02-24", "2022-03-03", "2022-03-10"]
        # full weeks: 7 days × 1 per role; trailing partial week: 1 day
        assert rows[0][1] == 7 * N_ROLES          # `total` column
        assert rows[-1][1] == 1 * N_ROLES

    def test_column_count_mismatch_aborts(self):
        with pytest.raises(RuntimeError, match="re-validate the column mapping"):
            ig._aggregate_roles_blob_to_rows({str(i): [1] * 7 for i in range(5)})


def _named_summary(totals: dict[str, int]) -> list[dict]:
    """A summary blob with one entry per role, by its Russian name; `other`
    becomes "другие войска"."""
    out = [{"k": ig.SUMMARY_NAMES.get(c, "другие войска"), "o": 1, "v": v}
           for c, v in totals.items()]
    return out


class TestDriftGuard:
    TOTALS = {c: 1000 + 100 * i for i, c in enumerate(ig.BLOB5_COLUMN_MAP)}

    def _daily(self, share: float, cmap=ig.BLOB5_COLUMN_MAP, totals=None):
        totals = totals or self.TOTALS
        return {str(i): [round(totals[c] * share)] for i, c in enumerate(cmap)}

    def test_matching_roles_pass_at_any_dated_share(self):
        # The roles blob counts only dated deaths: 82% of the summary in 2023,
        # 97% in 2026. Both are the same match.
        for share in (0.82, 0.97):
            ig._check_blob5_drift(self._daily(share), _named_summary(self.TOTALS))

    def test_nd_may_run_lower(self):
        daily = self._daily(0.9)
        daily[str(ig.BLOB5_COLUMN_MAP.index("nd"))] = [round(self.TOTALS["nd"] * 0.6)]
        ig._check_blob5_drift(daily, _named_summary(self.TOTALS))

    def test_swapped_columns_abort(self):
        totals = dict(self.TOTALS, vol=40000, inmates=16000)
        daily = self._daily(0.9, totals=totals)
        v, m = str(ig.BLOB5_COLUMN_MAP.index("vol")), str(ig.BLOB5_COLUMN_MAP.index("rifle"))
        daily[v], daily[m] = daily[m], daily[v]
        with pytest.raises(RuntimeError, match="drift"):
            ig._check_blob5_drift(daily, _named_summary(totals))

    def test_missing_category_aborts(self):
        summary = [r for r in _named_summary(self.TOTALS) if r["k"] != "ЧВК"]
        with pytest.raises(RuntimeError, match="lacks the categories"):
            ig._check_blob5_drift(self._daily(0.9), summary)

    def test_mojibake_names_are_read(self):
        # The bundle's names arrive as UTF-8 read as Latin-1.
        summary = [dict(r, k=r["k"].encode("utf-8").decode("latin-1"))
                   for r in _named_summary(self.TOTALS)]
        ig._check_blob5_drift(self._daily(0.9), summary)

    def test_20_role_layout_folds_groundavia_into_other(self):
        # Before 12/2024 there was no groundavia role; the summary already
        # listed it, under "(другие войска)", and the roles blob counted it in
        # `other`.
        cmap = ig.BLOB5_COLUMN_MAP_20
        totals = {c: self.TOTALS[c] for c in cmap}
        summary = _named_summary(totals) + [
            {"k": "наземные авиаслужбы (другие войска)", "o": 1, "v": 300}]
        daily = self._daily(0.9, cmap=cmap, totals=dict(totals, other=totals["other"] + 300))
        ig._check_blob5_drift(daily, summary)


class TestTwentyRoleLayout:
    def test_column_map_by_role_count(self):
        assert ig.column_map({str(i): [0] for i in range(21)}) == ig.BLOB5_COLUMN_MAP
        assert ig.column_map({str(i): [0] for i in range(20)}) == ig.BLOB5_COLUMN_MAP_20
        with pytest.raises(RuntimeError, match="re-validate"):
            ig.column_map({str(i): [0] for i in range(19)})

    def test_groundavia_is_zero_and_later_roles_shift(self):
        daily = {str(i): [i + 1] * 7 for i in range(20)}
        [row] = ig._aggregate_roles_blob_to_rows(daily)
        cols = dict(zip(["week", *ig.ROLE_COLS], row))
        assert cols["groundavia"] == 0
        assert cols["pmc"] == 7 * (ig.BLOB5_COLUMN_MAP_20.index("pmc") + 1)
        assert cols["inmates"] == 7 * 20


class TestPublishedAt:
    META = [{"w": "current_date", "rnd": "x", "real": "10.10.2025"}]

    def test_series_length_dates_a_release_without_metadata(self):
        assert ig._published_at(None, 379) == "2023-03-10"

    def test_metadata_wins_within_a_day(self):
        # 1323 days runs to 09/10; the article says 10/10.
        assert ig._published_at(self.META, 1323) == "2025-10-10"

    def test_series_wins_over_a_stale_date(self):
        # A mid-cycle rebuild that extended the data but kept the old date.
        assert ig._published_at(self.META, 1339) == "2025-10-25"


def _roles(weeks: int, value: int = 1) -> list[tuple]:
    return [(f"w{i:03d}", *[value] * len(ig.ROLE_COLS)) for i in range(weeks)]


def _estimate(weeks: int, value: int = 1) -> list[tuple]:
    return [(f"w{i:03d}", value, float(value)) for i in range(weeks)]


def _latest(db, table, col):
    import sqlite3
    conn = sqlite3.connect(db)
    try:
        return dict(conn.execute(
            f"SELECT week, {col} FROM {ig.latest_per_week(table)}").fetchall())
    finally:
        conn.close()


class TestBuildOrder:
    """Releases arrive out of order: the backfill adds old ones after the live
    ingest stored newer ones."""

    PUB_OLD, PUB_NEW = "2024-03-01", "2026-05-22"

    def test_an_older_release_never_becomes_latest(self, tmp_path):
        db = tmp_path / "m.db"
        ig.build(db, _roles(120, 5), _estimate(120, 5), "2026-05-28T00:00:00+00:00", self.PUB_NEW)
        ig.build(db, _roles(110, 3), _estimate(110, 3), "2026-10-12T00:00:00+00:00", self.PUB_OLD)
        assert set(_latest(db, "weekly_roles", "total").values()) == {5}
        assert set(_latest(db, "weekly_estimate", "documented").values()) == {5}

    def test_an_older_release_is_compared_with_the_one_before_it(self, tmp_path):
        db = tmp_path / "m.db"
        ig.build(db, _roles(120, 5), _estimate(120, 5), "2026-05-28T00:00:00+00:00", self.PUB_NEW)
        ig.build(db, _roles(100, 3), _estimate(100, 3), "2024-02-10T00:00:00+00:00", "2024-02-09")
        # Same values as the release before it: nothing stored, though they
        # differ from the newest release.
        r, e = ig.build(db, _roles(100, 3), _estimate(100, 3), "2024-03-02T00:00:00+00:00", self.PUB_OLD)
        assert (r["new"], r["revised"], e["new"], e["revised"]) == (0, 0, 0, 0)

    def test_a_release_without_the_estimate_leaves_that_table_alone(self, tmp_path):
        db = tmp_path / "m.db"
        r, e = ig.build(db, _roles(60), None, "2023-03-11T00:00:00+00:00", "2023-03-10")
        assert r["new"] == 60 and e["new"] == 0 and e["distinct"] == 0

    def test_the_floor_scales_with_the_release(self, tmp_path):
        ig.build(tmp_path / "a.db", _roles(55), None, "2023-03-11T00:00:00+00:00", "2023-03-10")
        with pytest.raises(RuntimeError, match="floor"):
            ig.build(tmp_path / "b.db", _roles(55), None, "2026-10-10T00:00:00+00:00", "2026-10-09")


class TestDroppedWeek:
    def test_a_dropped_estimate_week_is_stored_empty(self, tmp_path):
        db = tmp_path / "m.db"
        ig.build(db, _roles(120), _estimate(120), "2026-04-11T00:00:00+00:00", "2026-04-10")
        r, e = ig.build(db, _roles(121), _estimate(119), "2026-04-25T00:00:00+00:00", "2026-04-24")
        assert e["removed"] == 1
        assert _latest(db, "weekly_estimate", "documented")["w119"] is None
        # …once: the next release doesn't re-remove it.
        r, e = ig.build(db, _roles(122), _estimate(119), "2026-05-10T00:00:00+00:00", "2026-05-09")
        assert e["removed"] == 0

    def test_dropping_more_than_two_weeks_aborts(self, tmp_path):
        db = tmp_path / "m.db"
        ig.build(db, _roles(120), _estimate(120), "2026-04-11T00:00:00+00:00", "2026-04-10")
        with pytest.raises(RuntimeError, match="shrinking"):
            ig.build(db, _roles(121), _estimate(117), "2026-04-25T00:00:00+00:00", "2026-04-24")
