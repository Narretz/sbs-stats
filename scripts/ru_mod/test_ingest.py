"""
Unit tests for the RU MoD air-defense parser (scripts/ru_mod/ingest.py).

These lock in the ПВО-report wording variants the parser handles, the
night/day window attribution, and the storage/aggregation. Each case is keyed
(in a comment) to a real @mod_russia msg id so a regression is easy to trace.

Run with: pytest -v test_ingest.py   (from scripts/ru_mod/)
"""
from datetime import datetime

import ingest as ig


def _parse(text: str, mid: int = 1, posted_utc: str = "2026-05-23T18:49:01+00:00"):
    return ig.parse_report(text, mid, datetime.fromisoformat(posted_utc))


# ── window classification + date attribution ──────────────────────────────────
class TestWindows:
    def test_night_dated_explicit(self):
        # msg 63892 — "с 20.00 мск 22 мая до 7.00 мск 23 мая"
        r = _parse(
            "В период с 20.00 мск 22 мая до 7.00 мск 23 мая дежурными средствами ПВО "
            "перехвачены и уничтожены 348 украинских беспилотных летательных аппаратов "
            "самолетного типа над территориями Белгородской области.",
            mid=63892, posted_utc="2026-05-23T05:25:17+00:00",
        )
        assert r is not None
        assert r.drones == 348
        assert r.window_kind == "night"
        assert r.report_date == "2026-05-23"          # attributed to window-END date
        assert r.window_start == "2026-05-22T20:00+03:00"
        assert r.window_end == "2026-05-23T07:00+03:00"

    def test_night_dated_2400_end(self):
        # "до 24.00 мск" in a DATED night range must not crash (hour=24 is
        # out of range for datetime); end rolls to next-day 00:00.
        r = _parse(
            "В период с 20.00 мск 31 марта до 24.00 мск 31 марта дежурными средствами ПВО "
            "перехвачены и уничтожены 12 украинских беспилотных летательных аппаратов "
            "над территориями Брянской области.",
            posted_utc="2026-04-01T00:30:00+00:00",
        )
        assert r is not None
        assert r.drones == 12
        assert r.window_kind == "night"
        assert r.window_start == "2026-03-31T20:00+03:00"
        assert r.window_end == "2026-04-01T00:00+03:00"   # 24.00 → next-day 00:00
        assert r.report_date == "2026-04-01"              # window-END date

    def test_night_phrase_undated(self):
        # msg 63943 — "В течение прошедшей ночи …" (no explicit times)
        r = _parse(
            "В течение прошедшей ночи дежурными средствами ПВО перехвачены и уничтожены "
            "173 украинских беспилотных летательных аппарата самолетного типа над "
            "территориями Белгородской, Брянской областей и Республики Крым.",
            mid=63943, posted_utc="2026-05-25T06:07:01+00:00",
        )
        assert r.drones == 173
        assert r.window_kind == "night"
        assert r.report_date == "2026-05-25"
        assert r.window_start == "2026-05-24T20:00+03:00"  # standard 20:00→07:00
        assert r.window_end == "2026-05-25T07:00+03:00"

    def test_daytime_range(self):
        # msg 63908 — "С 14.00 до 20.00 мск"
        r = _parse(
            "С 14.00 до 20.00 мск дежурными средствами ПВО перехвачены и уничтожены 11 "
            "украинских беспилотных летательных аппаратов самолетного типа над "
            "территориями Белгородской области.",
            mid=63908, posted_utc="2026-05-23T18:49:01+00:00",
        )
        assert r.drones == 11
        assert r.window_kind == "day"
        assert r.report_date == "2026-05-23"
        assert r.window_start == "2026-05-23T14:00+03:00"
        assert r.window_end == "2026-05-23T20:00+03:00"

    def test_msk_repeated_after_start_time(self):
        # Regression: channel writes "с 7.00 мск до 15.00 мск" (мск after BOTH
        # times). These were mis-bucketed as window_kind='other' before the fix.
        r = _parse(
            "С 7.00 мск до 15.00 мск дежурными средствами ПВО перехвачены и уничтожены "
            "196 украинских беспилотных летательных аппаратов самолетного типа над "
            "территориями Курской области.",
            posted_utc="2026-05-21T13:39:00+00:00",
        )
        assert r.drones == 196
        assert r.window_kind == "day"          # NOT 'other'
        assert r.window_start == "2026-05-21T07:00+03:00"
        assert r.window_end == "2026-05-21T15:00+03:00"

    def test_night_dated_without_msk(self):
        # msg 61912 — dated overnight range with NO "мск" after the times:
        # "с 23.00 12 марта до 7.00 13 марта". Must read the explicit 23:00 start
        # (not fall through to the 20:00 NIGHT_PHRASE default).
        r = _parse(
            "В течение прошедшей ночи в период с 23.00 12 марта до 7.00 13 марта дежурными "
            "средствами ПВО перехвачены и уничтожены 176 украинских беспилотных летательных "
            "аппаратов самолетного типа над территориями Брянской области.",
            mid=61912, posted_utc="2026-03-13T05:25:18+00:00",
        )
        assert r.drones == 176
        assert r.window_kind == "night"
        assert r.window_start == "2026-03-12T23:00+03:00"   # explicit, not the 20:00 default
        assert r.window_end == "2026-03-13T07:00+03:00"
        assert r.report_date == "2026-03-13"

    def test_night_phrase_early_morning_same_day(self):
        # msg 63568 — "прошедшей ночи, в период с 0.00 до 7.00". A 00:00→07:00
        # window does NOT cross midnight: it's the posted morning, not a 31-hour
        # span back to the previous midnight.
        r = _parse(
            "В течение прошедшей ночи, в период с 0.00 до 7.00 дежурными средствами ПВО "
            "перехвачены и уничтожены 27 украинских беспилотных летательных аппаратов "
            "самолетного типа над территориями Брянской области.",
            mid=63568, posted_utc="2026-05-12T05:11:01+00:00",
        )
        assert r.drones == 27
        assert r.window_kind == "night"
        assert r.window_start == "2026-05-12T00:00+03:00"
        assert r.window_end == "2026-05-12T07:00+03:00"
        assert r.report_date == "2026-05-12"

    def test_night_dated_with_tg_suffix(self):
        # msg 62087 — "с 23.00 мск 20 марта т.г. до 7.00 мск 21 марта т.г.".
        # The "т.г." (текущего года) suffix breaks NIGHT_DATED_RE, so the explicit
        # 23:00 must be recovered from the hours instead of defaulting to 20:00.
        r = _parse(
            "В течение прошедшей ночи в период с 23.00 мск 20 марта т.г. до 7.00 мск 21 марта "
            "т.г. дежурными средствами ПВО перехвачены и уничтожены 283 украинских беспилотных "
            "летательных аппарата самолетного типа над территориями Брянской области.",
            mid=62087, posted_utc="2026-03-21T05:30:00+00:00",
        )
        assert r.drones == 283
        assert r.window_start == "2026-03-20T23:00+03:00"   # not the 20:00 default
        assert r.window_end == "2026-03-21T07:00+03:00"

    def test_night_numeric_dates_in_parens(self):
        # msg 63267 — "(с 21.00 мск 6.05 до 7.00 мск 7.05)". Numeric dates (no word
        # month) break NIGHT_DATED_RE; recover the explicit 21:00 start.
        r = _parse(
            "В течение прошедшей ночи (с 21.00 мск 6.05 до 7.00 мск 7.05) дежурными средствами "
            "ПВО перехвачены и уничтожены 347 украинских беспилотных летательных аппаратов "
            "самолетного типа над территориями Белгородской области.",
            mid=63267, posted_utc="2026-05-07T05:10:00+00:00",
        )
        assert r.drones == 347
        assert r.window_start == "2026-05-06T21:00+03:00"   # not the 20:00 default
        assert r.window_end == "2026-05-07T07:00+03:00"

    def test_evening_report_posted_after_midnight_dates_to_prev_day(self):
        # msg 61638 — "с 20.00 до 23.00 мск" published at 00:24 MSK (21:24 UTC the
        # day before). The window is in the future relative to the post unless we
        # recognise it describes the PREVIOUS evening → shift back a day.
        r = _parse(
            "В период с 20.00 до 23.00 мск дежурными средствами ПВО перехвачены и уничтожены "
            "57 украинских беспилотных летательных аппаратов самолетного типа над "
            "территориями Белгородской области.",
            mid=61638, posted_utc="2026-03-01T21:24:58+00:00",   # = 2026-03-02T00:24 MSK
        )
        assert r.drones == 57
        assert r.window_start == "2026-03-01T20:00+03:00"   # shifted back from Mar 2
        assert r.window_end == "2026-03-01T23:00+03:00"
        assert r.report_date == "2026-03-01"

    def test_early_morning_range_is_night(self):
        # "с 0.00 мск до 7.00 мск" → ends ≤07:00, so classified night.
        r = _parse(
            "В период с 0.00 мск до 7.00 мск дежурными средствами ПВО перехвачены и "
            "уничтожены 264 украинских беспилотных летательных аппарата самолетного типа "
            "над территориями Брянской области.",
            posted_utc="2026-05-08T05:19:00+00:00",
        )
        assert r.drones == 264
        assert r.window_kind == "night"
        assert r.window_start == "2026-05-08T00:00+03:00"
        assert r.window_end == "2026-05-08T07:00+03:00"

    def test_midnight_2400_rollover(self):
        # "до 24.00" must not crash (no hour=24); rolls to next-day 00:00.
        r = _parse(
            "С 20.00 до 24.00 мск дежурными средствами ПВО перехвачены и уничтожены 30 "
            "украинских беспилотных летательных аппаратов над территориями Брянской области.",
            posted_utc="2026-05-10T20:30:00+00:00",
        )
        assert r.drones == 30
        assert r.window_kind == "night"        # starts ≥18:00
        assert r.window_end is not None and r.window_end.endswith("00:00+03:00")


