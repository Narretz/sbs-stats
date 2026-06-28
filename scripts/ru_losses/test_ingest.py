"""
Unit tests for the RU losses parser (scripts/ru_losses/ingest.py).

Focus: the suspect-drop guard in parse_rows (catastrophic upstream typos
must not produce a -99% per-day delta) and the no-regression rule in
build's change detection (None in a fetch never overwrites a real stored
value).

Run with: pytest -v test_ingest.py   (from scripts/ru_losses/)
"""
import sqlite3
from pathlib import Path

import ingest as ig


# ── parse_rows: suspect-drop guard ────────────────────────────────────────────

def _equip_row(date: str, vehicles: int) -> dict:
    """Minimal Petro equipment record — only the columns parse_rows reads."""
    return {
        "date": date,
        "tank": 0, "APC": 0, "field artillery": 0, "MRL": 0,
        "anti-aircraft warfare": 0, "aircraft": 0, "helicopter": 0,
        "drone": 0, "vehicles and fuel tanks": vehicles, "naval ship": 0,
        "special equipment": 0, "cruise missiles": 0, "ground robotic systems": 0,
    }


def _personnel_row(date: str, personnel: int) -> dict:
    return {"date": date, "personnel": personnel, "POW": None}


class TestSuspectDropGuard:
    def test_typo_dropping_cum_by_90pct_yields_none(self):
        # Mirrors the real 2026-06-23 incident: Petro's vehicles cum went
        # 110827 → 11257 (a digit fell off). The previous version of parse_rows
        # would emit a -99570 per-day delta for loss-day 2026-06-23.
        equip = [
            _equip_row("2026-06-23", 110827),
            _equip_row("2026-06-24", 11257),  # typo: missing leading 1
            _equip_row("2026-06-25", 111720),  # Petro fixes the typo next day
        ]
        personnel = [
            _personnel_row("2026-06-23", 1_000_000),
            _personnel_row("2026-06-24", 1_001_000),
            _personnel_row("2026-06-25", 1_002_000),
        ]
        out = ig.parse_rows(equip, personnel)
        # report-day 2026-06-24 = loss-day 2026-06-23 → vehicles is the typo'd diff.
        assert out["2026-06-23"]["vehicles"] is None
        # The next day's delta is taken against the LAST GOOD cum (110827),
        # not the typo (11257) — so it's a sane positive number, not ~+100k.
        assert out["2026-06-24"]["vehicles"] == 111720 - 110827 == 893
        # Personnel (no typo) is unaffected on both days.
        assert out["2026-06-23"]["personnel"] == 1000
        assert out["2026-06-24"]["personnel"] == 1000

    def test_modest_negative_correction_passes_through(self):
        # A real GS correction is small relative to the running total — the
        # guard must not eat it. Drop of ~0.4% here (way under 50%).
        equip = [
            _equip_row("2026-05-01", 100_000),
            _equip_row("2026-05-02", 99_600),   # GS corrected down by 400
            _equip_row("2026-05-03", 100_200),
        ]
        personnel = [
            _personnel_row("2026-05-01", 500_000),
            _personnel_row("2026-05-02", 500_500),
            _personnel_row("2026-05-03", 501_000),
        ]
        out = ig.parse_rows(equip, personnel)
        assert out["2026-05-01"]["vehicles"] == -400  # real correction, kept
        assert out["2026-05-02"]["vehicles"] == 600

    def test_early_war_small_value_swing_not_suppressed(self):
        # MIN_PREV_FOR_GUARD keeps the guard from firing in early-war noise
        # where small absolute values can produce big relative swings.
        # vehicles=10 → 4 is a 60% drop but only 6 units; not a typo signature.
        equip = [
            _equip_row("2022-03-01", 10),
            _equip_row("2022-03-02", 4),
            _equip_row("2022-03-03", 12),
        ]
        personnel = [
            _personnel_row("2022-03-01", 5_000),
            _personnel_row("2022-03-02", 5_100),
            _personnel_row("2022-03-03", 5_200),
        ]
        out = ig.parse_rows(equip, personnel)
        assert out["2022-03-01"]["vehicles"] == -6  # passed through


# ── _is_meaningful_change: no-regression rule ─────────────────────────────────

class TestNoRegression:
    def test_none_fetched_keeps_stored_real_value(self):
        # The suspect-drop guard turns the typo'd day's metric into None.
        # Without this rule, that None would overwrite a previously-stored
        # real value (e.g. yesterday's correct MoD-supplement delta of 430),
        # losing real data. With the rule, the None is treated as "no info."
        stored = (1260, 6, 4, 60, 2, 3, 0, 0, 1873, 430, 0, 4, 0, 7, None)
        fetched = [1260, 6, 4, 60, 2, 3, 0, 0, 1873, None, 0, 4, 0, 7, None]
        assert ig._is_meaningful_change(stored, fetched) is False

    def test_real_change_still_inserts(self):
        # A genuine correction must still go through.
        stored = (1260, 6, 4, 60, 2, 3, 0, 0, 1873, 430, 0, 4, 0, 7, None)
        fetched = [1260, 6, 4, 60, 2, 3, 0, 0, 1873, 425, 0, 4, 0, 7, None]
        assert ig._is_meaningful_change(stored, fetched) is True

    def test_new_date_inserts(self):
        # Stored=None → unconditionally insert (new loss-day).
        fetched = [1260, 6, 4, 60, 2, 3, 0, 0, 1873, 430, 0, 4, 0, 7, None]
        assert ig._is_meaningful_change(None, fetched) is True

    def test_first_real_value_for_a_metric_inserts(self):
        # Going from None → real value DOES insert (we gained information).
        stored = (1260, 6, 4, 60, 2, 3, 0, 0, 1873, None, 0, 4, 0, 7, None)
        fetched = [1260, 6, 4, 60, 2, 3, 0, 0, 1873, 430, 0, 4, 0, 7, None]
        assert ig._is_meaningful_change(stored, fetched) is True

    def test_exact_match_no_insert(self):
        stored = (1260, 6, 4, 60, 2, 3, 0, 0, 1873, 430, 0, 4, 0, 7, None)
        fetched = list(stored)
        assert ig._is_meaningful_change(stored, fetched) is False


