#!/usr/bin/env python3
"""
Header mapping, parsing, storage and `daily` view tests for
scripts/ua_losses_ru_mod/ingest.py, on a synthetic miniature of the sheet.

    bash scripts/test_python.sh scripts/ua_losses_ru_mod
"""
from __future__ import annotations

import csv
import io
import pathlib
import sys

import pytest

SCRIPT_DIR = pathlib.Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import ingest  # noqa: E402

# The sheet's blocks in order, cut down to a model or two each, with the
# columns position alone would misfile (the mortar column before the artillery
# anchor, the weekly NATO/Soviet split) and the ones that must be dropped.
HEADER = [
    "",
    "Tanks and other Armoured Vehicles", "Tanks and others AVs (Daily)",
    "Unknown tanks", "Leopard", "Unknown IFVs", "Bradley", "Unknown APCs", "M113",
    "Unknown ACVs", "Kozak", "Engineering Vehicles",
    "Mortars (and Friday's unspecified artillery)",
    " Artillery", "Artillery (daily)", "NATO", "Soviet", "M777",
    "MRLs", "MRLs (Daily)", "Soviet", "HIMARS",
    "AA Missile Systems", "AA Missile Systems (Daily)", "Patriot",
    "Aircraft", "Aircraft (Daily)", "Su-25",
    "Helicopters", "Helicopters (Daily)", "Mi-8",
    "UAVs", "UAVs (Daily)", "LR OWA UAVs (Dailly)", "UAVs (weekly)", "Bayraktar TB-2",
    "Special Motor Vehicles", "Special Motor Vehciles (Daily)",
    "Servicemen (daily) Killed and Wounder", "",
    "Servicemen captured",
    "Unknown Rocket (probably Grad)", "HIMARS", "Tochka-U Launcher",
    "Unknown Radar", "AN/TPQ-36",
    "RERS", "Unknown EWS",
    "Mortars (82mm/120mm)", "Mortars", "Weekly field artillery guns",
    "Comments: Most of the discrepancies …",
]
COL = {h: i for i, h in reversed(list(enumerate(HEADER)))}  # first occurrence wins


def row(date: str, **cells: object) -> list[str]:
    """A data row; `cells` maps a header (first occurrence) to its value.
    Keyword names can't carry spaces, so pass them as a dict via **{...}."""
    r = [""] * len(HEADER)
    r[0] = date
    for h, v in cells.items():
        r[COL[h]] = str(v)
    return r


def sheet(*rows: list[str]) -> str:
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(["May done.", ""])          # the notes Felix keeps above the header
    w.writerow(["Total claimed destroyed:", "31073"])
    w.writerow(HEADER)
    w.writerow(["Date:"])
    for r in rows:
        w.writerow(r)
    return out.getvalue()


TOTALS = {
    "Tanks and other Armoured Vehicles": 0, " Artillery": 0, "MRLs": 0,
    "AA Missile Systems": 0, "Aircraft": 0, "Helicopters": 0, "UAVs": 0,
    "Special Motor Vehicles": 0,
}


def day(date: str, totals: dict[str, int] | None = None, **cells: object) -> list[str]:
    return row(date, **{**TOTALS, **(totals or {}), **cells})


@pytest.fixture
def no_floor(monkeypatch):
    monkeypatch.setattr(ingest, "MIN_ROWS_FLOOR", 1)


def columns_by_label():
    return {(c.section, c.label): c for c in ingest.map_columns(HEADER)}


# ── Header mapping ──────────────────────────────────────────────────────────


def test_anchor_columns_are_the_mod_totals():
    cols = columns_by_label()
    armour = cols[("armour", "Tanks and other Armoured Vehicles")]
    assert (armour.item, armour.role) == ("_total", "total")
    assert cols[("personnel", "Servicemen (daily) Killed and Wounder")].role == "daily"
    assert cols[("captured", "Servicemen captured")].role == "daily"


def test_armour_items_carry_their_subgroup():
    cols = columns_by_label()
    assert cols[("armour", "Leopard")].subgroup == "tanks"
    assert cols[("armour", "Bradley")].subgroup == "ifv"
    assert cols[("armour", "M113")].subgroup == "apc"
    assert cols[("armour", "Kozak")].subgroup == "acv"
    assert cols[("armour", "Engineering Vehicles")].subgroup == "other"


