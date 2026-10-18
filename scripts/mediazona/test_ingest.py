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


class TestAppCopy:
    """app_db.sql keeps only each week's latest version — what the app reads.
    Held to the full DB's latest view, the ordering the app uses on it."""

    def test_app_copy_is_the_latest_view(self, tmp_path):
        import shutil
        import sqlite3
        from pathlib import Path

        db = tmp_path / "m.db"
        ig.build(db, _roles(120, 5), _estimate(120, 5), "2026-05-28T00:00:00+00:00", "2026-05-22")
        # a dropped week, then a backfilled older release ingested afterwards
        ig.build(db, _roles(121, 6), _estimate(119, 6), "2026-06-06T00:00:00+00:00", "2026-06-05")
        ig.build(db, _roles(110, 3), _estimate(110, 3), "2026-10-12T00:00:00+00:00", "2024-03-01")

        app = tmp_path / "m.app.db"
        shutil.copy(db, app)
        conn = sqlite3.connect(app)
        conn.executescript((Path(ig.__file__).parent / "app_db.sql").read_text())
        conn.commit()
        conn.close()

        def view(path):
            c = sqlite3.connect(path)
            try:
                roles = c.execute(
                    f"SELECT week, total FROM {ig.latest_per_week('weekly_roles')} ORDER BY week").fetchall()
                est = c.execute(
                    f"SELECT week, documented FROM {ig.latest_per_week('weekly_estimate')} "
                    "WHERE documented IS NOT NULL OR estimate IS NOT NULL ORDER BY week").fetchall()
                rows = c.execute("SELECT (SELECT COUNT(*) FROM weekly_roles), "
                                 "(SELECT COUNT(*) FROM weekly_estimate)").fetchone()
                return roles, est, rows
            finally:
                c.close()

        full, small = view(db), view(app)
        assert small[:2] == full[:2]
        assert small[2] == (121, 119)  # one row per week, the dropped one gone


def _releases(db):
    import sqlite3
    conn = sqlite3.connect(db)
    try:
        return conn.execute(
            "SELECT published_at, scraped_at, source, bundle_url, note FROM releases "
            "ORDER BY published_at, scraped_at").fetchall()
    finally:
        conn.close()


class TestReleasesProvenance:
    PROV = {"source": "live", "article_url": "https://en.zona.media/a",
            "bundle_url": "https://s3.zona.media/infographics/bodycount/main.ab.js.br"}

    def test_a_run_that_stores_records_its_source(self, tmp_path):
        db = tmp_path / "m.db"
        ig.build(db, _roles(120), _estimate(120), "2026-10-09T14:20:52+00:00", "2026-10-09", self.PROV)
        assert _releases(db) == [("2026-10-09", "2026-10-09T14:20:52+00:00", "live",
                                  self.PROV["bundle_url"], None)]

    def test_a_run_that_stores_nothing_records_nothing(self, tmp_path):
        db = tmp_path / "m.db"
        ig.build(db, _roles(120), _estimate(120), "2026-10-09T14:20:52+00:00", "2026-10-09", self.PROV)
        ig.build(db, _roles(120), _estimate(120), "2026-10-12T07:00:00+00:00", "2026-10-09", self.PROV)
        assert len(_releases(db)) == 1

    def test_without_provenance_it_is_csv(self, tmp_path):
        db = tmp_path / "m.db"
        ig.build(db, _roles(120), _estimate(120), "2026-05-28T08:23:05+00:00", "2026-05-22")
        assert _releases(db)[0][2] == "csv"


class TestFillReleases:
    """backfill.fill_releases: provenance for versions stored before `releases`."""

    BUNDLES = [  # (published_at, capture in scraped_at form, bundle)
        ("2025-10-10", "2025-10-10T15:55:03+00:00", "main.aa.js.gz"),
        ("2026-05-23", "2026-05-22T21:23:01+00:00", "main.bb.js.gz"),
        ("2026-10-09", "2026-10-09T14:32:55+00:00", "main.cc.js.br"),
    ]

    def _db(self, tmp_path):
        import sqlite3
        db = tmp_path / "m.db"
        for i, (pub, scraped) in enumerate((
                ("2025-10-10", "2025-10-10T15:55:03+00:00"),    # backfilled
                ("2026-05-22", "2026-05-28T08:23:05+00:00"),    # CSV, a day off
                ("2026-10-09", "2026-10-09T14:20:52+00:00"),    # live, captured after
                ("2026-11-06", "2026-11-07T07:00:00+00:00"))):  # nothing listed
            ig.build(db, _roles(130), _estimate(130, i + 1), scraped, pub)
        conn = sqlite3.connect(db)
        conn.execute("DELETE FROM releases")  # as before the table existed
        conn.commit()
        conn.close()
        return db

    def test_each_kind_of_version_is_matched(self, tmp_path):
        import backfill
        db = self._db(tmp_path)
        assert backfill.fill_releases(db, self.BUNDLES) == 4
        got = {r[0]: r for r in _releases(db)}
        assert got["2025-10-10"][2:4] == ("wayback", backfill.S3 + "main.aa.js.gz")
        # Wayback captured the live bundle minutes after the ingest: still matched
        assert got["2026-10-09"][2:4] == ("live", backfill.S3 + "main.cc.js.br")
        # a bundle a day off is named, but not claimed
        assert got["2026-05-22"][2:4] == ("unknown", backfill.S3 + "main.bb.js.gz")
        assert got["2026-11-06"][2:4] == ("unknown", None)
        assert all("not recorded at ingest" in r[4] or "releases.csv" in r[4] for r in got.values())

    def test_filling_twice_adds_nothing(self, tmp_path):
        import backfill
        db = self._db(tmp_path)
        backfill.fill_releases(db, self.BUNDLES)
        assert backfill.fill_releases(db, self.BUNDLES) == 0


