"""
Unit tests for the @GeneralStaffZSU parser.

These lock in the wording variants we've already taught the parser to
handle. Each test case is keyed (in a comment) to a real msg id in the
archive so a regression is easy to investigate.

Run with: pytest -v test_scrape_general_staff.py
"""
import logging
from datetime import datetime
from types import SimpleNamespace

import scrape_general_staff as gs


def _msg(text: str, mid: int = 1, posted_utc: str = "2026-05-01T19:00:00+00:00"):
    """Build a minimal stand-in for a Telethon Message."""
    return SimpleNamespace(id=mid, date=datetime.fromisoformat(posted_utc), text=text)


def _wrap_evening(body: str) -> str:
    """Wrap a body fragment in a plausible 22:00 evening report."""
    return (
        "Оперативна інформація станом на 22:00 01.05.2026 щодо російського вторгнення\n"
        "Загалом від початку цієї доби відбулося 100 бойових зіткнень.\n"
        f"{body}\n"
        "На Покровському напрямку відбито атаки."
    )


# ---------------------------------------------------------------------------
# is_operational_report — the gating filter
# ---------------------------------------------------------------------------

class TestGate:
    def test_morning_daily(self):
        text = (
            "Оперативна інформація станом на 08:00 02.05.2026 щодо російського вторгнення\n"
            "Загалом протягом минулої доби зафіксовано 138 бойових зіткнень."
        )
        assert gs.is_operational_report(text)

    def test_evening_same_day(self):
        text = (
            "Оперативна інформація станом на 22:00 01.05.2026 щодо російського вторгнення\n"
            "Загалом від початку цієї доби відбулося 114 бойових зіткнень."
        )
        assert gs.is_operational_report(text)

    def test_midday_compound_spelling(self):
        # msg 38983 — short midday update using compound "боєзіткнення"
        text = (
            "Оперативна інформація станом на 16:00 22.05.2026 щодо російського вторгнення\n"
            "Від початку доби агресор 54 рази атакував позиції Сил оборони.\n"
            "На Покровському напрямку триває одне боєзіткнення."
        )
        assert gs.is_operational_report(text)

    def test_neuter_singular(self):
        # msg 38098 — "141 бойове зіткнення"
        text = (
            "Оперативна інформація станом на 08:00 03.05.2026 щодо російського вторгнення\n"
            "Загалом протягом минулої доби зафіксовано 141 бойове зіткнення."
        )
        assert gs.is_operational_report(text)

    def test_non_report_short(self):
        assert not gs.is_operational_report("Героям слава!")

    def test_non_report_announcement(self):
        # Sample of the kind of post the channel publishes alongside reports.
        text = "Слава Україні! Приєднуйтеся до Сил оборони — деталі за посиланням."
        assert not gs.is_operational_report(text)

    def test_non_report_specialised_no_snapshot_header(self):
        # msg 19345 — "Оперативна інформація про ведення бойових дій в зоні
        # відповідальності ОСУВ 'Хортиця': Курахове." Says "Оперативна
        # інформація" but has no "станом на HH:MM …" header. Not a daily
        # situation report.
        text = (
            "Оперативна інформація про ведення бойових дій в зоні "
            "відповідальності ОСУВ 'Хортиця': Курахове.\n"
            "Від початку доби в районі Курахового відбулося 10 боєзіткнень."
        )
        assert not gs.is_operational_report(text)

    def test_2024_markdown_bold_header(self):
        # Late-2024 posts wrapped the header in **bold**. The gate must
        # still accept them.
        text = (
            "**Оперативна інформація станом на 08.00 01.11.2024 щодо "
            "російського вторгнення**\n"
            "Загалом, протягом минулої доби зафіксовано **170 бойових зіткнень.**\n"
            "На **Покровському напрямку** триває одне боєзіткнення."
        )
        assert gs.is_operational_report(text)

    def test_non_report_press_statement(self):
        # msg 23523 — Kursk operation press statement. Mentions "бойове
        # зіткнення" and "Від початку доби" in narrative prose but never says
        # "Оперативна інформація". Real situation reports always start with
        # that phrase, so the gate must reject this.
        text = (
            "Повідомлення представників вищого командування країни-агресорки "
            "про нібито завершення бойових дій не відповідають дійсності. "
            "Оборонна операція Сил оборони України триває. "
            "Від початку доби в операційній зоні відбито п'ять штурмових дій "
            "противника, ще одне таке бойове зіткнення наразі триває."
        )
        assert not gs.is_operational_report(text)

    def test_non_report_commander_quote(self):
        # msg 30252 — a Сирський quote about the Pokrovsk operation. Mentions
        # "протягом минулої доби" and quotes "станом на 06.00 13 жовтня 2025"
        # inside a parenthetical, but never says "Оперативна інформація".
        # Not a situation report and must not be classified as one.
        text = (
            "Попри невдалі намагання ворога просунутися на деяких напрямках, "
            "нашими воїнами протягом минулої доби проведено пошук та знищення противника...\n"
            "Довідково: Загалом за час Добропільської операції, станом на 06.00 "
            "13 жовтня 2025 року, звільнено 182.4 кв км. - Головнокомандувач ЗС України"
        )
        assert not gs.is_operational_report(text)


# ---------------------------------------------------------------------------
# _parse_snapshot — date / snapshot_at / header-typo detection
# ---------------------------------------------------------------------------

