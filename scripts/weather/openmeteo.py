"""Open-Meteo client shared by the CLI report (report.py) and the ingest.

Stdlib only. One request covers every sector: Open-Meteo takes comma-separated
coordinates and answers with one location per pair, in order.
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date
from typing import Callable, Sequence

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

# A 429 here is mostly not our own quota. From a shared egress IP (a cloud
# session, a CI runner) other people's calls count against the same address,
# and Open-Meteo answers "Daily API request limit exceeded" for what turns out
# to be a per-minute limit: a retry ~30 s later has worked every time so far.
RETRY_DELAYS_S = (30, 60, 120)


class OpenMeteoError(RuntimeError):
    pass


def request_url(base: str, sectors: Sequence, start: date, end: date) -> str:
    """Hourly fields for every sector, local Kyiv time, wind in m/s."""
    params = {
        "latitude": ",".join(f"{s.lat:.2f}" for s in sectors),
        "longitude": ",".join(f"{s.lon:.2f}" for s in sectors),
        "hourly": ",".join(HOURLY),
        "wind_speed_unit": "ms",
        "timezone": TZ,
        "start_date": start.isoformat(),
        "end_date": end.isoformat(),
    }
    return base + "?" + urllib.parse.urlencode(params, safe=",")


def _get(url: str) -> object:
    req = urllib.request.Request(url, headers={"User-Agent": "sbs-stats frontline-weather"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.load(resp)


def fetch(url: str, *, delays: Sequence[float] = RETRY_DELAYS_S,
          sleep: Callable[[float], None] = time.sleep,
          get: Callable[[str], object] = _get) -> object:
    """GET and decode, retrying rate limits, 5xx and dropped connections."""
    last = ""
    for attempt in range(len(delays) + 1):
        try:
            return get(url)
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")
            try:
                body = json.loads(body).get("reason", body)
            except ValueError:
                pass
            last = f"HTTP {e.code}: {body}"
            if e.code != 429 and e.code < 500:
                raise OpenMeteoError(last) from None
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            last = f"unreachable: {getattr(e, 'reason', e)}"
        if attempt < len(delays):
            sleep(delays[attempt])
    raise OpenMeteoError(f"{last} (after {len(delays) + 1} attempts)")


def hourly_rows(payload: object, n: int) -> list[list[dict]]:
    """Open-Meteo's column-wise `hourly` block → one row list per location.

    One location comes back as an object, several as a list in request order.
    """
    items = payload if isinstance(payload, list) else [payload]
    if len(items) != n:
        raise OpenMeteoError(f"returned {len(items)} locations for {n} sectors")
    out = []
    for item in items:
        if item.get("error"):
            raise OpenMeteoError(f"error: {item.get('reason')}")
        cols = item["hourly"]
        times = cols["time"]
        out.append([{k: (v[i] if i < len(v) else None) for k, v in cols.items()}
                    for i in range(len(times))])
    return out