def test_columns_position_would_misfile_are_overridden():
    cols = columns_by_label()
    # Before the artillery anchor, but artillery.
    assert ("armour", "Mortars (and Friday's unspecified artillery)") not in cols
    assert cols[("artillery", "Mortars (and Friday's unspecified artillery)")].role == "item"
    # Subsets: stored, never summed.
    assert cols[("uav", "LR OWA UAVs (Dailly)")].role == "sub"
    assert cols[("artillery", "Mortars (82mm/120mm)")].role == "sub"
    assert ("other", "Tochka-U Launcher") in cols


def test_a_repeated_header_is_told_apart_by_its_section():
    cols = columns_by_label()
    # "Soviet" is a weekly split under artillery (dropped) but a model under MLRS.
    assert ("artillery", "Soviet") not in cols
    assert ("mlrs", "Soviet") in cols
    # "HIMARS" the launcher and "HIMARS" the intercepted rocket.
    assert ("mlrs", "HIMARS") in cols and ("munitions", "HIMARS") in cols


def test_derived_columns_are_not_stored():
    labels = {c.label for c in ingest.map_columns(HEADER)}
    for derived in ["Tanks and others AVs (Daily)", "Artillery (daily)", "UAVs (weekly)",
                    "NATO", "Mortars", "Weekly field artillery guns"]:
        assert derived not in labels
    assert "" not in labels


def test_a_new_model_column_joins_its_block():
    header = HEADER[:]
    header.insert(header.index("M777") + 1, "Caesar")
    cols = {(c.section, c.label): c for c in ingest.map_columns(header)}
    assert cols[("artillery", "Caesar")].role == "item"


def test_a_missing_anchor_refuses_to_guess():
    header = [h for h in HEADER if h != "MRLs"]
    with pytest.raises(RuntimeError, match="mrls"):
        ingest.map_columns(header)


# ── Parsing ─────────────────────────────────────────────────────────────────


def test_parse_reads_dates_values_and_notes():
    text = sheet(
        day("24/02/2022", {"Aircraft": 4}, **{"Su-25": 1, "Comments: Most of the discrepancies …": "18 radars"}),
        day("25/02/2022", {"Aircraft": 6}),
    )
    _, data, notes = ingest.parse(text)
    assert list(data) == ["2022-02-24", "2022-02-25"]
    assert data["2022-02-24"][("aircraft", "_total")] == 4
    assert data["2022-02-24"][("aircraft", "su_25")] == 1
    assert notes == {"2022-02-24": "18 radars"}


def test_rows_waiting_below_today_are_not_days():
    # The sheet keeps empty rows ready, whose formula columns already read as
    # the whole war's losses in reverse.
    placeholder = row("30/09/2026", **{"Tanks and others AVs (Daily)": -31073})
    _, data, _ = ingest.parse(sheet(day("29/09/2026"), placeholder))
    assert list(data) == ["2026-09-29"]


def test_a_non_numeric_cell_is_skipped_not_fatal():
    _, data, _ = ingest.parse(sheet(day("25/02/2022", **{"Unknown EWS": "Friday", "Leopard": 2})))
    values = data["2022-02-25"]
    assert ("ew", "unknown_ews") not in values
    assert values[("armour", "leopard")] == 2


# ── Storage and the daily view ──────────────────────────────────────────────


def ingest_text(conn, text: str, at: str) -> dict:
    return ingest.store(conn, *ingest.parse(text), scraped_at=at)


def daily(conn) -> dict[str, dict]:
    cur = conn.execute("SELECT * FROM daily ORDER BY report_date")
    names = [d[0] for d in cur.description]
    return {r[0]: dict(zip(names, r)) for r in cur.fetchall()}


def test_daily_view_diffs_the_totals_and_sums_armour_subgroups(tmp_path, no_floor):
    conn = ingest.connect(tmp_path / "f.db")
    ingest_text(conn, sheet(
        day("06/03/2025", {"Tanks and other Armoured Vehicles": 22000}),
        # Items overshoot the MoD's 78 — the total is the MoD's, kept as is.
        day("07/03/2025", {"Tanks and other Armoured Vehicles": 22078},
            **{"Unknown tanks": 5, "Bradley": 6, "M113": 9, "Unknown ACVs": 60,
               "Servicemen (daily) Killed and Wounder": 2655, "LR OWA UAVs (Dailly)": 43}),
    ), "2026-10-01T00:00:00+00:00")
    d = daily(conn)["2025-03-07"]
    assert d["armour"] == 78
    assert (d["armour_tanks"], d["armour_ifv"], d["armour_apc"], d["armour_acv"]) == (5, 6, 9, 60)
    assert d["armour_other"] is None
    assert d["personnel"] == 2655
    assert d["uav_lr_owa"] == 43
    assert d["loss_date"] == "2025-03-06"