class TestSnapshot:
    def test_dotted_numeric_morning_shifts_back(self):
        text = (
            "Оперативна інформація станом на 08:00 02.05.2026 щодо російського вторгнення\n"
            "Загалом протягом минулої доби зафіксовано 100 бойових зіткнень."
        )
        msg_date = datetime.fromisoformat("2026-05-02T05:01:00+00:00")
        date, snap, note = gs._parse_snapshot(text, msg_date)
        assert date == "2026-05-01"
        assert snap == "2026-05-02T08:00:00"
        assert note is None

    def test_dotted_numeric_evening_same_day(self):
        text = (
            "Оперативна інформація станом на 22:00 01.05.2026 щодо російського вторгнення\n"
            "Загалом від початку цієї доби відбулося 100 бойових зіткнень."
        )
        msg_date = datetime.fromisoformat("2026-05-01T19:00:00+00:00")
        date, snap, _ = gs._parse_snapshot(text, msg_date)
        assert date == "2026-05-01"
        assert snap == "2026-05-01T22:00:00"

    def test_midday_same_day(self):
        text = (
            "Оперативна інформація станом на 16:00 22.05.2026 щодо російського вторгнення\n"
            "Від початку доби агресор 50 разів атакував."
        )
        msg_date = datetime.fromisoformat("2026-05-22T13:00:00+00:00")
        date, snap, _ = gs._parse_snapshot(text, msg_date)
        assert date == "2026-05-22"
        assert snap == "2026-05-22T16:00:00"

    def test_ukrainian_month_format(self):
        # Older posts use the Ukrainian-month form.
        text = "Оперативна інформація станом на 22:00 9 травня 2026 щодо вторгнення."
        msg_date = datetime.fromisoformat("2026-05-09T19:00:00+00:00")
        date, snap, _ = gs._parse_snapshot(text, msg_date)
        assert date == "2026-05-09"
        assert snap == "2026-05-09T22:00:00"

    def test_dot_separator_in_time(self):
        # msg 34730: "16.00" instead of "16:00".
        text = "Оперативна інформація станом на 16.00 06.02.2026 щодо вторгнення."
        msg_date = datetime.fromisoformat("2026-02-06T13:12:00+00:00")
        date, snap, _ = gs._parse_snapshot(text, msg_date)
        assert snap == "2026-02-06T16:00:00"
        assert date == "2026-02-06"

    def test_header_typo_detected_and_corrected(self):
        # msg 37065 reality: posted 09 Apr morning, header claims 08.04.2026.
        text = (
            "Оперативна інформація станом на 08:00 08.04.2026 щодо російського вторгнення\n"
            "Загалом протягом минулої доби зафіксовано 100 бойових зіткнень."
        )
        msg_date = datetime.fromisoformat("2026-04-09T05:02:00+00:00")
        date, snap, note = gs._parse_snapshot(text, msg_date)
        # Snapshot rewritten to 09 Apr; morning shift takes the report day to 08 Apr.
        assert snap == "2026-04-09T08:00:00"
        assert date == "2026-04-08"
        assert note is not None and "header_typo" in note

    def test_late_post_across_midnight_is_not_a_typo(self):
        # msg 28416: 22:00 29-Aug report posted 00:03 Kyiv on 30-Aug (only
        # 2h late). The header is correct — the typo detector mustn't fire
        # just because the post crossed the midnight boundary.
        text = (
            "Оперативна інформація станом на 22:00 29.08.2025 щодо російського вторгнення\n"
            "Загалом від початку цієї доби відбулося 100 бойових зіткнень."
        )
        msg_date = datetime.fromisoformat("2025-08-29T21:03:00+00:00")  # 00:03 Kyiv 30-Aug
        date, snap, note = gs._parse_snapshot(text, msg_date)
        assert snap == "2025-08-29T22:00:00"
        assert date == "2025-08-29"
        assert note is None

    def test_no_header_returns_nones(self):
        date, snap, note = gs._parse_snapshot("not a report", datetime.now().astimezone())
        assert date is None and snap is None and note is None


# ---------------------------------------------------------------------------
# parse_summary — combat_engagements variants
#
# Every variant we've encountered in the wild, locked in so future regex
# tweaks don't silently drop one.
# ---------------------------------------------------------------------------