# ── the gate: only real AD-intercept posts parse ──────────────────────────────
class TestGate:
    def test_cumulative_svodka_is_not_an_ad_report(self):
        # Daily Сводка cumulative line — "беспилотных" but not "украинских …"
        # via the AD wording, so it must NOT be parsed as a daily AD report.
        text = (
            "Всего с начала проведения специальной военной операции уничтожено: "
            "667 самолетов, 283 вертолета, 76543 беспилотных летательных аппарата, "
            "609 зенитных ракетных комплексов."
        )
        assert _parse(text) is None

    def test_unrelated_post_is_none(self):
        assert _parse("🔹 Канал Минобороны России в MAКС – боевая работа 24/7.") is None
        assert _parse("Героям слава!") is None

    def test_implausible_count_rejected(self):
        text = (
            "В течение прошедшей ночи дежурными средствами ПВО перехвачены и уничтожены "
            "99999 украинских беспилотных летательных аппаратов над территориями областей."
        )
        assert _parse(text) is None


# ── region extraction ─────────────────────────────────────────────────────────
class TestRegions:
    def test_region_count(self):
        r = _parse(
            "С 14.00 до 20.00 мск дежурными средствами ПВО перехвачены и уничтожены 11 "
            "украинских беспилотных летательных аппаратов над территориями Белгородской, "
            "Брянской и Курской областей.",
        )
        assert r.region_count == 3
        assert "Белгородской" in r.regions and "Курской" in r.regions

    def test_markdown_stripped_from_regions(self):
        # telethon returns Markdown source; **bold** markers must not leak into
        # the parsed region name (web preview returns plain text, so both sources
        # must parse to the same clean string — see _strip_md).
        r = _parse(
            "С 14.00 до 20.00 мск дежурными средствами ПВО перехвачены и уничтожены 11 "
            "украинских беспилотных летательных аппаратов над территориями "
            "**Белгородской, Брянской и Курской областей**.",
        )
        assert "*" not in r.regions
        assert r.regions.startswith("Белгородской")
        assert r.region_count == 3

    def test_no_regions_clause(self):
        r = _parse(
            "С 14.00 до 20.00 мск дежурными средствами ПВО перехвачены и уничтожены 5 "
            "украинских беспилотных летательных аппаратов.",
        )
        assert r is not None
        assert r.region_count == 0


