"""Tests for the front-line weather report: the effect rules and the CLI plumbing.

No network: payloads are built here in Open-Meteo's column-wise shape.
"""
from __future__ import annotations

import json
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import assess  # noqa: E402
import report  # noqa: E402
from assess import DEGRADED, OK, SEVERE  # noqa: E402
from sectors import SECTORS, find  # noqa: E402

CALM = {
    "temperature_2m": 10.0, "apparent_temperature": 8.0, "precipitation": 0.0,
    "snowfall": 0.0, "weather_code": 1, "visibility": 24000.0, "cloud_cover_low": 10,
    "wind_speed_10m": 3.0, "wind_gusts_10m": 6.0, "soil_moisture_3_to_9cm": 0.25,
    "snow_depth": 0.0,
}


def hour(**over) -> dict:
    return {**CALM, "time": "2026-10-10T12:00", **over}


def series(start: date, days: int, per_hour=None) -> list[dict]:
    """`days` days of hourly rows; per_hour(dt) → overrides for that hour."""
    out = []
    t = datetime.combine(start, datetime.min.time())
    for _ in range(days * 24):
        out.append({**CALM, "time": t.strftime("%Y-%m-%dT%H:%M"), **(per_hour(t) if per_hour else {})})
        t += timedelta(hours=1)
    return out


def payload(rows_per_location: list[list[dict]]):
    items = [{"latitude": 0, "longitude": 0,
              "hourly": {k: [r.get(k) for r in rows] for k in ("time", *report.HOURLY)}}
             for rows in rows_per_location]
    return items[0] if len(items) == 1 else items


# ── drone_hour ──────────────────────────────────────────────────────────────

def test_calm_hour_is_ok():
    assert assess.drone_hour(hour()) == (OK, [])


@pytest.mark.parametrize("over,level,reason", [
    ({"wind_speed_10m": 8.0}, DEGRADED, "wind"),
    ({"wind_gusts_10m": 15.0}, SEVERE, "wind"),
    ({"wind_speed_10m": 12.5, "wind_gusts_10m": 9.0}, SEVERE, "wind"),
    ({"precipitation": 0.6}, DEGRADED, "rain"),
    ({"precipitation": 3.0}, SEVERE, "rain"),
    ({"visibility": 3000.0}, DEGRADED, "mist"),
    ({"visibility": 400.0}, SEVERE, "fog"),
    ({"weather_code": 45, "visibility": None}, SEVERE, "fog"),
    ({"weather_code": 95}, SEVERE, "thunderstorm"),
    ({"temperature_2m": -18.0}, DEGRADED, "cold"),
    ({"temperature_2m": -27.0}, SEVERE, "cold"),
    ({"weather_code": 66, "temperature_2m": -2.0, "precipitation": 0.2}, SEVERE, "icing"),
])
def test_drone_hour_thresholds(over, level, reason):
    got_level, reasons = assess.drone_hour(hour(**over))
    assert got_level == level
    assert (level, reason) in reasons


def test_snow_is_not_also_counted_as_rain():
    # 1 cm of snow ≈ 1.4 mm water: precipitation alone would read as rain.
    level, reasons = assess.drone_hour(hour(temperature_2m=-8.0, snowfall=1.0, precipitation=1.43))
    assert level == SEVERE
    assert [r for _, r in reasons] == ["snow"]


def test_icing_needs_moisture():
    assert assess.drone_hour(hour(temperature_2m=0.0))[0] == OK
    assert (SEVERE, "icing") in assess.drone_hour(hour(temperature_2m=0.0, precipitation=0.1))[1]


def test_missing_fields_are_not_findings():
    h = {"time": "2026-10-10T00:00", **{k: None for k in CALM}}
    assert assess.drone_hour(h) == (OK, [])


# ── ground ──────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("wet72,soil,tmax,snow,want", [
    (2.0, 0.25, 12.0, 0.0, ("firm", OK)),
    (2.0, 0.36, 12.0, 0.0, ("soft", DEGRADED)),
    (2.0, 0.42, 12.0, 0.0, ("mud", SEVERE)),
    (30.0, 0.25, 12.0, 0.0, ("soft", DEGRADED)),   # soil lagging a downpour
    (30.0, None, 12.0, None, ("mud", SEVERE)),     # no soil field: rain decides
    (12.0, None, 12.0, None, ("soft", DEGRADED)),
    (30.0, 0.45, -3.0, 0.0, ("frozen", OK)),       # a day that never thaws
    (0.0, 0.30, -3.0, 0.40, ("deep snow", DEGRADED)),
])
def test_trafficability(wet72, soil, tmax, snow, want):
    assert assess.trafficability(wet72, soil, tmax, snow) == want