def test_radars_and_ew_stations_are_summed_from_their_items(tmp_path, no_floor):
    # The MoD keeps no running total for either, so the items are the figure,
    # and a day without any is a claimed 0.
    conn = ingest.connect(tmp_path / "f.db")
    ingest_text(conn, sheet(
        day("01/01/2025", **{"Unknown Radar": 1, "AN/TPQ-36": 2, "RERS": 1, "Unknown EWS": 3}),
        day("02/01/2025"),
    ), "2026-10-01T00:00:00+00:00")
    d = daily(conn)
    assert (d["2025-01-01"]["radars"], d["2025-01-01"]["ew"]) == (3, 4)
    assert (d["2025-01-02"]["radars"], d["2025-01-02"]["ew"]) == (0, 0)


def test_a_day_missing_one_total_does_not_dump_the_war_into_the_next(tmp_path, no_floor):
    conn = ingest.connect(tmp_path / "f.db")
    gap = day("02/01/2025", {"MRLs": 1000})
    gap[COL[" Artillery"]] = ""
    ingest_text(conn, sheet(
        day("01/01/2025", {" Artillery": 20000, "MRLs": 1000}),
        gap,
        day("03/01/2025", {" Artillery": 20030, "MRLs": 1001}),
    ), "2026-10-01T00:00:00+00:00")
    d = daily(conn)
    assert d["2025-01-02"]["artillery"] is None
    assert d["2025-01-03"]["artillery"] == 30
    assert d["2025-01-03"]["mlrs"] == 1


def test_a_correction_passes_through_as_that_days_value(tmp_path, no_floor):
    conn = ingest.connect(tmp_path / "f.db")
    ingest_text(conn, sheet(
        day("04/04/2025", {"Tanks and other Armoured Vehicles": 23000}),
        day("05/04/2025", {"Tanks and other Armoured Vehicles": 22994}),
    ), "2026-10-01T00:00:00+00:00")
    assert daily(conn)["2025-04-05"]["armour"] == -6


def test_store_appends_only_what_changed(tmp_path, no_floor):
    conn = ingest.connect(tmp_path / "f.db")
    v1 = sheet(day("01/01/2025", **{"Leopard": 2, "M777": 1}), day("02/01/2025"))
    assert ingest_text(conn, v1, "2026-10-01T00:00:00+00:00")["cells"] > 0
    assert ingest_text(conn, v1, "2026-10-02T00:00:00+00:00") == {"cells": 0, "notes": 0, "days": 2}
    assert conn.execute("SELECT COUNT(*) FROM snapshots").fetchone()[0] == 1

    # Felix corrects one cell and clears another.
    v2 = sheet(day("01/01/2025", **{"Leopard": 3}), day("02/01/2025"))
    assert ingest_text(conn, v2, "2026-10-03T00:00:00+00:00")["cells"] == 2
    latest = dict(conn.execute(
        "SELECT item, value FROM latest_claims WHERE report_date = '2025-01-01' AND role = 'item'"
    ).fetchall())
    assert latest == {"leopard": 3}
    # Both versions of the corrected cell are still there.
    assert conn.execute(
        "SELECT COUNT(*) FROM claims c JOIN items i ON i.id = c.item_id WHERE i.item = 'leopard'"
    ).fetchone()[0] == 2


def test_a_shrinking_sheet_is_refused(tmp_path, no_floor):
    conn = ingest.connect(tmp_path / "f.db")
    ingest_text(conn, sheet(day("01/01/2025"), day("02/01/2025")), "2026-10-01T00:00:00+00:00")
    with pytest.raises(RuntimeError, match="shrinking"):
        ingest_text(conn, sheet(day("01/01/2025")), "2026-10-02T00:00:00+00:00")


def test_a_partial_fetch_is_refused(tmp_path):
    conn = ingest.connect(tmp_path / "f.db")
    with pytest.raises(RuntimeError, match="floor"):
        ingest_text(conn, sheet(day("01/01/2025")), "2026-10-01T00:00:00+00:00")