class TestCombatEngagements:
    def _parse(self, body: str, hour: str = "08:00", header_date: str = "01.05.2026"):
        # Trailing per-direction line gives the gate a "боєзіткнен" match so
        # any body phrasing (digit aggregate, midday "ворог N разів", ...)
        # still passes is_operational_report.
        text = (
            f"Оперативна інформація станом на {hour} {header_date} щодо російського вторгнення\n"
            f"{body}\n"
            "На Покровському напрямку триває одне боєзіткнення."
        )
        return gs.parse_summary(text, _msg(text))

    def test_daily_aggregate(self):
        # msg 38052
        s = self._parse("Загалом протягом минулої доби зафіксовано 138 бойових зіткнень.")
        assert s.combat_engagements == 138

    def test_neuter_singular(self):
        # msg 38098: "141 бойове зіткнення"
        s = self._parse("Загалом протягом минулої доби зафіксовано 141 бойове зіткнення.")
        assert s.combat_engagements == 141

    def test_evening_from_start_of_day(self):
        s = self._parse(
            "Загалом від початку цієї доби відбулося 114 бойових зіткнень.",
            hour="22:00",
        )
        assert s.combat_engagements == 114

    def test_midday_agressor_atakuvav(self):
        # msg 38983
        s = self._parse(
            "Від початку доби агресор 54 рази атакував позиції Сил оборони.",
            hour="16:00",
        )
        assert s.combat_engagements == 54

    def test_midday_okupanty_atakuvaly(self):
        # msg 35273
        s = self._parse(
            "Від початку доби загалом окупанти атакували 75 разів.",
            hour="16:00",
        )
        assert s.combat_engagements == 75

    def test_midday_kilkist_stanovyt(self):
        # msg 38088
        s = self._parse(
            "Від початку доби кількість атак агресора становить 51.",
            hour="16:00",
        )
        assert s.combat_engagements == 51

    def test_midday_kilkist_rosijskogo_agresora(self):
        # msg 35700
        s = self._parse(
            "Від початку доби кількість атак російського агресора становить 56.",
            hour="16:00",
        )
        assert s.combat_engagements == 56

    def test_midday_kilkist_vzhe(self):
        # msg 36774
        s = self._parse(
            "Від початку доби кількість атак агресора вже становить 64.",
            hour="16:00",
        )
        assert s.combat_engagements == 64

    def test_midday_kilkist_uzhe(self):
        # msg 35658 — spelling variant of "вже"
        s = self._parse(
            "Від початку доби кількість атак агресора уже становить 48.",
            hour="16:00",
        )
        assert s.combat_engagements == 48

    def test_midday_vorozhykh_atak_skladaie(self):
        # msg 34840
        s = self._parse(
            "Від початку доби кількість ворожих атак складає 74.",
            hour="16:00",
        )
        assert s.combat_engagements == 74

    def test_midday_boеzitknen_skladaie(self):
        # msg 34953
        s = self._parse(
            "Від початку доби кількість боєзіткнень складає 60.",
            hour="16:00",
        )
        assert s.combat_engagements == 60

    def test_midday_zagalna_kilkist_stanovyt(self):
        # msg 35236
        s = self._parse(
            "На цей час загальна кількість бойових зіткнень становить 51.",
            hour="16:00",
        )
        assert s.combat_engagements == 51

    def test_midday_kilkist_with_adverbial_fill(self):
        # msg 33284: phrase between the noun and "становить".
        s = self._parse(
            "З початку доби загальна кількість бойових зіткнень "
            "уздовж усієї лінії фронту становить 45.",
            hour="16:00",
        )
        assert s.combat_engagements == 45

    def test_daily_aggregate_compound_form(self):
        # msg 32131: "зафіксовано 201 боєзіткнення" (compound spelling in the
        # daily aggregate; earlier months alternate between this and the
        # separated form).
        s = self._parse("Загалом протягом минулої доби зафіксовано 201 боєзіткнення.")
        assert s.combat_engagements == 201

    def test_daily_aggregate_compound_with_z_pochatku_doby_prefix(self):
        # msg 27719: same compound form but the prefix is "З початку доби"
        # (not "Загалом").
        s = self._parse("З початку доби відбулося 122 боєзіткнення.", hour="22:00")
        assert s.combat_engagements == 122

    def test_daily_aggregate_compound_with_comma_after_zagalom(self):
        # msg 27017 / 27108: "Загалом, протягом минулої доби зафіксовано N
        # боєзіткнення" — comma after Загалом, which broke the \s+ anchor.
        s = self._parse(
            "Загалом, протягом минулої доби зафіксовано 191 боєзіткнення."
        )
        assert s.combat_engagements == 191

    def test_daily_aggregate_word_form_count(self):
        # msg 24737: "Загалом від початку доби відбулося сто бойових
        # зіткнень" — count spelled as a word ("сто" = 100). Rare but real.
        s = self._parse(
            "Загалом від початку доби відбулося сто бойових зіткнень.",
            hour="16:00",
        )
        assert s.combat_engagements == 100

    def test_part_column_populated_for_part1(self):
        text = (
            "Оперативна інформація станом на 08.00 18.11.2024 щодо "
            "російського вторгнення (1/2)\n"
            "Загалом, протягом минулої доби зафіксовано 149 бойових зіткнень.\n"
            "На Покровському напрямку триває одне боєзіткнення."
        )
        s = gs.parse_summary(text, _msg(text, mid=18747))
        assert s.part == "1/2"
        assert s.combat_engagements == 149  # part 1 still has the aggregate

    def test_part_column_populated_for_continuation(self):
        text = (
            "Оперативна інформація станом на 08.00 18.11.2024 щодо "
            "російського вторгнення (2/2)\n"
            "На Покровському напрямку відбулось 33 боєзіткнення."
        )
        s = gs.parse_summary(text, _msg(text, mid=18748))
        assert s.part == "2/2"
        assert s.combat_engagements is None  # continuation: no aggregate

    def test_part_column_null_for_single_part(self):
        text = (
            "Оперативна інформація станом на 22:00 01.05.2026 щодо російського вторгнення\n"
            "Загалом від початку цієї доби відбулося 100 бойових зіткнень.\n"
            "На Покровському напрямку триває одне боєзіткнення."
        )
        s = gs.parse_summary(text, _msg(text))
        assert s.part is None

    def test_multipart_continuation_combat_is_none(self):
        # msg 18113: a (2/2) part 2 has no global aggregate but does have
        # per-direction "N бойових зіткнень" lines. Branch 1a would otherwise
        # grab the first per-direction digit. Must skip combat extraction
        # entirely for continuation parts.
        text = (
            "Оперативна інформація станом на 22.00 20.10.2024 щодо "
            "російського вторгнення (2/2)\n"
            "Найгарячіше зараз на Курахівському напрямку, на цей час доби "
            "нараховується 53 бойових зіткнення.\n"
            "На Времівському напрямку відбулося 11 боєзіткнень."
        )
        msg = _msg(text, mid=18113)
        # Gate accepts (it's still an operational report), but combat must be None.
        s = gs.parse_summary(text, msg)
        assert s is not None
        assert s.combat_engagements is None

    def test_midday_kilkist_word_fill_extended(self):
        # msg 16055: "Кількість бойових зіткнень по всій лінії фронту на цей
        # час складає 81" — 6 words between the noun and the verb (was 5
        # max before).
        s = self._parse(
            "Кількість бойових зіткнень по всій лінії фронту на цей час складає 81.",
            hour="16:00",
        )
        assert s.combat_engagements == 81

    def test_midday_kilkist_with_comma_and_ponad(self):
        # msg 15916: "Кількість бойових зіткнень по всій лінії фронту
        # зросла, і складає понад 90" — comma in the fill, "понад" before
        # the digit.
        s = self._parse(
            "Кількість бойових зіткнень по всій лінії фронту зросла, і складає понад 90.",
            hour="16:00",
        )
        assert s.combat_engagements == 90

    def test_midday_kilkist_vorozhykh_diy(self):
        # msg 16101: "загальна кількість ворожих наступальних та штурмових
        # дій вже зросла до 62" — new noun phrase: "ворожих <adj> та <adj> дій".
        s = self._parse(
            "На цей час загальна кількість ворожих наступальних та штурмових дій "
            "вже зросла до 62.",
            hour="16:00",
        )
        assert s.combat_engagements == 62

    def test_midday_okupanty_zdiisnyly_sprob(self):
        # msg 16316: "Загалом на цей час окупанти здійснили 83 спроб" —
        # new verb/noun combo for branch 3.
        s = self._parse(
            "Загалом на цей час окупанти здійснили 83 спроб витіснити наших воїнів.",
            hour="16:00",
        )
        assert s.combat_engagements == 83

    def test_multipart_square_brackets(self):
        # msgs 15895/15896/16070: header uses [1/2] / [2/2] instead of (1/2).
        text = (
            "Оперативна інформація станом на 8.00 03.07.2024 щодо "
            "російського вторгнення [1/2]\n"
            "Протягом минулої доби зафіксовано 158 бойових зіткнень.\n"
            "На Покровському напрямку триває одне боєзіткнення."
        )
        s = gs.parse_summary(text, _msg(text, mid=15895))
        assert s.part == "1/2"
        assert s.combat_engagements == 158

    def test_midday_kilkist_with_adjective(self):
        # msg 17760: "На цей час кількість сьогоднішніх бойових зіткнень
        # зросла до 88" — an adjective ("сьогоднішніх") sits between
        # "кількість" and the noun phrase.
        s = self._parse(
            "На цей час кількість сьогоднішніх бойових зіткнень зросла до 88.",
            hour="16:00",
        )
        assert s.combat_engagements == 88

    def test_midday_zrosla_do_verb(self):
        # msgs 20188 / 20243 / 20265 / 20350 / 20376 / 21498 — early-2025
        # 16:00 posts use the verb "зросла до" ("has risen to") instead of
        # становить/складає.
        s = self._parse(
            "З початку доби загальна кількість бойових зіткнень "
            "вздовж усієї лінії фронту зросла до 82.",
            hour="16:00",
        )
        assert s.combat_engagements == 82

    def test_morning_aggregate_with_vchora_prefix(self):
        # msg 21220: morning aggregate uses "Вчора відбулось N боєзіткнення"
        # (no Загалом/З/Від prefix; "Вчора" plays the same role).
        s = self._parse("Вчора відбулось 121 боєзіткнення.")
        assert s.combat_engagements == 121

    def test_2024_bolded_digit_in_separated_aggregate(self):
        # msg 18834: "Протягом минулої доби відбулось **190** бойових
        # зіткнень" — the digit itself is bolded. Strip ** first, then 1a
        # catches it.
        s = self._parse("Протягом минулої доби відбулось **190** бойових зіткнень.")
        assert s.combat_engagements == 190

    def test_midday_za_sjogodni_vorozhykh_atak(self):
        # msg 17362: "За сьогодні відбулося 123 ворожих атаки" — a Sep-2024
        # midday phrasing with both a new prefix ("За сьогодні") and a new
        # noun ("ворожих атак").
        s = self._parse("За сьогодні відбулося 123 ворожих атаки.", hour="16:00")
        assert s.combat_engagements == 123

    def test_2024_bolded_verb_in_kilkist_form(self):
        # msg 18860: "З початку доби **загальна кількість бойових зіткнень**
        # вздовж усієї лінії фронту **зросла до 125**" — verb is bolded.
        s = self._parse(
            "З початку доби **загальна кількість бойових зіткнень** "
            "вздовж усієї лінії фронту **зросла до 125**.",
            hour="16:00",
        )
        assert s.combat_engagements == 125

    def test_daily_aggregate_compound_does_not_match_per_direction(self):
        # Regression: a per-direction "На X напрямку відбулось N боєзіткнень"
        # line must NOT trigger the compound-form aggregate branch even when
        # the post also contains "З початку доби" somewhere.
        s = self._parse(
            "З початку доби загальна кількість бойових зіткнень "
            "уздовж усієї лінії фронту становить 45.\n"
            "На Гуляйпільському напрямку відбулось 14 боєзіткнень в районі населеного пункту Солодке.",
            hour="16:00",
        )
        assert s.combat_engagements == 45

    def test_daily_aggregate_does_not_match_per_direction_mid_sentence(self):
        # msg 25671 regression: per-direction mini-aggregates use the same
        # phrasing mid-sentence ("На X напрямках з початку доби відбулося
        # дев'ять боєзіткнень"). The global aggregate must win — line-start
        # anchoring is what disambiguates them.
        s = self._parse(
            "Станом на цей час загальна кількість бойових зіткнень становить 88.\n"
            "Сьогодні постраждали населені пункти.\n"
            "На Північно-Слобожанському і Курському напрямках з початку доби "
            "відбулося дев'ять боєзіткнень.",
            hour="16:00",
        )
        assert s.combat_engagements == 88

    def test_midday_vorog_instead_of_agresor(self):
        # msg 32565: midday uses "ворог" instead of "агресор".
        s = self._parse(
            "На даний час ворог 95 разів атакував позиції Сил оборони.",
            hour="16:00",
        )
        assert s.combat_engagements == 95

    def test_midday_vorog_singular_raz(self):
        # msg 32611: "ворог 71 раз атакував" — singular "раз" (no suffix).
        s = self._parse(
            "На даний час ворог 71 раз атакував позиції Сил оборони.",
            hour="16:00",
        )
        assert s.combat_engagements == 71

    def test_midday_does_not_overmatch_per_direction(self):
        # Regression: when the daily aggregate uses "кількість X становить N",
        # a per-direction "ворог N разів атакував позиції наших захисників"
        # line must NOT be picked up instead. (msg 33310 broke when "ворог"
        # was first added to the aggregate pattern.)
        s = self._parse(
            "З початку доби загальна кількість бойових зіткнень "
            "уздовж усієї лінії фронту становить 45.\n"
            "На Покровському напрямку сьогодні ворог 14 разів атакував "
            "позиції наших захисників у районах населених пунктів.",
            hour="16:00",
        )
        assert s.combat_engagements == 45

    def test_midday_dash_form(self):
        # msgs 15154, 15340: Jun-2024 dash form
        # "кількість бойових зіткнень на лінії [фронту|бойового зіткнення] - N"
        # — verb position taken by a bare " - ".
        s = self._parse(
            "Від початку доби загальна кількість бойових зіткнень "
            "на лінії бойового зіткнення - 59.",
            hour="13:30",
        )
        assert s.combat_engagements == 59

    def test_midday_dash_form_linii_frontu(self):
        # msg 15340 variant of the dash form: "на лінії фронту - 51".
        s = self._parse(
            "Загальна кількість бойових зіткнень на лінії фронту - 51.",
            hour="13:00",
        )
        assert s.combat_engagements == 51

    def test_midday_zbilshilas_do_verb(self):
        # msg 15710: new verb "збільшилась вже до" — "кількість бойових
        # зіткнень на всій лінії фронту збільшилась вже до 96".
        s = self._parse(
            "Кількість бойових зіткнень на всій лінії фронту збільшилась вже до 96.",
            hour="19:00",
        )
        assert s.combat_engagements == 96

    def test_midday_dosyahla_verb(self):
        # msg 15831: new verb "досягла" — "загальна кількість ворожих атак
        # на лінії бойового зіткнення досягла 73".
        s = self._parse(
            "Наразі загальна кількість ворожих атак на лінії бойового зіткнення досягла 73.",
            hour="13:00",
        )
        assert s.combat_engagements == 73

    def test_midday_zaharbnyky_atakuvaly_pozitsii(self):
        # msg 15275: "З початку доби російські загарбники 44 рази атакували
        # позиції українських захисників" — global aggregate using a new
        # subject ("загарбники") and a new suffix ("українських захисників").
        # Branch 2b anchors on "З/Від початку доби" at line start.
        s = self._parse(
            "З початку доби російські загарбники 44 рази атакували "
            "позиції українських захисників.",
            hour="13:30",
        )
        assert s.combat_engagements == 44

    def test_midday_zaharbnyky_tolerates_markdown_gap(self):
        # msg 15275 had `доби** російські` — markdown bolding splits the
        # whitespace between "доби" and "російські". Branch 2b uses [^\w]*
        # so the asterisks don't break the anchor.
        s = self._parse(
            "З початку доби** російські загарбники 44 рази атакували "
            "позиції українських захисників**.",
            hour="13:30",
        )
        assert s.combat_engagements == 44

    def test_zaharbnyky_does_not_overmatch_per_direction(self):
        # msgs 19258, 30651, 30724, 31850 regression: per-direction sections
        # often say "ворог N разів атакував позиції українських захисників".
        # Branch 2b must NOT fire on that — only on the global aggregate
        # that starts a paragraph with "З/Від початку доби".
        body = (
            "Загалом протягом минулої доби зафіксовано 150 бойових зіткнень.\n"
            "На Лиманському напрямку загарбники 30 разів атакували "
            "позиції українських захисників. Намагалися вклинитися "
            "в нашу оборону."
        )
        s = self._parse(body)
        assert s.combat_engagements == 150

    def test_midday_zbilshilasa_long_form(self):
        # msg 14631: "Кількість бойових зіткнень збільшилася до 12" —
        # long reflexive form (-ся) alongside the short -сь in branch 4.
        s = self._parse(
            "Кількість бойових зіткнень збільшилася до 12.",
            hour="17:00",
        )
        assert s.combat_engagements == 12

    def test_morning_protyvnyk_proviv_n_atak(self):
        # msg 14638: "За поточну добу противник провів 31 атаку позицій
        # наших військ на X, Y, Z напрямках" — new subject ("противник
        # провів") and noun ("N атак[у]"), anchored by branch 2c on
        # the day-marker preamble.
        s = self._parse(
            "За поточну добу противник провів 31 атаку позицій наших військ "
            "на Харківському, Куп'янському, Лиманському напрямках.",
            hour="10:00",
        )
        assert s.combat_engagements == 31

    def test_midday_okupanty_zdiisnyly_vzhe_potochnoyi_doby(self):
        # msg 14854: "Поточної доби окупанти здійснили вже 53 спроби
        # просунутись уперед" — branch 3b. The new branch 3b is restricted
        # to the "Поточної доби" preamble specifically because the more
        # common "З/Від початку доби" overlaps with per-direction usage.
        s = self._parse(
            "Поточної доби окупанти здійснили вже 53 спроби просунутись уперед.",
            hour="17:00",
        )
        assert s.combat_engagements == 53

    def test_midday_okupanty_zdiisnyly_vzhe_does_not_match_z_pochatku_doby(self):
        # Regression for msg 15811's per-direction false-positive:
        # "На Покровському напрямку … З початку доби окупанти здійснили
        # вже 28 спроб потіснити …" must NOT match branch 3b. The
        # surrounding text has a global aggregate that branch 4 catches.
        s = self._parse(
            "Кількість бойових зіткнень по всій лінії фронту зросла до 102.\n"
            "На Покровському напрямку найбільша кількість боєзіткнень. "
            "З початку доби окупанти здійснили вже 28 спроб потіснити наших захисників.",
            hour="16:00",
        )
        assert s.combat_engagements == 102

    def test_midday_verbless_stanom_na_zaraz(self):
        # msg 14881: "Загальна кількість бойових зіткнень станом на
        # зараз 73" — verbless nominal connector "станом на <word>".
        s = self._parse(
            "Загальна кількість бойових зіткнень станом на зараз 73.",
            hour="16:00",
        )
        assert s.combat_engagements == 73

    def test_midday_verbless_stanom_na_tsey_chas(self):
        # msg 15019: "Загальна кількість бойових зіткнень станом на зараз
        # зросла до 60" — covered by the existing "зросла до" verb option
        # plus extended "станом на" fill. Also a sanity check that the
        # multi-word "станом на цей час" form would work.
        s = self._parse(
            "Загальна кількість бойових зіткнень станом на цей час складає 60.",
            hour="16:00",
        )
        assert s.combat_engagements == 60

    def test_midday_zrosla_with_interjection(self):
        # msg 14961: "Кількість бойових зіткнень по всій лінії фронту
        # зросла ще на десять, до 67" — verb "зросла до" with an
        # interjection "ще на десять," between "зросла" and "до".
        s = self._parse(
            "Кількість бойових зіткнень по всій лінії фронту зросла ще на десять, до 67.",
            hour="16:00",
        )
        assert s.combat_engagements == 67

    def test_multipart_backslash_marker(self):
        # msg 15456: channel typo'd the multipart separator as a backslash
        # — "(1\\2)" instead of "(1/2)". Parser should still register the part.
        text = (
            "Оперативна інформація станом на 13.00 16.06.2024 щодо "
            "російського вторгнення. (1\\2)\n"
            "З початку доби загальна кількість бойових зіткнень "
            "збільшилась до 51.\n"
            "На Покровському напрямку триває одне боєзіткнення."
        )
        s = gs.parse_summary(text, _msg(text, mid=15456))
        assert s.part == "1/2"
        assert s.combat_engagements == 51