# ── itemized per-region breakdown (the format that gives per-region counts) ───
ITEMIZED_DEC7 = (
    "В течение прошедшей ночи дежурными средствами ПВО перехвачены и уничтожены 77 "
    "украинских беспилотных летательных аппаратов самолетного типа: \n"
    "▫️ 42 – над территорией Саратовской области, \n"
    "▫️ 12 – над территорией Ростовской области, \n"
    "▫️ 10 – над территорией Республики Крым, \n"
    "▫️ 9 – над территорией Волгоградской области, \n"
    "▫️ 2 – над территорией Белгородской области,\n"
    "▫️ 1 – над территорией Астраханской области.\n"
    "▫️ 1 – над территорией Чеченской Республики."
)


class TestBreakdown:
    def test_itemized_per_region_counts(self):
        r = _parse(ITEMIZED_DEC7, posted_utc="2025-12-07T06:00:00+00:00")
        assert r.drones == 77
        assert r.window_kind == "night"
        assert r.region_count == 7
        bd = dict(r.breakdown)
        assert bd["Саратовской области"] == 42
        assert bd["Республики Крым"] == 10
        assert bd["Чеченской Республики"] == 1
        assert sum(bd.values()) == 77            # per-region sums to the total

    def test_total_only_has_no_breakdown(self):
        r = _parse(
            "В течение прошедшей ночи дежурными средствами ПВО перехвачены и уничтожены "
            "173 украинских беспилотных летательных аппарата самолетного типа над "
            "территориями Белгородской, Брянской областей и Республики Крым.",
            posted_utc="2026-05-25T06:07:01+00:00",
        )
        assert r.breakdown == []
        assert r.region_count == 3   # falls back to the loose clause count