def test_exposure():
    assert assess.exposure(-26, -10) == ("extreme cold", SEVERE)
    assert assess.exposure(-16, -5) == ("cold", DEGRADED)
    assert assess.exposure(20, 35) == ("heat", DEGRADED)
    assert assess.exposure(2, 15) == ("", OK)


# ── summarise_day ───────────────────────────────────────────────────────────

D = date(2026, 10, 10)


def test_day_with_morning_fog_is_poor_with_a_cover_window():
    fog = lambda t: {"visibility": 300.0, "weather_code": 45} if t.date() == D and 4 <= t.hour < 10 else {}
    s = assess.summarise_day(series(D - timedelta(days=2), 3, fog), D)
    assert s.drone_severe_hours == 6
    assert s.drone_rating == "POOR"
    assert s.fog_hours == 6
    assert [(w.start, w.end, w.reasons) for w in s.cover_windows] == [(4, 10, ["fog"])]
    assert s.bad


def test_single_severe_hour_is_not_a_window():
    gust = lambda t: {"wind_gusts_10m": 16.0} if t.date() == D and t.hour in (3, 9, 10) else {}
    s = assess.summarise_day(series(D, 1, gust), D)
    assert [(w.start, w.end) for w in s.cover_windows] == [(9, 11)]
    assert s.drone_rating == "GOOD"


def test_wet72_reads_back_two_days_and_drives_mud():
    rain = lambda t: {"precipitation": 0.5, "soil_moisture_3_to_9cm": None}
    s = assess.summarise_day(series(D - timedelta(days=2), 3, rain), D)
    assert s.wet72 == pytest.approx(36.0)
    assert s.going == "mud"
    assert s.bad


def test_wet72_is_none_without_the_lookback():
    s = assess.summarise_day(series(D, 1), D)
    assert s.wet72 is None


def test_hindcast_split():
    s = assess.summarise_day(series(D, 1), D, now=datetime(2026, 10, 10, 14, 30))
    assert (s.hindcast_hours, s.hours) == (15, 24)
    assert report._split_note(s) == "00–15h hindcast · 15–24h forecast"


def test_missing_day_is_none():
    assert assess.summarise_day(series(D, 1), D + timedelta(days=1)) is None


# ── plumbing ────────────────────────────────────────────────────────────────

def test_hourly_rows_single_and_multi():
    one = series(D, 1)
    assert report.hourly_rows(payload([one]), 1)[0][5] == one[5]
    two = report.hourly_rows(payload([one, series(D, 1, lambda t: {"precipitation": 1.0})]), 2)
    assert two[1][0]["precipitation"] == 1.0


def test_hourly_rows_count_mismatch_fails():
    with pytest.raises(SystemExit):
        report.hourly_rows(payload([series(D, 1)]), 2)


def test_build_url_picks_endpoint_and_lookback():
    url = report.build_url(SECTORS[:2], D, D + timedelta(days=1), today=D)
    assert url.startswith(report.FORECAST_URL)
    assert "start_date=2026-10-08" in url and "end_date=2026-10-11" in url
    assert "wind_speed_unit=ms" in url
    old = report.build_url(SECTORS[:1], date(2024, 2, 1), date(2024, 2, 3), today=D)
    assert old.startswith(report.ARCHIVE_URL)
    with pytest.raises(ValueError):
        report.build_url(SECTORS[:1], date(2024, 2, 1), D, today=D)
    with pytest.raises(ValueError):
        report.build_url(SECTORS[:1], D, D + timedelta(days=20), today=D)


def test_find_sectors():
    assert [s.key for s in find(["pokrovsk", "Kursk"])] == ["N-Slobozhanshchyna", "Pokrovsk"]
    assert len(find(None)) == len(SECTORS)
    with pytest.raises(ValueError):
        find(["Atlantis"])


