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


class TestDriftGuard:
    def _summary(self, totals):
        return [{"k": f"cat{i}", "o": 1, "v": v} for i, v in enumerate(totals)]

    def test_matching_totals_pass(self):
        daily = {"0": [100], "1": [200]}
        ig._check_blob5_drift(daily, self._summary([205, 99]))

    def test_two_unmatched_indices_abort(self):
        daily = {"0": [100], "1": [200], "2": [300]}
        with pytest.raises(RuntimeError, match="drift"):
            ig._check_blob5_drift(daily, self._summary([100]))