# ── Сводка summary capture (stored raw, numbers not parsed) ───────────────────
WEEKLY_SVODKA = (
    "Сводка Министерства обороны Российской Федерации о ходе проведения специальной "
    "военной операции с 29 ноября по 5 декабря 2025 г. Всего с начала проведения "
    "специальной военной операции уничтожено: 672 самолета, 283 вертолета, 84512 "
    "беспилотных летательных аппаратов, 611 зенитных ракетных комплексов, 24788 танков."
)


def _summary(text: str, mid: int = 1, posted_utc: str = "2025-12-06T08:00:00+00:00"):
    return ig.parse_summary(text, mid, datetime.fromisoformat(posted_utc))


class TestSummary:
    def test_weekly_header_parsed(self):
        s = _summary(WEEKLY_SVODKA)
        assert s is not None
        assert s.kind == "svodka_weekly"
        assert s.period == "29 ноября – 5 декабря 2025"
        assert "84512" in s.raw_text          # full text retained, not parsed

    def test_weekly_shared_month_form(self):
        # "со 2 по 8 мая 2026" — first day has no month (shared with the end).
        s = _summary(
            "Сводка Министерства обороны Российской Федерации о ходе проведения специальной "
            "военной операции со 2 по 8 мая 2026 г. Всего зафиксировано 1630 нарушений режима.",
            posted_utc="2026-05-08T18:00:00+00:00",
        )
        assert s.kind == "svodka_weekly"
        assert s.period == "2 мая – 8 мая 2026"

    def test_daily_svodka_form(self):
        s = _summary(
            "Сводка Министерства обороны Российской Федерации о ходе проведения специальной "
            "военной операции по состоянию на 12 мая 2026 г. …",
            posted_utc="2026-05-12T08:00:00+00:00",
        )
        assert s.kind == "svodka_daily"
        assert s.period == "12 мая 2026"

    def test_weekly_svodka_is_not_an_ad_report(self):
        # The loss Сводка must not be misread as a daily air-defense report.
        assert _parse(WEEKLY_SVODKA, posted_utc="2025-12-06T08:00:00+00:00") is None

    def test_ad_report_is_not_a_summary(self):
        assert _summary(
            "С 14.00 до 20.00 мск дежурными средствами ПВО перехвачены и уничтожены 11 "
            "украинских беспилотных летательных аппаратов над территориями Курской области."
        ) is None

    def test_summary_persisted(self, tmp_path):
        import sqlite3
        db = tmp_path / "ad.db"
        ig.store(db, [], [_summary(WEEKLY_SVODKA, mid=500)])
        conn = sqlite3.connect(db)
        row = conn.execute("SELECT kind, period FROM summaries WHERE post_id=500").fetchone()
        conn.close()
        assert row == ("svodka_weekly", "29 ноября – 5 декабря 2025")

    def test_cross_source_summary_dedups(self, tmp_path):
        # Same post via web (plain text) then telethon (Markdown bold + a link).
        # Identical content, different formatting → must NOT create a 2nd version.
        import sqlite3
        db = tmp_path / "ad.db"
        body = ("Сводка Министерства обороны Российской Федерации о ходе проведения специальной "
                "военной операции с 1 по 7 мая 2026 г. Поражены пункты управления. См. часть 2")
        web = _summary(body, mid=700)
        telethon = _summary(
            body.replace("Сводка", "**Сводка**").replace("См. часть 2", "[См. часть 2](https://t.me/mod_russia/701)"),
            mid=700)
        ig.store(db, [], [web])
        ig.store(db, [], [telethon])
        conn = sqlite3.connect(db)
        n = conn.execute("SELECT COUNT(*) FROM summaries WHERE post_id=700").fetchone()[0]
        conn.close()
        assert n == 1

    def test_summary_edit_adds_version(self, tmp_path):
        # A genuine wording change still inserts a new version.
        import sqlite3
        db = tmp_path / "ad.db"
        base = ("Сводка Министерства обороны Российской Федерации о ходе проведения специальной "
                "военной операции с 1 по 7 мая 2026 г. ")
        ig.store(db, [], [_summary(base + "Поражены цели.", mid=710)])
        ig.store(db, [], [_summary(base + "Поражены ДВЕ цели.", mid=710)])
        conn = sqlite3.connect(db)
        n = conn.execute("SELECT COUNT(*) FROM summaries WHERE post_id=710").fetchone()[0]
        conn.close()
        assert n == 2