# ---------------------------------------------------------------------------
# parse_summary — other metrics
# ---------------------------------------------------------------------------

class TestMetrics:
    def _parse(self, body: str):
        text = _wrap_evening(body)
        return gs.parse_summary(text, _msg(text))

    def test_kabs_contracted_aviabomb(self):
        # msg 38052
        s = self._parse("Противник скинув 270 керованих авіабомб.")
        assert s.kabs_dropped == 270

    def test_kabs_accusative_singular(self):
        # msg 38096
        s = self._parse("Противник скинув 151 керовану авіабомбу.")
        assert s.kabs_dropped == 151

    def test_kabs_classic_long_form(self):
        s = self._parse("Скинув 312 керованих авіаційних бомб.")
        assert s.kabs_dropped == 312

    def test_kabs_bare_token(self):
        s = self._parse("Завдав авіаудару, скинувши 7 КАБ.")
        assert s.kabs_dropped == 7

    def test_mlrs_en_dash_and_iz(self):
        # msg 38052
        s = self._parse(
            "Здійснив 3000 обстрілів, зокрема 42 – із реактивних систем залпового вогню."
        )
        assert s.mlrs_shellings == 42

    def test_mlrs_classic_rszv(self):
        s = self._parse("У тому числі 8 — з РСЗВ.")
        assert s.mlrs_shellings == 8

    def test_air_strikes_genitive_singular(self):
        # msg 38719
        s = self._parse("Противник завдав 51 авіаційного удару.")
        assert s.air_strikes == 51

    def test_air_strikes_plural(self):
        s = self._parse("Противник завдав 89 авіаційних ударів.")
        assert s.air_strikes == 89

    def test_missile_strikes_word_form(self):
        # msg 38098
        s = self._parse("Вчора противник завдав одного ракетного удару.")
        assert s.missile_strikes == 1

    def test_missiles_used_word_form(self):
        # msg 38098
        s = self._parse(
            "Завдав одного ракетного удару із застосуванням однієї ракети."
        )
        assert s.missiles_used == 1

    def test_kamikaze_drones_en_dash(self):
        # msg 38096 — "дронів–камікадзе" with U+2013
        s = self._parse("Задіяв для ураження 5360 дронів–камікадзе.")
        assert s.kamikaze_drones == 5360

    def test_kamikaze_drones_ascii_hyphen(self):
        s = self._parse("Застосував 9976 дронів-камікадзе.")
        assert s.kamikaze_drones == 9976

    def test_shellings(self):
        s = self._parse("Здійснив 3379 обстрілів населених пунктів.")
        assert s.shellings == 3379