# ── end-to-end: rerun against a DB that already has the manual correction ────

class TestBuildPreservesManualFix:
    def test_typo_fetch_does_not_clobber_stored_fix(self, tmp_path: Path):
        # Real incident: at the time of the second CI run, the DB already
        # had a manual correction (vehicles=430) as the latest version for
        # 2026-06-23. The typo'd fetch produced -99570 again; pre-fix, that
        # appended a new bad version that won the latest-snapshot read.
        # Post-fix: suspect-drop guard turns -99570 into None, no-regression
        # rule keeps the stored 430.
        equip = [
            _equip_row("2026-06-23", 110_827),
            _equip_row("2026-06-24", 11_257),  # typo
        ]
        # Pad with enough prior days to clear MIN_ROWS_FLOOR (365). They all
        # share the same vehicles cum so the per-day delta is 0 and parse_rows
        # is happy.
        from datetime import date, timedelta
        base = date(2025, 1, 1)
        for offset in range(400):
            d = (base + timedelta(days=offset)).isoformat()
            equip.append(_equip_row(d, 100_000))
        personnel = [_personnel_row(r["date"], 500_000) for r in equip]

        db = tmp_path / "ru-losses.db"
        # Seed: manual correction (vehicles=430) as the latest stored version
        # for loss-day 2026-06-23. Mirrors what's in prod after our patch.
        conn = sqlite3.connect(db)
        cols = ", ".join(f"{m} INTEGER" for m in ig.METRICS)
        conn.execute(
            f"CREATE TABLE daily_losses (date TEXT NOT NULL, scraped_at TEXT NOT NULL, "
            f"reported_at TEXT, {cols}, PRIMARY KEY (date, scraped_at))"
        )
        seed = {m: 0 for m in ig.METRICS}
        seed["vehicles"] = 430
        collist = ", ".join(["date", "scraped_at", "reported_at"] + ig.METRICS)
        placeholders = ", ".join(["?"] * (len(ig.METRICS) + 3))
        conn.execute(
            f"INSERT INTO daily_losses ({collist}) VALUES ({placeholders})",
            ["2026-06-23", "2026-06-25T10:28:30+00:00", "2026-06-24",
             *[seed[m] for m in ig.METRICS]],
        )
        conn.commit()
        conn.close()

        ig.build(db, equip, personnel, supplement=None)

        # The latest snapshot for 2026-06-23 must still be our 430 fix.
        conn = sqlite3.connect(db)
        row = conn.execute(
            "SELECT vehicles FROM daily_losses WHERE date='2026-06-23' "
            "ORDER BY scraped_at DESC LIMIT 1"
        ).fetchone()
        conn.close()
        assert row[0] == 430

    def test_other_metric_change_does_not_clobber_nulled_metric(
        self, tmp_path: Path,
    ):
        # Inserts are row-level: when *another* metric triggers a write,
        # the row-merge must keep the stored real value for the metric the
        # suspect-drop guard nulled — otherwise the correction is lost
        # when another metric on the same day legitimately changes.
        equip = [
            _equip_row("2026-06-23", 110_827),
            _equip_row("2026-06-24", 11_257),  # vehicles typo
        ]
        # personnel on the typo'd loss-day (2026-06-23) is fine and rises
        # by 1500 (vs stored 1000), so personnel triggers a write.
        personnel = [
            _personnel_row("2026-06-23", 1_000_000),
            _personnel_row("2026-06-24", 1_001_500),
        ]
        from datetime import date, timedelta
        base = date(2025, 1, 1)
        for offset in range(400):
            d = (base + timedelta(days=offset)).isoformat()
            equip.append(_equip_row(d, 100_000))
            personnel.append(_personnel_row(d, 500_000))

        db = tmp_path / "ru-losses.db"
        conn = sqlite3.connect(db)
        cols = ", ".join(f"{m} INTEGER" for m in ig.METRICS)
        conn.execute(
            f"CREATE TABLE daily_losses (date TEXT NOT NULL, scraped_at TEXT NOT NULL, "
            f"reported_at TEXT, {cols}, PRIMARY KEY (date, scraped_at))"
        )
        seed = {m: 0 for m in ig.METRICS}
        seed["vehicles"] = 430
        seed["personnel"] = 1000
        collist = ", ".join(["date", "scraped_at", "reported_at"] + ig.METRICS)
        placeholders = ", ".join(["?"] * (len(ig.METRICS) + 3))
        conn.execute(
            f"INSERT INTO daily_losses ({collist}) VALUES ({placeholders})",
            ["2026-06-23", "2026-06-25T10:28:30+00:00", "2026-06-24",
             *[seed[m] for m in ig.METRICS]],
        )
        conn.commit()
        conn.close()

        ig.build(db, equip, personnel, supplement=None)

        conn = sqlite3.connect(db)
        row = conn.execute(
            "SELECT vehicles, personnel FROM daily_losses WHERE date='2026-06-23' "
            "ORDER BY scraped_at DESC LIMIT 1"
        ).fetchone()
        conn.close()
        # vehicles kept from stored (430), personnel updated to new computed delta.
        assert row == (430, 1500)
