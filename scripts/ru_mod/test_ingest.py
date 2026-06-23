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

    def test_short_same_hour_window_is_day_not_24h(self):
        # msg 55511 (Aug 2025): "С 07.00 до 07.20 мск" is a 20-minute daytime
        # window. The earlier hours-only DAY_RANGE_RE saw h1==h2 and treated
        # it as crosses-midnight → fake 24-hour overnight, which then made
        # every subsequent same-day report appear to "overlap" 55511.
        r = _parse(
            "С 07.00 до 07.20 мск дежурными средствами ПВО уничтожены три "
            "украинских беспилотных летательных аппарата самолетного типа над "
            "территорией Белгородской области.",
            mid=55511, posted_utc="2025-08-13T05:21:33+00:00",
        )
        assert r is not None
        assert r.drones == 3
        assert r.window_kind == "day"
        assert r.window_start == "2025-08-13T07:00+03:00"
        assert r.window_end == "2025-08-13T07:20+03:00"   # not the next-day fake
        assert r.report_date == "2025-08-13"


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

    def test_total_word_form_low_day(self):
        # Single-digit days spell the total ("шесть"); msg 63991, May 26 2026.
        r = _parse(
            "В период с 8.00 мск до 20.00 мск дежурными средствами ПВО перехвачены и "
            "уничтожены шесть украинских беспилотных летательных аппаратов самолетного "
            "типа над территориями Белгородской области, Республики Крым и над "
            "акваторией Азовского моря.",
            posted_utc="2026-05-26T18:34:01+00:00",
        )
        assert r.drones == 6
        assert r.report_date == "2026-05-26"

    def test_total_word_form_multi_word(self):
        # Two-word numeral ("двадцать три") still resolves.
        r = _parse(
            "В течение прошедшей ночи дежурными средствами ПВО перехвачены и уничтожены "
            "двадцать три украинских беспилотных летательных аппарата самолетного типа "
            "над территориями Белгородской и Брянской областей."
        )
        assert r.drones == 23

    def test_masculine_singular_ends_in_one(self):
        # Russian: counts ending in 1 but not 11 take masculine-singular form,
        # i.e. bare "уничтожен" with NO suffix and "украинский ... аппарат"
        # (singular). msg 64830 (301) and msg 64851 (141) were both missed by
        # the earlier `уничтожен\w+` gate which required a trailing letter.
        r301 = _parse(
            "В течение ночи в период с 20.00 мск 21 июня до 7.00 мск 22 июня дежурными "
            "средствами ПВО перехвачен и уничтожен 301 украинский беспилотный летательный "
            "аппарат самолетного типа над территориями Белгородской области.",
            mid=64830, posted_utc="2026-06-22T05:49:48+00:00",
        )
        assert r301 is not None and r301.drones == 301
        r141 = _parse(
            "В период с 7.00 до 20.00 мск дежурными средствами ПВО перехвачен и уничтожен "
            "141 украинский беспилотный летательный аппарат самолетного типа над "
            "территориями Белгородской области.",
            mid=64851, posted_utc="2026-06-22T18:37:01+00:00",
        )
        assert r141 is not None and r141.drones == 141


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

    def test_itemized_with_bpla_unit_and_sea_area(self):
        # From ~Mar 2026 the per-region lines insert the unit "БПЛА" before the
        # dash ("57 БПЛА – над территорией …") and include sea areas ("акваторией
        # Каспийского моря"). Both must be captured.
        r = _parse(
            "В течение прошедшей ночи дежурными средствами ПВО перехвачены и уничтожены "
            "151 украинский беспилотный летательный аппарат самолетного типа: "
            "▫️ 57 БПЛА – над территорией Волгоградской области, "
            "▫️ 48 БПЛА – над территорией Ростовской области, "
            "▫️ 35 БПЛА – над территорией Белгородской области, "
            "▫️ 9 БПЛА – над акваторией Каспийского моря, "
            "▫️ 1 БПЛА – над территорией Республики Калмыкия, "
            "▫️ 1 БПЛА – над территорией Тамбовской области.",
            posted_utc="2026-04-10T05:00:00+00:00",
        )
        assert r.drones == 151
        bd = dict(r.breakdown)
        assert bd["Волгоградской области"] == 57
        assert bd["Каспийского моря"] == 9      # sea area captured
        assert r.region_count == 6
        assert sum(bd.values()) == 151          # per-region sums to the total

    def test_itemized_wording_variants_sum_to_total(self):
        # Real variants that the strict regex missed: a "Московским регионом"
        # line (no "территорией"), a "в том числе N …, летевших на Москву"
        # sub-clause (a subset, must NOT be counted), and a "– территорией X"
        # line with "над" dropped. Capturing all real region lines (and only
        # those) makes the breakdown sum back to the report total.
        r = _parse(
            "В течение прошедшей ночи дежурными средствами ПВО перехвачены и уничтожены "
            "60 украинских беспилотных летательных аппаратов самолетного типа: "
            "▫️ 34 – над территорией Брянской области, "
            "▫️ 13 – над Московским регионом, в том числе 12 БПЛА, летевших на Москву, "
            "▫️ 9 БПЛА – территорией Краснодарского края, "
            "▫️ 4 – над акваторией Азовского моря.",
            posted_utc="2026-03-16T05:00:00+00:00",
        )
        assert r.drones == 60
        bd = dict(r.breakdown)
        assert bd["Брянской области"] == 34
        assert bd["Московским регионом"] == 13      # "регионом", no "территорией"
        assert bd["Краснодарского края"] == 9       # "над" dropped
        assert bd["Азовского моря"] == 4
        assert "Москву" not in " ".join(bd)         # sub-clause not a region
        assert sum(bd.values()) == 60               # sums to total (no double-count)

    def test_itemized_word_form_counts(self):
        # Low-count days spell the per-region numbers out ("восемь", "два").
        r = _parse(
            "В течение прошедшей ночи дежурными средствами ПВО перехвачены и уничтожены "
            "11 украинских беспилотных летательных аппаратов самолетного типа: "
            "▫️ восемь – над территорией Белгородской области, "
            "▫️ два – над территорией Курской области, "
            "▫️ один БПЛА – над акваторией Черного моря.",
            posted_utc="2026-01-04T05:00:00+00:00",
        )
        assert r.drones == 11
        bd = dict(r.breakdown)
        assert bd["Белгородской области"] == 8
        assert bd["Курской области"] == 2
        assert bd["Черного моря"] == 1
        assert sum(bd.values()) == 11

    def test_po_distributes_count_across_regions(self):
        # "по N БПЛА – над территориями X и Y" means N over EACH region (so
        # 2*N drones across the two rows). msg 57301 (Oct 2025) used three
        # such bullets and the breakdown was N short by the sum of (N * (k-1))
        # for each "по" item; this fix makes the sum reconcile.
        r = _parse(
            "В течение прошедшей ночи дежурными средствами ПВО перехвачен и "
            "уничтожен 30 украинский беспилотный летательный аппарат самолетного типа: "
            "▫️ 4 БПЛА – над территорией Рязанской области, "
            "▫️ По 8 БПЛА – над территориями Брянской и Тульской областей, "
            "▫️ По 2 БПЛА – над территориями Владимирской, Ивановской, Калужской, Тамбовской и Орловской областей.",
            posted_utc="2025-10-06T05:00:00+00:00",
        )
        bd = dict(r.breakdown)
        assert bd["Рязанской области"] == 4
        assert bd["Брянской области"] == 8
        assert bd["Тульской области"] == 8
        assert bd["Владимирской области"] == 2
        assert bd["Ивановской области"] == 2
        assert bd["Калужской области"] == 2
        assert bd["Тамбовской области"] == 2
        assert bd["Орловской области"] == 2
        assert sum(bd.values()) == 4 + 8 * 2 + 2 * 5

    def test_po_with_verb_and_no_dash(self):
        # Verb between БПЛА and the region phrase ("сбито", "уничтожены")
        # sometimes replaces the dash entirely. msg 55905 (Aug 2025).
        r = _parse(
            "В течение прошедшей ночи дежурными средствами ПВО перехвачены и уничтожены "
            "12 украинских беспилотных летательных аппаратов самолетного типа: "
            "▫️ по шесть БПЛА уничтожены – над территориями Ленинградской и Рязанской областей.",
            posted_utc="2025-08-26T05:00:00+00:00",
        )
        bd = dict(r.breakdown)
        assert bd["Ленинградской области"] == 6
        assert bd["Рязанской области"] == 6

    def test_po_one_dative(self):
        # "по одному" (dative singular) for 1 — common in low-count bullets.
        r = _parse(
            "В течение прошедшей ночи дежурными средствами ПВО перехвачены и уничтожены "
            "12 украинских беспилотных летательных аппаратов самолетного типа: "
            "▫️ по одному – над территориями Воронежской, Калужской и Липецкой областей, "
            "▫️ девять – над территорией Брянской области.",
            posted_utc="2025-08-26T05:00:00+00:00",
        )
        bd = dict(r.breakdown)
        assert bd["Воронежской области"] == 1
        assert bd["Калужской области"] == 1
        assert bd["Липецкой области"] == 1
        assert bd["Брянской области"] == 9

    def test_black_square_bullet_separates_items(self):
        # The MoD mixes ▫️ (white square) and ▪️ (black square) bullets. Both
        # must terminate the region capture; otherwise a "по" phrase swallows
        # everything to the next period and the breakdown inflates. msg 54393
        # (Jul 2025) exposed this with three back-to-back "по N БПЛА" items
        # separated only by ▪️.
        r = _parse(
            "В течение прошедшей ночи дежурными средствами ПВО перехвачены и уничтожены "
            "30 украинских беспилотных летательных аппарата самолетного типа: "
            "▪️ по девять БПЛА – над территориями Белгородской и Саратовской областей, "
            "▪️ 8 БПЛА – над территорией Новгородской области, "
            "▪️ по два БПЛА – над территориями Ростовской и Калужской областей.",
            posted_utc="2025-07-05T05:00:00+00:00",
        )
        bd = dict(r.breakdown)
        assert bd["Белгородской области"] == 9
        assert bd["Саратовской области"] == 9
        assert bd["Новгородской области"] == 8
        assert bd["Ростовской области"] == 2
        assert bd["Калужской области"] == 2
        assert sum(bd.values()) == 9 + 9 + 8 + 2 + 2

    def test_po_phrase_stops_before_next_bulletless_item(self):
        # Some bullet-less posts join items with " и <count> БПЛА" — e.g.
        # "по два БПЛА – над территориями Курской и Ростовской областей и
        # один БПЛА – над территорией Республики Крым". The "по" phrase must
        # stop at the boundary "и один БПЛА" so the standalone trailing item
        # isn't swallowed (and so REGION_ITEM_RE catches it on the residual).
        # msg 54315 (Jul 2025).
        r = _parse(
            "В течение прошедшей ночи дежурными средствами ПВО уничтожены 5 "
            "украинских беспилотных летательных аппаратов самолетного типа: "
            "по два БПЛА – над территориями Курской и Ростовской областей и "
            "один БПЛА – над территорией Республики Крым.",
            posted_utc="2025-07-01T05:00:00+00:00",
        )
        bd = dict(r.breakdown)
        assert bd["Курской области"] == 2
        assert bd["Ростовской области"] == 2
        assert bd["Республики Крым"] == 1
        assert sum(bd.values()) == 5

    def test_trailing_item_joined_by_conjunction_is_caught(self):
        # In bullet-less lists the final item is "… и один БПЛА – над …".
        # REGION_ITEM_RE's lazy count group expands to "и один" (because the
        # rest of the regex doesn't match starting at "и" alone), so
        # _count_to_int needs to strip the leading "и " before resolving.
        # msg 54397, 54759 (Jul 2025).
        r = _parse(
            "С 8.00 мск до 9.40 мск дежурными средствами ПВО уничтожены "
            "шесть украинских беспилотных летательных аппаратов самолетного типа: "
            "два БПЛА – над территорией Московского региона, "
            "один БПЛА – над территорией Рязанской области, "
            "один БПЛА – над территорией Нижегородской области, "
            "один БПЛА – над территорией Смоленской области и "
            "один БПЛА – над территорией Курской области.",
            posted_utc="2025-07-05T05:00:00+00:00",
        )
        bd = dict(r.breakdown)
        assert bd["Курской области"] == 1
        assert sum(bd.values()) == 6

    def test_vsego_summary_block_is_ignored(self):
        # Post has an immediate-window breakdown followed by a wider-window
        # "Всего, начиная с …" summary with its own ▪️ bullets. Without the
        # truncation, both halves' bullets get summed into one breakdown and
        # the total reads N + M instead of N. msg 51913 (Apr 2025).
        r = _parse(
            "В течение прошедшей ночи дежурными средствами ПВО уничтожены "
            "12 украинских беспилотных летательных аппаратов самолетного типа: "
            "▪️ 8 БПЛА – над территорией Рязанской области, "
            "▪️ 4 БПЛА – над территорией Орловской области. "
            "Всего, начиная с 20.00 мск 28 апреля до 06.00 мск 29 апреля, "
            "дежурными средствами ПВО уничтожен 91 украинский беспилотный летательный аппарат самолетного типа: "
            "▪️ 40 БПЛА – над территорией Курской области, "
            "▪️ 51 БПЛА – над территорией Орловской области.",
            posted_utc="2025-04-29T05:00:00+00:00",
        )
        bd = dict(r.breakdown)
        assert bd == {"Рязанской области": 8, "Орловской области": 4}

    def test_arrow_summary_block_is_ignored(self):
        # Same shape with the newer "➡️ Всего за ночь …" marker (msg 54070,
        # Jun 2025).
        r = _parse(
            "В период с 22.00 мск 22 июня до 7.00 мск 23 июня дежурными "
            "средствами ПВО перехвачены и уничтожены 16 украинских беспилотных "
            "летательных аппаратов самолетного типа: "
            "▪️ 13 БПЛА – над территорией Ростовской области, "
            "▪️ 3 БПЛА – над территорией Астраханской области. "
            "➡️ Всего за ночь перехвачены и уничтожены 23 беспилотных летательных аппарата самолетного типа: "
            "▪️ 14 БПЛА – над территорией Ростовской области, "
            "▪️ 9 БПЛА – над территорией Волгоградской области.",
            posted_utc="2025-06-23T05:00:00+00:00",
        )
        bd = dict(r.breakdown)
        assert bd == {"Ростовской области": 13, "Астраханской области": 3}

    def test_soft_hyphen_between_bpla_and_dash(self):
        # MoD typo: a SOFT HYPHEN (U+00AD) slipped in between "БПЛА" and the
        # en-dash, breaking the dash-anchored region match. _strip_md drops
        # the invisible char so the bullet parses normally. msg 53965 (Jun 2025).
        r = _parse(
            "20 июня с 22.00 до 23.55 мск дежурными средствами ПВО уничтожены "
            "23 украинских беспилотных летательных аппарата самолетного типа: "
            "▪️ 15 БПЛА – над территорией Белгородской области, "
            "▪️ 6 БПЛА – над территорией Курской области, "
            "▪️ 2 БПЛА \xad– над территорией Воронежской области.",
            posted_utc="2025-06-20T22:30:00+00:00",
        )
        bd = dict(r.breakdown)
        assert bd == {"Белгородской области": 15, "Курской области": 6, "Воронежской области": 2}

    def test_po_phrase_stops_at_next_po_item(self):
        # Bullet-less post chains "по N БПЛА" items with commas. The first
        # phrase must stop at ", по <count>" so the next "по" item doesn't
        # get absorbed and inflate the sum. msg 49522 (Mar 2025).
        r = _parse(
            "В течение прошедшей ночи дежурными средствами ПВО перехвачены и "
            "уничтожены 10 украинских беспилотных летательных аппаратов: "
            "по три БпЛА над территориями Белгородской и Ростовской областей, "
            "по два БпЛА над территориями Смоленской и Липецкой областей.",
            posted_utc="2025-03-01T05:00:00+00:00",
        )
        bd = dict(r.breakdown)
        assert bd == {
            "Белгородской области": 3, "Ростовской области": 3,
            "Смоленской области":   2, "Липецкой области":   2,
        }

    def test_headline_short_unit_бпла(self):
        # msg 44509 (Oct 2024): "уничтожены три украинских БпЛА самолетного
        # типа" — the old COUNT_RE only matched the long noun phrase
        # "беспилотных летательных аппаратов" and silently dropped every
        # post that used the short "БпЛА"/"БПЛА" unit. Now part of the
        # _UNIT_NOUN alternation.
        r = _parse(
            "Дежурными средствами ПВО уничтожены три украинских БпЛА "
            "самолетного типа над территориями Белгородской, Курской и Тульской областей.",
            posted_utc="2024-10-15T01:00:00+00:00",
        )
        assert r.drones == 3

    def test_headline_noun_first_verb_order(self):
        # msg 44515, 44463, 44467 (Oct 2024): "N украинских беспилотных
        # летательных аппарата уничтожены над …" — count comes BEFORE the
        # verb, opposite to the canonical "уничтожено N …" form. Covered
        # by COUNT_NOUN_FIRST_RE.
        r = _parse(
            "Дежурными средствами ПВО два украинских беспилотных летательных "
            "аппарата уничтожены над территорией Белгородской области.",
            posted_utc="2024-10-15T05:00:00+00:00",
        )
        assert r.drones == 2

    def test_headline_singular_implicit_count(self):
        # msg 44518, 44461, 44465 (Oct 2024): "украинский беспилотный
        # летательный аппарат уничтожен над …" — no numeral in the text;
        # the singular agreement of "украинский / аппарат / уничтожен"
        # implies count=1. COUNT_SINGULAR_RE handles this with a fixed 1.
        r = _parse(
            "Дежурными средствами ПВО украинский беспилотный летательный "
            "аппарат уничтожен над территорией Белгородской области.",
            posted_utc="2024-10-15T08:00:00+00:00",
        )
        assert r.drones == 1

    def test_headline_paired_verb(self):
        # msg 44421 (Oct 2024): "уничтожено и перехвачено 47 украинских
        # БпЛА" — the channel pairs two verbs around the count. The old
        # COUNT_RE's optional "и уничтожен" repeat didn't accept other
        # verbs there; now the optional inner group is any _AD_VERB.
        # Also exercises the paired-verb _VERB_OPT in REGION_ITEM_RE
        # ("17 БпЛА перехвачены и уничтожены над …").
        r = _parse(
            "Дежурными средствами ПВО уничтожено и перехвачено 47 украинских "
            "БпЛА самолетного типа. "
            "17 БпЛА перехвачены и уничтожены над территорией Краснодарского края, "
            "16 - над акваторией Азовского моря, "
            "12 – над территорией Курской области, "
            "два над территорией Белгородской области.",
            posted_utc="2024-10-12T01:00:00+00:00",
        )
        assert r.drones == 47
        bd = dict(r.breakdown)
        assert sum(bd.values()) == 47
        assert bd["Краснодарского края"] == 17
        assert bd["Азовского моря"] == 16
        assert bd["Курской области"] == 12
        assert bd["Белгородской области"] == 2

    def test_v_preposition_region(self):
        # msg 44303 (Oct 2024): older MoD format mixes "над <region>" with
        # "в <region>" — both a PO form ("по 2 БпЛА в Курской и Ростовской
        # областях") and a bare-count form ("один в Краснодарском крае").
        # Required adding "в" to _DASH_OR_NAD, to the boundary alternation
        # (so PO regions don't run past " в "), and prepositional-plural
        # nouns (областях/морях/краях) to _PLURAL_TO_SINGULAR for PO split.
        r = _parse(
            "Дежурными средствами ПВО перехвачено и уничтожено "
            "47 украинских беспилотных летательных аппарата. "
            "24 БпЛА сбиты над территорией Брянской области, "
            "5 БпЛА уничтожены над территорией Белгородской области, "
            "по 2 БпЛА в Курской и Ростовской областях, "
            "один в Краснодарском крае "
            "и 13 над акваторией Азовского моря.",
            posted_utc="2024-10-25T05:00:00+00:00",
        )
        bd = dict(r.breakdown)
        assert sum(bd.values()) == 47
        assert bd["Брянской области"] == 24
        assert bd["Белгородской области"] == 5
        assert bd["Курской области"] == 2
        assert bd["Ростовской области"] == 2
        assert bd["Краснодарском крае"] == 1
        assert bd["Азовского моря"] == 13

    def test_greedy_count_fallback_does_not_swallow_next_item(self):
        # Regression guard for the parse_breakdown cursor-loop: _COUNT_GROUP
        # is greedy up to 3 words, so non-numeral phrases like "беспилотных
        # летательных аппаратов" can match as the count, get rejected by
        # _count_to_int, and previously took the FOLLOWING valid item with
        # them when findall() advanced past the entire failed match. The
        # manual cursor advances by 1 char on failure instead.
        r = _parse(
            "С 8.00 мск до 9.40 мск дежурными средствами ПВО уничтожены "
            "шесть украинских беспилотных летательных аппаратов самолетного типа: "
            "два БПЛА – над территорией Московского региона, "
            "один БПЛА – над территорией Рязанской области, "
            "один БПЛА – над территорией Нижегородской области, "
            "один БПЛА – над территорией Смоленской области и "
            "один БПЛА – над территорией Курской области.",
            posted_utc="2025-07-05T05:00:00+00:00",
        )
        bd = dict(r.breakdown)
        assert sum(bd.values()) == 6
        assert bd["Московского региона"] == 2

    def test_iz_kotorykh_connective_before_count(self):
        # msg 47131 (Dec 2024): "уничтожены N БПЛА, из которых девять
        # сбиты над …". The greedy count group absorbed "из которых" as
        # extra words, and _count_to_int previously rejected the whole
        # phrase because "из" isn't a numeral. Fixed by stripping leading
        # non-numeral words in _count_to_int so the trailing numeral wins.
        r = _parse(
            "В течение прошедшей ночи дежурными средствами ПВО уничтожены "
            "19 украинских беспилотных летательных аппаратов, "
            "из которых девять сбиты над территорией Белгородской области, "
            "пять – над территорией Воронежской области, "
            "три – над акваторией Черного моря "
            "и по одному – над территориями Курской области и Краснодарского края.",
            posted_utc="2024-12-30T05:00:00+00:00",
        )
        bd = dict(r.breakdown)
        assert sum(bd.values()) == 19
        assert bd["Белгородской области"] == 9
        assert bd["Воронежской области"] == 5
        assert bd["Черного моря"] == 3
        assert bd["Курской области"] == 1
        assert bd["Краснодарского края"] == 1

    def test_no_bullets_multi_verb_post(self):
        # msg 47783 (Jan 2025): no ▫/▪ bullets at all, items separated by
        # commas and periods, plus three different verbs (уничтожен,
        # сбиты/сбито, перехвачены) and a multi-word numeral ("Тридцать
        # один"). Stresses the count's greedy expansion (must include
        # "один" but stop before "БПЛА" or any verb) and the PO_ITEM_RE
        # backwards span-extension over a preceding " и " conjunction.
        r = _parse(
            "В течение прошедшей ночи дежурными средствами ПВО перехвачены и "
            "уничтожены 85 украинских беспилотных летательных аппаратов. "
            "Тридцать один БпЛА уничтожен над акваторией Черного моря, "
            "по шестнадцать БпЛА сбиты над территориями Воронежской области и Краснодарского края, "
            "четырнадцать – над акваторией Азовского моря, "
            "четыре – над территорией Белгородской области, "
            "два БпЛА перехвачены над территорией Тамбовской области "
            "и по одному сбито над территориями Республики Крым и Курской области.",
            posted_utc="2025-01-23T05:00:00+00:00",
        )
        bd = dict(r.breakdown)
        assert sum(bd.values()) == 85
        assert bd["Черного моря"] == 31
        assert bd["Воронежской области"] == 16
        assert bd["Краснодарского края"] == 16
        assert bd["Азовского моря"] == 14
        assert bd["Белгородской области"] == 4
        assert bd["Тамбовской области"] == 2
        assert bd["Республики Крым"] == 1
        assert bd["Курской области"] == 1

    def test_trailing_dashed_item_joined_by_conjunction(self):
        # "… и <count> – над …" boundary (no БПЛА), msg 48889 / 48760 /
        # 48594 (Feb 2025). REGION_ITEM_RE's region group otherwise greedily
        # consumes " и один – над територiей Воронежской области" into the
        # previous item.
        r = _parse(
            "В период с 10.50 до 13.30 мск дежурными средствами ПВО уничтожены "
            "шесть украинских беспилотных летательных аппаратов: "
            "три БПЛА – над территорией Белгородской области, "
            "два – над территорией Курской области "
            "и один – над территорией Воронежской области.",
            posted_utc="2025-02-14T13:35:00+00:00",
        )
        bd = dict(r.breakdown)
        assert bd == {"Белгородской области": 3, "Курской области": 2, "Воронежской области": 1}

    def test_trailing_item_joined_by_conjunction_with_nad(self):
        # "… и <count> над …" boundary (no dash AND no БПЛА), msg 48494 (Feb
        # 2025). Same family as above but the trailing item drops the dash
        # entirely.
        r = _parse(
            "В течение прошедшей ночи дежурными средствами ПВО уничтожены "
            "три украинских беспилотных летательных аппаратов: "
            "два БПЛА – над территорией Белгородской области "
            "и один над территорией Курской области.",
            posted_utc="2025-02-03T05:00:00+00:00",
        )
        bd = dict(r.breakdown)
        assert bd == {"Белгородской области": 2, "Курской области": 1}

    def test_po_stops_at_comma_separated_next_item(self):
        # PO_ITEM_RE's region group allows commas (for the multi-region
        # tail), but a comma followed by "<count> БПЛА – над …" is a NEW
        # item, not a region in the current "по" phrase. msg 48833 (Feb 2025).
        r = _parse(
            "В течение прошедшей ночи дежурными средствами ПВО уничтожены "
            "33 украинских беспилотных летательных аппарата: "
            "по 12 БПЛА – над территориями Курской и Липецкой областей, "
            "9 БПЛА – над территорией Тверской области.",
            posted_utc="2025-02-13T05:00:00+00:00",
        )
        bd = dict(r.breakdown)
        assert bd == {
            "Курской области": 12, "Липецкой области": 12, "Тверской области": 9,
        }

    def test_ukrainian_adjective_between_count_and_bpla(self):
        # The MoD usually drops "украинских" in per-region bullets but
        # occasionally repeats it ("19 украинских БпЛА – над …", msg 49133,
        # Feb 2025) — the regex's optional _UA_OPT clause tolerates either.
        r = _parse(
            "В период с 15.30 до 19.30 мск дежурными средствами ПВО уничтожены "
            "28 украинских беспилотных летательных аппаратов: "
            "19 украинских БпЛА – над территорией Краснодарского края, "
            "8 БпЛА – над акваторией Азовского моря "
            "и один БпЛА над территорией Белгородской области.",
            posted_utc="2025-02-20T19:35:00+00:00",
        )
        bd = dict(r.breakdown)
        assert bd == {
            "Краснодарского края": 19, "Азовского моря": 8, "Белгородской области": 1,
        }

    def test_po_phrase_stops_at_conjunction_po(self):
        # Trailing "и по <count>" boundary (no БПЛА before the dash) —
        # msg 49931 (Mar 2025). Adding the "и по" alternation alongside
        # bare "по" so the conjunction doesn't get consumed into the region.
        r = _parse(
            "В течение прошедшей ночи дежурными средствами ПВО перехвачены и "
            "уничтожены шесть украинских беспилотных летательных аппаратов: "
            "по два БпЛА уничтожены над территориями Воронежской и Орловской областей "
            "и по одному – над территориями Белгородской и Курской областей.",
            posted_utc="2025-03-10T05:00:00+00:00",
        )
        bd = dict(r.breakdown)
        assert bd == {
            "Воронежской области": 2, "Орловской области": 2,
            "Белгородской области": 1, "Курской области":  1,
        }

    def test_footer_summary_after_emoji_is_ignored(self):
        # Some posts append a "📊 Всего за время налета … 26.05 над
        # российскими регионами сбито 148 …" footer summarising a wider
        # window. The embedded date suffix (".05") used to be matched as a
        # count and "российскими регионами сбито" as its region. Truncating
        # at the bar-chart emoji before scanning drops the footer entirely.
        # msg 53129 (May 2025).
        r = _parse(
            "В период с 20.00 мск 25.05 дежурными средствами ПВО перехвачены "
            "и уничтожены 5 украинских беспилотных летательных аппаратов "
            "самолетного типа: ▪️ 3 БПЛА – над территорией Брянской области, "
            "▪️ 2 БПЛА – над территорией Курской области. "
            "📊 Всего за время налета в период с 10.00 мск 25.05 до 8.00 мск 26.05 "
            "над российскими регионами сбито 148 украинских БпЛА самолетного типа.",
            posted_utc="2025-05-26T05:00:00+00:00",
        )
        bd = dict(r.breakdown)
        assert bd == {"Брянской области": 3, "Курской области": 2}

    def test_duplicate_region_names_are_merged(self):
        # When a "по" bullet's expansion includes a region that ALSO appears
        # in a single-region bullet, the two rows must merge (summed count)
        # rather than crashing the (post_id, scraped_at, region) PK in
        # ad_regions on insert. Triggered by a real Jun–Jul 2025 post.
        r = _parse(
            "В течение прошедшей ночи дежурными средствами ПВО перехвачены и уничтожены "
            "20 украинских беспилотных летательных аппаратов самолетного типа: "
            "▫️ 4 БПЛА – над территорией Брянской области, "
            "▫️ По 8 БПЛА – над территориями Брянской и Тульской областей.",
            posted_utc="2025-07-15T05:00:00+00:00",
        )
        bd = dict(r.breakdown)
        assert bd["Брянской области"] == 12  # 4 from singleton + 8 from "по" expansion
        assert bd["Тульской области"] == 8
        # No duplicate keys reach the caller — that's the whole point.
        assert len(r.breakdown) == len({n for n, _ in r.breakdown})

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

    def _overlapping_pair(self):
        evening = _parse("С 08.00 до 23.00 мск дежурными средствами ПВО перехвачены и уничтожены "
                         "38 украинских беспилотных летательных аппаратов над территориями Брянской области.",
                         mid=1, posted_utc="2026-05-14T20:45:00+00:00")
        night = _parse("В период с 20.00 мск 14 мая до 7.00 мск 15 мая дежурными средствами ПВО "
                       "перехвачены и уничтожены 355 украинских беспилотных летательных аппаратов "
                       "над территориями Белгородской области.",
                       mid=2, posted_utc="2026-05-15T05:57:00+00:00")
        return evening, night

    def test_breakdown_mismatch_detected(self, tmp_path, capsys):
        # Total says 100 but only 50 is itemized → a missed/partial breakdown the
        # scraper should flag (run vs DB total), with the post id and the sums.
        import sqlite3
        db = tmp_path / "ad.db"
        r = _parse(
            "В течение прошедшей ночи дежурными средствами ПВО перехвачены и уничтожены "
            "100 украинских беспилотных летательных аппаратов самолетного типа: "
            "▫️ 30 – над территорией Брянской области, ▫️ 20 – над территорией Курской области.",
            mid=999, posted_utc="2026-03-09T05:00:00+00:00",
        )
        ig.store(db, [r])
        msg = capsys.readouterr().err
        assert "don't sum to the total" in msg and "post 999: 50/100" in msg
        conn = sqlite3.connect(db)
        m = ig._breakdown_mismatches(conn)
        conn.close()
        assert len(m) == 1 and (m[0][2], m[0][3]) == (100, 50)

    def test_overlap_report_distinguishes_run_vs_total(self, tmp_path, capsys):
        db = tmp_path / "ad.db"
        evening, night = self._overlapping_pair()
        # First run inserts both → the overlap is NEW this run, named with its ids.
        ig.store(db, [evening, night])
        msg = capsys.readouterr().err
        assert "THIS run" in msg and "post 2 (overlaps 1)" in msg

        # Second run re-stores the same posts → nothing inserted → pre-existing only.
        ig.store(db, [evening, night])
        msg = capsys.readouterr().err
        assert "none new this run" in msg and "THIS run" not in msg


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