# ---------------------------------------------------------------------------
# parse_directions
# ---------------------------------------------------------------------------

class TestDirections:
    def test_paired_header_with_ta(self):
        text = _wrap_evening(
            "На Краматорському та Оріхівському напрямках ворог активних дій не проводив."
        )
        dirs = gs.parse_directions(text, _msg(text), "2026-05-01")
        labels = {d.direction for d in dirs}
        assert "Kramatorsk" in labels
        assert "Orikhiv" in labels

    def test_paired_header_with_i(self):
        text = _wrap_evening(
            "На Слобожанському і Курському напрямках відбулося три боєзіткнення."
        )
        dirs = gs.parse_directions(text, _msg(text), "2026-05-01")
        labels = {d.direction for d in dirs}
        assert "Slobozhanshchyna" in labels
        assert "Kursk" in labels

    def test_en_dash_inside_compound_name(self):
        # msg 38427: "Північно–Слобожанському" uses U+2013 instead of '-'
        text = _wrap_evening(
            "На Північно–Слобожанському і Курському напрямках ворог здійснив 5 атак."
        )
        dirs = gs.parse_directions(text, _msg(text), "2026-05-01")
        labels = {d.direction for d in dirs}
        # Both halves of the pair must be present (the en-dash mustn't break the regex).
        assert "Kursk" in labels
        assert any("lobozhansh" in d.direction.lower() for d in dirs)

    def test_stopword_tsomu_filtered(self):
        text = _wrap_evening("На цьому напрямку ворог активних дій не проводив.")
        dirs = gs.parse_directions(text, _msg(text), "2026-05-01")
        assert all(d.direction.lower() != "цьому" for d in dirs)

    def test_stopword_okremykh_filtered(self):
        text = _wrap_evening("На окремих напрямках ситуація стабільна.")
        dirs = gs.parse_directions(text, _msg(text), "2026-05-01")
        assert all(d.direction.lower() != "окремих" for d in dirs)

    def test_attacks_digit(self):
        text = _wrap_evening(
            "На Покровському напрямку з початку доби окупанти 17 разів намагалися потіснити наших воїнів."
        )
        dirs = gs.parse_directions(text, _msg(text), "2026-05-01")
        pokrovsk = next(d for d in dirs if d.direction == "Pokrovsk")
        assert pokrovsk.attacks == 17

    def test_attacks_word_form(self):
        text = _wrap_evening(
            "На Лиманському напрямку Сили оборони відбили п'ять боєзіткнень у районах н.п. Дробишеве, Діброва."
        )
        dirs = gs.parse_directions(text, _msg(text), "2026-05-01")
        lyman = next(d for d in dirs if d.direction == "Lyman")
        assert lyman.attacks == 5

    def test_ongoing_word_form(self):
        text = _wrap_evening(
            "На Олександрівському напрямку ворог двічі наступав. Одне боєзіткнення триває до цього часу."
        )
        dirs = gs.parse_directions(text, _msg(text), "2026-05-01")
        oleks = next(d for d in dirs if d.direction == "Oleksandrivka")
        assert oleks.ongoing == 1

    def test_no_duplicate_emission_for_pair(self):
        # When two paired headers reference the same direction nearby, we
        # should still only emit one row per direction per message.
        text = _wrap_evening(
            "На Краматорському та Оріхівському напрямках ворог активних дій не проводив. "
            "На Краматорському напрямку триває одне боєзіткнення."
        )
        dirs = gs.parse_directions(text, _msg(text), "2026-05-01")
        kram = [d for d in dirs if d.direction == "Kramatorsk"]
        assert len(kram) == 1

    def test_comma_separated_triple_header(self):
        # msg 15366: Jun-2024 introduces comma-separated triples —
        # "на Краматорському, Времівському та Оріхівському напрямках".
        # All three must be captured.
        text = _wrap_evening(
            "На Краматорському, Времівському та Оріхівському напрямках "
            "ворог здійснив дві спроби."
        )
        dirs = gs.parse_directions(text, _msg(text), "2026-05-01")
        labels = {d.direction for d in dirs}
        assert "Kramatorsk" in labels
        assert "Vremivka" in labels
        assert "Orikhiv" in labels

    def test_no_activity_sentinel_blocks_count_attribution(self):
        # msg 37227: Volyn/Polissia had nothing to report; the next paragraph
        # was a ceasefire-regime cumulative aggregate that mentioned
        # "провів 119 штурмових дій". Without the sentinel guard, both
        # directions got attacks=119, which then tripped the global
        # combat_engagements sanity check and NULL'd a valid value of 107.
        text = _wrap_evening(
            "На Волинському та Поліському напрямках ознак формування "
            "наступальних угруповань ворога не виявлено.\n"
            " \n"
            "Загалом, за час оголошеного режиму припинення вогню… "
            "противник здійснив 1 567 артилерійських обстрілів позицій "
            "наших військ; провів 119 штурмових дій."
        )
        dirs = gs.parse_directions(text, _msg(text), "2026-05-01")
        volyn = next(d for d in dirs if d.direction == "Volyn")
        polissia = next(d for d in dirs if d.direction == "Polissia")
        assert volyn.attacks is None
        assert polissia.attacks is None
        assert volyn.ongoing is None
        assert polissia.ongoing is None

    def test_stopword_lowercase_pivnichnomu_filtered(self):
        # msg 15171: prose "БпЛА...на північному напрямку" refers to the
        # compass direction, not a fighting front. Must not produce a
        # direction row.
        text = _wrap_evening(
            "Противник застосовував чотири безпілотні літальні апарати "
            "на північному напрямку. Два знищено."
        )
        dirs = gs.parse_directions(text, _msg(text), "2026-05-01")
        assert all(d.direction.lower() != "північному" for d in dirs)
        assert all(d.direction != "Pivnichnomu" for d in dirs)