def test_cli_renders_saved_payload(tmp_path, capsys):
    fog = lambda t: {"visibility": 300.0, "weather_code": 45} if t.date() == D and t.hour < 8 else {}
    rows = [series(D - timedelta(days=2), 4, fog if i == 1 else None) for i in range(len(SECTORS))]
    path = tmp_path / "raw.json"
    path.write_text(json.dumps(payload(rows)))

    assert report.main(["--input", str(path), "--now", "2026-10-10T14:00"]) == 0
    out = capsys.readouterr().out
    assert "1/12 sectors with bad weather" in out
    assert f"* {SECTORS[1].key}" in out
    assert "00–08h fog" in out

    assert report.main(["--input", str(path), "--now", "2026-10-10T14:00", "--json"]) == 0
    data = json.loads(capsys.readouterr().out)
    day = data["sectors"][1]["days"][0]
    assert day["drones"]["rating"] == "POOR" and day["bad"]
    assert data["sectors"][0]["gsua"] == ["N-Slobozhanshchyna", "Kursk"]


def test_one_hour_lull_does_not_split_a_window():
    gust = lambda t: {"wind_gusts_10m": 16.0} if t.date() == D and t.hour in (2, 3, 5, 6, 9) else {}
    s = assess.summarise_day(series(D, 1, gust), D)
    assert [(w.start, w.end) for w in s.cover_windows] == [(2, 7)]


def test_save_then_input_one_sector(tmp_path, capsys, monkeypatch):
    fog = lambda t: {"visibility": 300.0} if t.date() == D and t.hour < 8 else {}
    rows = [series(D - timedelta(days=2), 4, fog if i == 7 else None) for i in range(len(SECTORS))]
    monkeypatch.setattr(report, "fetch", lambda url: payload(rows))
    path = tmp_path / "saved.json"
    assert report.main(["--save", str(path), "--now", "2026-10-10T09:00"]) == 0
    capsys.readouterr()

    # Re-rendered without --now: the saved fetch time keeps the split.
    assert report.main(["--input", str(path), "--sector", "Pokrovsk", "--days", "1"]) == 0
    out = capsys.readouterr().out
    assert "00–09h hindcast" in out
    assert "* Pokrovsk" in out and "1/1 sectors" in out


def test_vis_formatting():
    assert [report._vis(m) for m in (None, 20.0, 430.0, 9_900.0, 44_000.0)] == \
        ["–", "<0.1", "0.4", "9.9", ">10"]


def test_real_open_meteo_response(capsys):
    """A real fetch (2026-10-10 19:05 Kyiv), saved with --save: pins the
    response shape and that every requested field came back filled.
    The next morning's forecast had dense fog (20–40 m) over the Donbas."""
    path = Path(__file__).parent / "fixtures" / "live-2026-10-10.json"
    saved = json.loads(path.read_text())
    for item in saved["response"]:
        for key in report.HOURLY:
            assert all(v is not None for v in item["hourly"][key]), key

    assert report.main(["--input", str(path), "--json"]) == 0
    data = {s["key"]: s for s in json.loads(capsys.readouterr().out)["sectors"]}
    today, tomorrow = data["Pokrovsk"]["days"]
    assert today["hindcast_hours"] == 20   # 00:00–19:00 are before 19:05
    assert tomorrow["hindcast_hours"] == 0
    assert tomorrow["drones"]["rating"] == "POOR"
    assert tomorrow["drones"]["reasons"]["fog"] >= 6
    assert data["Orikhiv"]["days"][1]["drones"]["rating"] == "GOOD"


@pytest.mark.parametrize("when,days,past,want", [
    (None, 2, 0, ["2026-10-10", "2026-10-11"]),
    ("yesterday", 1, 0, ["2026-10-09"]),
    ("-2", 1, 0, ["2026-10-08"]),
    ("+1", 1, 0, ["2026-10-11"]),
    (None, 2, 3, ["2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11"]),
    ("2025-01-20", 1, 1, ["2025-01-19", "2025-01-20"]),
])
def test_report_days(when, days, past, want):
    assert [d.isoformat() for d in report.report_days(D, when, days, past)] == want


def test_report_days_rejects_garbage():
    with pytest.raises(ValueError):
        report.report_days(D, "last week", 1, 0)