# ── storage: append-only by post_id + daily_ad aggregation ────────────────────
class TestStorage:
    def _reports_for_one_drone_day(self):
        # night + three daytime windows, all attributed to 2026-05-23.
        return [
            _parse("В период с 20.00 мск 22 мая до 7.00 мск 23 мая дежурными средствами ПВО "
                   "перехвачены и уничтожены 348 украинских беспилотных летательных аппаратов "
                   "над территориями Белгородской области.",
                   mid=63892, posted_utc="2026-05-23T05:25:17+00:00"),
            _parse("С 7.00 до 9.00 мск дежурными средствами ПВО перехвачены и уничтожены 17 "
                   "украинских беспилотных летательных аппаратов над территориями Курской области.",
                   mid=63894, posted_utc="2026-05-23T07:23:00+00:00"),
            _parse("С 9.00 до 14.00 мск дежурными средствами ПВО перехвачены и уничтожены 42 "
                   "украинских беспилотных летательных аппаратов над территориями Курской области.",
                   mid=63899, posted_utc="2026-05-23T12:37:00+00:00"),
            _parse("С 14.00 до 20.00 мск дежурными средствами ПВО перехвачены и уничтожены 11 "
                   "украинских беспилотных летательных аппаратов над территориями Белгородской области.",
                   mid=63908, posted_utc="2026-05-23T18:49:01+00:00"),
        ]

    def test_daily_view_sums_and_idempotent(self, tmp_path):
        import sqlite3
        db = tmp_path / "ad.db"
        reports = self._reports_for_one_drone_day()

        inserted, total, latest = ig.store(db, reports)
        assert inserted == 4 and total == 4 and latest == "2026-05-23"

        conn = sqlite3.connect(db)
        row = conn.execute(
            "SELECT date, drones_destroyed, reports FROM daily_ad WHERE date='2026-05-23'"
        ).fetchone()
        conn.close()
        assert row == ("2026-05-23", 348 + 17 + 42 + 11, 4)  # 418 total, 4 reports

        # Re-store the same posts → change detection sees no change, nothing added.
        inserted2, total2, _ = ig.store(db, reports)
        assert inserted2 == 0 and total2 == 4

    def test_region_breakdown_persisted(self, tmp_path):
        import sqlite3
        db = tmp_path / "ad.db"
        ig.store(db, [_parse(ITEMIZED_DEC7, mid=99, posted_utc="2025-12-07T06:00:00+00:00")])
        conn = sqlite3.connect(db)
        n_regions = conn.execute("SELECT COUNT(*) FROM ad_regions WHERE post_id=99").fetchone()[0]
        saratov = conn.execute(
            "SELECT drones FROM region_totals WHERE region='Саратовской области'").fetchone()[0]
        conn.close()
        assert n_regions == 7
        assert saratov == 42

    def test_overlap_detection(self, tmp_path):
        # Two windows that overlap (08:00–23:00 vs next night 20:00→07:00).
        evening = _parse("С 08.00 до 23.00 мск дежурными средствами ПВО перехвачены и "
                         "уничтожены 38 украинских беспилотных летательных аппаратов над "
                         "территориями Брянской области.",
                         mid=1, posted_utc="2026-05-14T20:45:00+00:00")
        night = _parse("В период с 20.00 мск 14 мая до 7.00 мск 15 мая дежурными средствами ПВО "
                       "перехвачены и уничтожены 355 украинских беспилотных летательных аппаратов "
                       "над территориями Белгородской области.",
                       mid=2, posted_utc="2026-05-15T05:57:00+00:00")
        ig.store(tmp_path / "ad.db", [evening, night])
        import sqlite3
        conn = sqlite3.connect(tmp_path / "ad.db")
        assert ig._overlap_count(conn) == 1   # the 20:00–23:00 overlap is flagged
        # the later (night) report carries the note; the evening one stays clean
        night_note = conn.execute("SELECT notes FROM ad_latest WHERE post_id=2").fetchone()[0]
        evening_note = conn.execute("SELECT notes FROM ad_latest WHERE post_id=1").fetchone()[0]
        assert night_note and "double-count" in night_note and "post 1" in night_note
        assert evening_note is None
        conn.close()

    def test_no_overlap_leaves_notes_null(self, tmp_path):
        # Cleanly tiled day → no overlap → notes stays NULL on every row.
        r = self._reports_for_one_drone_day()
        ig.store(tmp_path / "ad.db", r)
        import sqlite3
        conn = sqlite3.connect(tmp_path / "ad.db")
        assert conn.execute("SELECT COUNT(*) FROM ad_reports WHERE notes IS NOT NULL").fetchone()[0] == 0
        conn.close()