# ---------------------------------------------------------------------------
# _normalize_direction — apostrophe variants
# ---------------------------------------------------------------------------

class TestNormalizeDirection:
    def test_ascii_apostrophe(self):
        assert gs._normalize_direction("Куп'янському") == "Kupiansk"

    def test_modifier_apostrophe(self):
        assert gs._normalize_direction("Купʼянському") == "Kupiansk"

    def test_curly_apostrophe(self):
        assert gs._normalize_direction("Куп’янському") == "Kupiansk"

    def test_sloviansk(self):
        # Was completely missing from DIRECTION_NAMES before the audit.
        assert gs._normalize_direction("Слов'янському") == "Sloviansk"

    def test_known_direction(self):
        assert gs._normalize_direction("Покровському") == "Pokrovsk"

    def test_chernihiv_direction(self):
        # msg 15309: paired header "На Чернігівському та Сумському напрямках"
        # — Chernihiv axis reactivated in Jun-2024.
        assert gs._normalize_direction("Чернігівському") == "Chernihiv"

    def test_shakhtarsk_direction(self):
        # msgs 15719, 15733: "На Шахтарському напрямку" — Shakhtarsk front,
        # near Donetsk.
        assert gs._normalize_direction("Шахтарському") == "Shakhtarsk"

    def test_unknown_falls_back_to_title_case(self):
        # No DIRECTION_NAMES match → returns Title-cased original
        assert gs._normalize_direction("Невідомому") == "Невідомому"