PAGE = """<html><head><meta property="og:title" content="Russian casualties in Ukraine. Mediazona count, updated">
<meta property="og:description" content="Over 5 801 deaths confirmed by August 25"></head>
<body><nav>menu</nav><h1>Russian casualties</h1><p>Last update to the named list: October 9, 2026.</p>
<p>Last update to the Probate Registry estimate: May 9, 2026; estimate as of late December 2025</p>
<script src="https://s3.zona.media/infographics/bodycount/main.1388a5a2a670aa5e8770.js.br"></script>
<footer>footer</footer></body></html>"""


class TestArticleParsing:
    def test_dates_with_and_without_a_year(self):
        assert ig._date_in("Last update: October 9, 2026", "2026-10-10") == "2026-10-09"
        assert ig._date_in("9 октября 2026 года", "2026-10-10") == "2026-10-09"
        assert ig._date_in("Over 5 801 deaths confirmed by August 25", "2022-08-30T10:00:00") == "2022-08-25"
        # no year, and the date would be after the capture: last year's
        assert ig._date_in("на 29 декабря", "2023-01-05") == "2022-12-29"

    def test_counts(self):
        assert ig._count_in("Over 5 801 deaths confirmed") == 5801
        assert ig._count_in("Over 7,180 deaths") == 7180
        assert ig._count_in("Больше 6,2 тысяч смертей") == 6200
        assert ig._count_in("Как минимум 2099 смертей на 6 мая") == 2099

    def test_page(self):
        import zlib
        a = ig.parse_article(PAGE, "https://en.zona.media/article/2026/10/09/casualties_eng-trl",
                             "2026-10-09T14:32:55+00:00", "wayback")
        assert a["lang"] == "en" and a["url_date"] == "2026-10-09"
        assert a["bundle_url"].endswith("main.1388a5a2a670aa5e8770.js.br")
        assert (a["headline_count"], a["headline_date"]) == (5801, "2026-08-25")
        assert (a["list_updated"], a["estimate_updated"]) == ("2026-10-09", "2026-05-09")
        assert "menu" not in a["text"] and "footer" not in a["text"]  # h1 to footer
        assert zlib.decompress(a["html"]).decode() == PAGE
        ru = ig.parse_article(PAGE, ig.RU_ARTICLE_URL, "2026-10-09T14:32:55+00:00", "live")
        assert ru["lang"] == "ru" and ru["url_date"] is None


class TestFillArticles:
    def test_pages_are_stored_once_and_releases_get_their_article(self, tmp_path, monkeypatch):
        import sqlite3
        import backfill
        db = tmp_path / "m.db"
        bundle = "main.1388a5a2a670aa5e8770.js.br"
        ig.build(db, _roles(130), _estimate(130), "2026-10-09T14:20:52+00:00", "2026-10-09",
                 {"source": "live", "bundle_url": backfill.S3 + bundle})
        monkeypatch.setattr(backfill, "article_page", lambda ts, url: PAGE)
        listed = [{"captured": "20261009143255", "bundle": bundle,
                   "article_en": "https://en.zona.media/article/2026/10/09/casualties_eng-trl",
                   "article_en_captured": "20261009150000",
                   "article_ru": ig.RU_ARTICLE_URL, "article_ru_captured": "20261009160000"}]
        assert backfill.fill_articles(db, listed) == 2
        assert backfill.fill_articles(db, listed) == 0
        conn = sqlite3.connect(db)
        assert conn.execute("SELECT article_url FROM releases").fetchone()[0] == listed[0]["article_en"]
        assert conn.execute("SELECT COUNT(*) FROM articles WHERE bundle_url LIKE '%1388a5a2%'").fetchone()[0] == 2
        conn.close()
