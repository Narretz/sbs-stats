#!/usr/bin/env python3
"""Front-line weather report: Open-Meteo per GSUA direction, plus what it means
for drone and ground operations. Stdlib only.

    python3 scripts/weather/report.py                  # today + tomorrow, every sector
    python3 scripts/weather/report.py --days 4         # …four days out
    python3 scripts/weather/report.py --date 2026-01-15 --days 3   # any day since 2022
    python3 scripts/weather/report.py --sector Pokrovsk --hourly   # hour by hour
    python3 scripts/weather/report.py --json           # machine-readable
    python3 scripts/weather/report.py --save raw.json  # keep the API response…
    python3 scripts/weather/report.py --input raw.json # …and re-render it offline

All of it is MODEL data, not station observations — weather stations near the
front are destroyed, occupied, or (in Ukraine) withheld under martial law. For
today, the hours already past come from the latest short-range model runs
(a "hindcast"), the rest are forecast; the report says where the split is.
Days older than ~3 months come from Open-Meteo's historical-forecast archive
(the same models, stitched, from 2022 on).

What the DRONES / GROUND / COVER columns mean, and the thresholds behind them,
is in assess.py.
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parent))
import assess  # noqa: E402
from sectors import SECTORS, Sector, find  # noqa: E402

TZ = "Europe/Kyiv"
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
ARCHIVE_URL = "https://historical-forecast-api.open-meteo.com/v1/forecast"
# The live endpoint serves roughly three months back; older goes to the archive.
FORECAST_MAX_PAST_DAYS = 90
FORECAST_MAX_DAYS = 16

HOURLY = (
    "temperature_2m", "apparent_temperature", "precipitation", "snowfall",
    "weather_code", "visibility", "cloud_cover_low", "wind_speed_10m",
    "wind_gusts_10m", "soil_moisture_3_to_9cm", "snow_depth",
)
# wet72 reads 72 h back from the end of the first reported day.
LOOKBACK_DAYS = 2


# ── Fetch ───────────────────────────────────────────────────────────────────

def build_url(sectors: list[Sector], start: date, end: date, today: date) -> str:
    if (end - today).days >= FORECAST_MAX_DAYS:
        raise ValueError(f"forecasts reach {FORECAST_MAX_DAYS - 1} days ahead at most")
    first = start - timedelta(days=LOOKBACK_DAYS)
    live = (today - first).days <= FORECAST_MAX_PAST_DAYS
    if not live and end >= today - timedelta(days=1):
        raise ValueError("a range that old can't run up to today — split it, "
                         "or start within the last three months")
    params = {
        "latitude": ",".join(f"{s.lat:.2f}" for s in sectors),
        "longitude": ",".join(f"{s.lon:.2f}" for s in sectors),
        "hourly": ",".join(HOURLY),
        "wind_speed_unit": "ms",
        "timezone": TZ,
        "start_date": first.isoformat(),
        "end_date": end.isoformat(),
    }
    return (FORECAST_URL if live else ARCHIVE_URL) + "?" + urllib.parse.urlencode(params, safe=",")


def fetch(url: str) -> object:
    req = urllib.request.Request(url, headers={"User-Agent": "sbs-stats frontline-weather"})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        try:
            body = json.loads(body).get("reason", body)
        except ValueError:
            pass
        raise SystemExit(f"Open-Meteo HTTP {e.code}: {body}") from None
    except urllib.error.URLError as e:
        raise SystemExit(f"Open-Meteo unreachable: {e.reason}") from None


def hourly_rows(payload: object, n: int) -> list[list[dict]]:
    """Open-Meteo's column-wise `hourly` block → one row list per location.

    One location comes back as an object, several as a list in request order.
    """
    items = payload if isinstance(payload, list) else [payload]
    if len(items) != n:
        raise SystemExit(f"Open-Meteo returned {len(items)} locations for {n} sectors")
    out = []
    for item in items:
        if item.get("error"):
            raise SystemExit(f"Open-Meteo error: {item.get('reason')}")
        cols = item["hourly"]
        times = cols["time"]
        out.append([{k: (v[i] if i < len(v) else None) for k, v in cols.items()}
                    for i in range(len(times))])
    return out


# ── Render ──────────────────────────────────────────────────────────────────

def _f(x: float | None, fmt: str = "{:.0f}", none: str = "–") -> str:
    return none if x is None else fmt.format(x)


def _vis(m: float | None) -> str:
    if m is None:
        return "–"
    return ">10" if m >= 10_000 else f"{m / 1000:.1f}"


def _drones(s: assess.DaySummary) -> str:
    if s.drone_rating == "GOOD":
        return "GOOD"
    top = [r for r, _ in s.drone_reasons.most_common(2)]
    return f"{s.drone_rating} {','.join(top)}"


def _ground(s: assess.DaySummary) -> str:
    return ", ".join(x for x in (s.going, s.exposure) if x)


def _split_note(s: assess.DaySummary) -> str:
    if s.hindcast_hours == s.hours:
        return "settled (model hindcast)"
    if s.hindcast_hours == 0:
        return "forecast"
    return f"00–{s.hindcast_hours:02d}h hindcast · {s.hindcast_hours:02d}–24h forecast"


COLUMNS = (
    ("SECTOR", 22), ("TEMP °C", 9), ("PRECIP", 7), ("WIND/GUST", 10),
    ("VIS km", 7), ("LOW CLD", 8), ("WET72", 6), ("DRONES", 21), ("GROUND", 0),
)


def render_day(day: date, rows: list[tuple[Sector, assess.DaySummary]]) -> str:
    lines = []
    split = _split_note(rows[0][1])
    lines.append(f"── {day:%a %Y-%m-%d} · {split}")
    bad = [sec.key for sec, s in rows if s.bad]
    poor = sum(1 for _, s in rows if s.drone_rating == "POOR")
    mud = sum(1 for _, s in rows if s.going == "mud")
    lines.append(f"   {len(bad)}/{len(rows)} sectors with bad weather"
                 f" · drones POOR in {poor} · mud in {mud}")
    lines.append("")
    lines.append("".join(name.ljust(w) if w else name for name, w in COLUMNS))
    for sec, s in rows:
        cells = (
            ("* " if s.bad else "  ") + sec.key,
            f"{_f(s.t_min)}…{_f(s.t_max)}",
            f"{s.precip:.1f}" + ("*" if s.snowfall >= 0.5 else ""),
            f"{_f(s.wind_max)}/{_f(s.gust_max)}",
            _vis(s.vis_min),
            _f(s.low_cloud_mean, "{:.0f}%"),
            _f(s.wet72),
            _drones(s),
            _ground(s),
        )
        lines.append("".join(c.ljust(w) if w else c
                             for c, (_, w) in zip(cells, COLUMNS)).rstrip())
    notes = [(sec, s) for sec, s in rows if s.cover_windows]
    if notes:
        lines.append("")
        lines.append("   Drone-denied windows (cover for infantry movement):")
        for sec, s in notes:
            lines.append(f"     {sec.key:<20}" + "; ".join(w.label() for w in s.cover_windows))
    return "\n".join(lines)


def render_hourly(sec: Sector, hourly: list[dict], days: list[date], now: datetime | None) -> str:
    lines = [f"── {sec.key} ({sec.near}, {sec.lat:.2f}N {sec.lon:.2f}E) — hour by hour", ""]
    lines.append("TIME              T°C  APP  PRECIP SNOW  WIND GUST  VIS km LOW% CODE  DRONES")
    for h in hourly:
        t = datetime.fromisoformat(h["time"])
        if t.date() not in days:
            continue
        level, reasons = assess.drone_hour(h)
        why = ",".join(r for _, r in reasons)
        mark = "  " if now is None or t < now else "f "
        lines.append(
            f"{mark}{t:%a %d %H:%M}  {_f(h.get('temperature_2m')):>4} {_f(h.get('apparent_temperature')):>4}"
            f"  {_f(h.get('precipitation'), '{:.1f}'):>6} {_f(h.get('snowfall'), '{:.1f}'):>4}"
            f"  {_f(h.get('wind_speed_10m')):>4} {_f(h.get('wind_gusts_10m')):>4}"
            f"  {_vis(h.get('visibility')):>6} {_f(h.get('cloud_cover_low')):>4} {_f(h.get('weather_code')):>4}"
            f"  {assess.LEVEL_NAME[level]}{' ' + why if why else ''}"
        )
    lines.append("")
    lines.append("f = forecast hour; unmarked = model hindcast")
    return "\n".join(lines)


HEADER = """FRONTLINE WEATHER · Open-Meteo (best-match model mix) · {stamp} Kyiv
Model data, not station observations. Drone/ground effects are heuristics — see scripts/weather/assess.py.
* = bad-weather day (drones POOR, mud, or extreme cold). PRECIP mm (* incl. snow) · WIND/GUST m/s · WET72 = rain mm over 72 h
"""


# ── CLI ─────────────────────────────────────────────────────────────────────

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0],
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--date", type=date.fromisoformat, help="first day (default: today, Kyiv)")
    ap.add_argument("--days", type=int, default=2, help="days to report (default 2)")
    ap.add_argument("--sector", action="append",
                    help="limit to a direction (repeatable); known: "
                         + ", ".join(s.key for s in SECTORS))
    ap.add_argument("--hourly", action="store_true", help="hour-by-hour table per sector")
    ap.add_argument("--json", action="store_true", help="print JSON instead of tables")
    ap.add_argument("--save", type=Path, help="write the raw API response (plus what was asked) here")
    ap.add_argument("--input", type=Path, help="render a saved response instead of fetching")
    ap.add_argument("--now", type=datetime.fromisoformat,
                    help="pretend it is this Kyiv local time (YYYY-MM-DDTHH:MM)")
    args = ap.parse_args(argv)

    if args.days < 1:
        ap.error("--days must be ≥ 1")
    try:
        sectors = find(args.sector)
    except ValueError as e:
        ap.error(str(e))

    now = args.now or datetime.now(ZoneInfo(TZ)).replace(tzinfo=None, second=0, microsecond=0)
    today = now.date()
    start = args.date or today
    days = [start + timedelta(days=i) for i in range(args.days)]

    if args.input:
        saved = json.loads(args.input.read_text())
        # A bare API response (no envelope) is taken to be every sector, in order.
        if isinstance(saved, dict) and "response" in saved:
            saved_keys, payload = saved["sectors"], saved["response"]
            if args.now is None and saved.get("fetched"):
                now = datetime.fromisoformat(saved["fetched"])
                today = now.date()
                start = args.date or today
                days = [start + timedelta(days=i) for i in range(args.days)]
        else:
            saved_keys, payload = [s.key for s in SECTORS], saved
        all_series = dict(zip(saved_keys, hourly_rows(payload, len(saved_keys))))
        absent = [s.key for s in sectors if s.key not in all_series]
        if absent:
            raise SystemExit(f"{args.input} has no data for: {', '.join(absent)}")
        series = [all_series[s.key] for s in sectors]
    else:
        try:
            url = build_url(sectors, days[0], days[-1], today)
        except ValueError as e:
            ap.error(str(e))
        payload = fetch(url)
        series = hourly_rows(payload, len(sectors))
        if args.save:
            # Enveloped with what was asked and when, so --input can re-render
            # it faithfully: Open-Meteo echoes grid-snapped coordinates, not
            # the sector, and the hindcast/forecast split depends on the hour.
            args.save.write_text(json.dumps({
                "sectors": [s.key for s in sectors],
                "fetched": now.isoformat(timespec="minutes"),
                "url": url, "response": payload}))

    report = {}
    for sec, hourly in zip(sectors, series):
        report[sec.key] = [s for d in days if (s := assess.summarise_day(hourly, d, now))]

    if args.json:
        print(json.dumps({
            "generated": now.isoformat(timespec="minutes"), "timezone": TZ,
            "sectors": [{"key": sec.key, "gsua": list(sec.labels), "near": sec.near,
                         "lat": sec.lat, "lon": sec.lon,
                         "days": [s.to_dict() for s in report[sec.key]]}
                        for sec in sectors],
        }, ensure_ascii=False, indent=2))
        return 0

    print(HEADER.format(stamp=f"{now:%Y-%m-%d %H:%M}"))
    for d in days:
        rows = [(sec, s) for sec in sectors for s in report[sec.key] if s.day == d]
        if rows:
            print(render_day(d, rows))
            print()
    if args.hourly:
        for sec, hourly in zip(sectors, series):
            print(render_hourly(sec, hourly, days, now))
            print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