# ── edit versioning: append a new row on change, never overwrite ──────────────
class TestVersioning:
    def _report(self, drones: int, mid: int = 700, posted: str = "2026-05-20T18:00:00+00:00"):
        return _parse(
            f"С 14.00 до 20.00 мск дежурными средствами ПВО перехвачены и уничтожены {drones} "
            f"украинских беспилотных летательных аппаратов над территориями Курской области.",
            mid=mid, posted_utc=posted)

    def test_edit_adds_version_latest_wins(self, tmp_path):
        import sqlite3
        db = tmp_path / "ad.db"
        assert ig.store(db, [self._report(100)])[:2] == (1, 1)   # first version
        assert ig.store(db, [self._report(100)])[:2] == (0, 1)   # unchanged → no new version
        assert ig.store(db, [self._report(120)])[:2] == (1, 2)   # edited → second version

        conn = sqlite3.connect(db)
        versions = conn.execute("SELECT COUNT(*) FROM ad_reports WHERE post_id=700").fetchone()[0]
        latest = conn.execute("SELECT drones FROM ad_latest WHERE post_id=700").fetchone()[0]
        day = conn.execute("SELECT drones_destroyed FROM daily_ad").fetchone()[0]
        conn.close()
        assert versions == 2          # both versions retained — nothing overwritten
        assert latest == 120          # newest wins
        assert day == 120             # aggregate counts the latest only (not 100, not 220)

    def test_region_versioning_latest_wins(self, tmp_path):
        import sqlite3
        db = tmp_path / "ad.db"
        ig.store(db, [_parse(ITEMIZED_DEC7, mid=800, posted_utc="2025-12-07T06:00:00+00:00")])
        edited = (ITEMIZED_DEC7
                  .replace("уничтожены 77 ", "уничтожены 85 ")
                  .replace("42 – над территорией Саратовской", "50 – над территорией Саратовской"))
        ig.store(db, [_parse(edited, mid=800, posted_utc="2025-12-07T06:00:00+00:00")])

        conn = sqlite3.connect(db)
        saratov = conn.execute(
            "SELECT drones FROM region_totals WHERE region='Саратовской области'").fetchone()[0]
        all_rows = conn.execute("SELECT COUNT(*) FROM ad_regions WHERE post_id=800").fetchone()[0]
        conn.close()
        assert saratov == 50          # region_totals reflects the latest version
        assert all_rows == 14         # 7 regions × 2 versions kept (no loss)