# ---------------------------------------------------------------------------
# Sanity-check warnings (via pytest's caplog)
# ---------------------------------------------------------------------------

class TestSanityCheck:
    def test_warns_on_unmapped_direction(self, caplog):
        # Fictional direction "Кременецькому" — would not match any
        # DIRECTION_NAMES entry, so it should produce a WARN at upsert time.
        text = _wrap_evening(
            "На Кременецькому напрямку противник тричі намагався просунутися."
        )
        msg = _msg(text, mid=99999)
        summary = gs.parse_summary(text, msg)
        directions = gs.parse_directions(text, msg, summary.date)
        # Confirm the parser actually emitted the unmapped label
        assert any(d.direction == "Кременецькому" for d in directions)
        with caplog.at_level(logging.WARNING, logger=gs.log.name):
            gs._sanity_check(summary, directions)
        assert any(
            "unmapped direction" in r.message and "Кременецькому" in r.message
            for r in caplog.records
        )

    def test_no_warning_for_known_directions(self, caplog):
        text = _wrap_evening(
            "На Покровському напрямку противник тричі намагався просунутися."
        )
        msg = _msg(text)
        summary = gs.parse_summary(text, msg)
        directions = gs.parse_directions(text, msg, summary.date)
        with caplog.at_level(logging.WARNING, logger=gs.log.name):
            gs._sanity_check(summary, directions)
        assert not any("unmapped direction" in r.message for r in caplog.records)

    def test_clears_combat_when_less_than_max_direction_attacks(self, caplog):
        # Mathematically impossible: the global is the sum of per-direction
        # attacks, so it must be ≥ max individual direction. When it isn't,
        # the parser almost certainly grabbed a per-direction value as the
        # global (e.g. branch 1a hitting "N бойових зіткнень" inside a "На
        # X напрямку…" section). The sanity check nulls the bad value.
        summary = SimpleNamespace(
            source="telegram", source_id="99998",
            message_date="2024-05-14T17:00:00+00:00",
            snapshot_at="2024-05-14T17:00:00",
            combat_engagements=9,        # suspicious: smaller than a single direction
            part=None,
            notes=None,
        )
        directions = [
            SimpleNamespace(direction="Kupiansk", attacks=13, ongoing=None),
            SimpleNamespace(direction="Pokrovsk", attacks=8, ongoing=None),
        ]
        with caplog.at_level(logging.WARNING, logger=gs.log.name):
            gs._sanity_check(summary, directions)
        assert summary.combat_engagements is None
        assert any(
            "< max direction attacks" in r.message for r in caplog.records
        )

    def test_recovers_combat_via_skip_branch_1a(self, caplog):
        # msg 14648 archetype: global aggregate uses branch-4 phrasing
        # ("збільшилась до 93") but branch 1a (unanchored separated form)
        # grabs a per-direction "9 бойових зіткнень" first. Sanity check
        # detects the impossibility (combat < max direction) and re-runs
        # the chain with branch 1a skipped — branch 4 then catches 93.
        text = (
            "Оперативна інформація станом на 17.00 14.05.2024 щодо російського вторгнення\n"
            "Протягом поточної доби кількість боєзіткнень збільшилась до 93.\n"
            "На Куп'янському напрямку противник завдав авіаудару в районі Сергіївки. "
            "Станом на цей час загалом зафіксовано 9 бойових зіткнень. "
            "Загарбники здійснили 13 атак."
        )
        summary = SimpleNamespace(
            source="telegram", source_id="99996",
            message_date="2024-05-14T17:00:00+00:00",
            snapshot_at="2024-05-14T17:00:00",
            combat_engagements=9,         # branch 1a's wrong grab
            part=None,
            notes=None,
        )
        directions = [
            SimpleNamespace(direction="Kupiansk", attacks=13, ongoing=None),
        ]
        with caplog.at_level(logging.WARNING, logger=gs.log.name):
            gs._sanity_check(summary, directions, text)
        assert summary.combat_engagements == 93
        assert any(
            "93" in r.message and ("recovered" in r.message or "branch 4 probe" in r.message)
            for r in caplog.records
        )

    def test_branch4_probe_overrides_branch3_per_direction_grab(self, caplog):
        # msg 18500 archetype: branch 3 grabs a per-direction "окупанти
        # здійснили 15 спроб" while the global is the kil_kist form
        # "кількість ворожих атак зросла до 102". Sanity check's
        # branch-4 probe should detect this and prefer the kil_kist value.
        # NB: max(directions.attacks) is small here (2) — the
        # impossibility check (combat < max) does NOT fire (15 > 2), so
        # the recovery path must come from the branch-4 probe instead.
        text = (
            "Оперативна інформація станом на 16.00 07.11.2024 щодо російського вторгнення\n"
            "За сьогодні кількість ворожих атак зросла до 102. Основні зусилля окупанти прикладають на Курахівському напрямку.\n"
            "На Покровському напрямку з початку доби окупанти здійснили 15 спроб потіснити наших захисників."
        )
        summary = SimpleNamespace(
            source="telegram", source_id="99995",
            message_date="2024-11-07T16:00:00+00:00",
            snapshot_at="2024-11-07T16:00:00",
            combat_engagements=15,        # branch 3 misparse
            part=None,
            notes=None,
        )
        directions = [
            SimpleNamespace(direction="Toretsk", attacks=2, ongoing=None),
        ]
        with caplog.at_level(logging.WARNING, logger=gs.log.name):
            gs._sanity_check(summary, directions, text)
        assert summary.combat_engagements == 102
        assert any("branch 4 probe" in r.message for r in caplog.records)

    def test_keeps_combat_when_at_least_max_direction_attacks(self, caplog):
        # Healthy case: global ≥ max direction. No nulling, no warning.
        summary = SimpleNamespace(
            source="telegram", source_id="99997",
            message_date="2024-05-14T17:00:00+00:00",
            snapshot_at="2024-05-14T17:00:00",
            combat_engagements=80,
            part=None,
            notes=None,
        )
        directions = [
            SimpleNamespace(direction="Kupiansk", attacks=13, ongoing=None),
            SimpleNamespace(direction="Pokrovsk", attacks=27, ongoing=None),
        ]
        with caplog.at_level(logging.WARNING, logger=gs.log.name):
            gs._sanity_check(summary, directions)
        assert summary.combat_engagements == 80
        assert not any(
            "< max direction attacks" in r.message for r in caplog.records
        )
