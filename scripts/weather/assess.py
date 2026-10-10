"""Weather → operational effect, as pure functions over Open-Meteo hourly rows.

Everything here is a HEURISTIC, written down so it can be argued with: the
thresholds are open-source rules of thumb for small UAVs and off-road mobility,
not doctrine, and they are constants at the top of the file for that reason.
What the report claims is "conditions of the kind that limit X", never "X did
not happen" — the point is to line it up against the attack counts later and
see whether it means anything.

Three readings per sector-day:

  drones   small multirotor / FPV / light fixed-wing. Wind, precipitation,
           fog, icing and deep cold, judged hour by hour. Larger fixed-wing
           (Orlan, Lancet, long-range one-way UAVs) tolerate more of all of
           it, so a POOR day thins the sky rather than empties it.
  ground   off-road trafficability (mud season) and cold/heat exposure,
           judged per day — soil does not change hour to hour.
  cover    the interaction that matters most at the front now: hours when
           drones are SEVERELY limited are hours when infantry can move with
           less observation. Fog and rain are the conditions infiltration
           assaults are reported to exploit, so a "bad weather" day can be a
           busier one on the ground, not a quieter one.

Units are the ones report.py requests: wind m/s, visibility m, precipitation
mm, snowfall cm, snow depth m, soil moisture m³/m³, temperature °C.
"""
from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta

OK, DEGRADED, SEVERE = 0, 1, 2

# ── Small-UAV limits ────────────────────────────────────────────────────────
# Consumer-derived quadcopters (Mavic class) are rated ~12 m/s; FPVs fly in
# more but lose range and accuracy, and gusts are what knock them down. At
# 10 m height the model wind understates what a drone at 50–100 m sees, which
# is why the bands start lower than the spec sheets.
WIND_DEGRADED = 8.0       # m/s sustained
WIND_SEVERE = 12.0
GUST_DEGRADED = 11.0      # m/s
GUST_SEVERE = 15.0
# Most of these airframes are not sealed, and water on the lens blinds them.
RAIN_DEGRADED = 0.5       # mm/h
RAIN_SEVERE = 2.5
SNOW_DEGRADED = 0.1       # cm/h
SNOW_SEVERE = 0.5
# Fog blinds day cameras outright and attenuates thermal heavily.
VIS_SEVERE = 1000.0       # m
VIS_DEGRADED = 4000.0
# LiPo capacity falls off hard below freezing.
COLD_DEGRADED = -15.0     # °C air temperature
COLD_SEVERE = -25.0
# Supercooled water on props/airframe: near-freezing air with something wet.
ICING_TEMP = (-6.0, 1.0)

FOG_CODES = {45, 48}
FREEZING_CODES = {56, 57, 66, 67}
THUNDER_CODES = {95, 96, 99}

# A day is POOR for drones with this many SEVERE hours, MARGINAL with this
# many DEGRADED-or-worse hours. Six hours ≈ a quarter of the day: long enough
# to plan an operation around, not just wait out.
DAY_POOR_HOURS = 6
DAY_MARGINAL_HOURS = 6
# A drone-limited run has to last this long to count as a window for movement,
# and a lull this short inside one doesn't break it (gusts come and go).
COVER_MIN_HOURS = 2
COVER_MAX_GAP = 1

# ── Ground ──────────────────────────────────────────────────────────────────
# Rain over the 72 h ending with the day: the mud-season signal. Chernozem
# goes from dusty to unworkable on a couple of autumn fronts.
WET72_SOFT = 10.0         # mm
WET72_MUD = 25.0
# Model soil moisture, 3–9 cm layer. Black-earth field capacity sits near
# 0.30–0.35; above ~0.40 it is close to saturation.
SOIL_SOFT = 0.34          # m³/m³
SOIL_MUD = 0.40
SNOW_DEEP = 0.25          # m
FROZEN_TMAX = 0.0         # a day that never thaws keeps the ground firm
EXPOSURE_COLD = -15.0     # °C apparent (wind chill)
EXPOSURE_EXTREME = -25.0
EXPOSURE_HEAT = 33.0

LEVEL_NAME = {OK: "ok", DEGRADED: "degraded", SEVERE: "severe"}


def _v(h: dict, key: str) -> float | None:
    x = h.get(key)
    return None if x is None else float(x)


def drone_hour(h: dict) -> tuple[int, list[tuple[int, str]]]:
    """(level, [(level, reason), …]) for one hourly row."""
    out: list[tuple[int, str]] = []

    def add(level: int, reason: str) -> None:
        if level:
            out.append((level, reason))

    wind, gust = _v(h, "wind_speed_10m"), _v(h, "wind_gusts_10m")
    if (wind is not None and wind >= WIND_SEVERE) or (gust is not None and gust >= GUST_SEVERE):
        add(SEVERE, "wind")
    elif (wind is not None and wind >= WIND_DEGRADED) or (gust is not None and gust >= GUST_DEGRADED):
        add(DEGRADED, "wind")

    code = h.get("weather_code")
    code = None if code is None else int(code)
    precip = _v(h, "precipitation") or 0.0
    snow = _v(h, "snowfall") or 0.0
    if code in THUNDER_CODES:
        add(SEVERE, "thunderstorm")
    if snow >= SNOW_SEVERE:
        add(SEVERE, "snow")
    elif snow >= SNOW_DEGRADED:
        add(DEGRADED, "snow")
    # `precipitation` includes the snow's water; Open-Meteo converts 7 cm of
    # snow to 10 mm. Judge rain on the liquid remainder so a snowfall is not
    # counted twice.
    rain = max(0.0, precip - snow * 10 / 7)
    if rain >= RAIN_SEVERE:
        add(SEVERE, "rain")
    elif rain >= RAIN_DEGRADED:
        add(DEGRADED, "rain")

    vis = _v(h, "visibility")
    if code in FOG_CODES or (vis is not None and vis < VIS_SEVERE):
        add(SEVERE, "fog")
    elif vis is not None and vis < VIS_DEGRADED:
        add(DEGRADED, "mist")

    temp = _v(h, "temperature_2m")
    if temp is not None:
        if temp <= COLD_SEVERE:
            add(SEVERE, "cold")
        elif temp <= COLD_DEGRADED:
            add(DEGRADED, "cold")
        wet = precip > 0 or code in FOG_CODES or (vis is not None and vis < VIS_SEVERE)
        if code in FREEZING_CODES or (ICING_TEMP[0] <= temp <= ICING_TEMP[1] and wet):
            add(SEVERE, "icing")

    level = max((lv for lv, _ in out), default=OK)
    return level, out


def trafficability(wet72: float | None, soil: float | None, t_max: float | None,
                   snow_depth: float | None) -> tuple[str, int]:
    """Off-road going for the day: (label, level)."""
    if snow_depth is not None and snow_depth >= SNOW_DEEP:
        return "deep snow", DEGRADED
    if t_max is not None and t_max <= FROZEN_TMAX:
        return "frozen", OK
    level = OK
    if soil is not None:
        level = SEVERE if soil >= SOIL_MUD else DEGRADED if soil >= SOIL_SOFT else OK
    elif wet72 is not None:
        level = SEVERE if wet72 >= WET72_MUD else DEGRADED if wet72 >= WET72_SOFT else OK
    # A wet spell the soil layer hasn't caught up with yet still softens tracks.
    if wet72 is not None and wet72 >= WET72_MUD:
        level = max(level, DEGRADED)
    return ("firm", "soft", "mud")[level], level


def exposure(app_min: float | None, app_max: float | None) -> tuple[str, int]:
    if app_min is not None and app_min <= EXPOSURE_EXTREME:
        return "extreme cold", SEVERE
    if app_min is not None and app_min <= EXPOSURE_COLD:
        return "cold", DEGRADED
    if app_max is not None and app_max >= EXPOSURE_HEAT:
        return "heat", DEGRADED
    return "", OK


@dataclass
class Window:
    start: int          # hour of day, inclusive
    end: int            # hour of day, exclusive
    reasons: list[str]

    def label(self) -> str:
        return f"{self.start:02d}–{self.end:02d}h {'/'.join(self.reasons)}"


@dataclass
class DaySummary:
    day: date
    hours: int
    hindcast_hours: int           # hours already past at fetch time
    t_min: float | None = None
    t_max: float | None = None
    precip: float = 0.0
    snowfall: float = 0.0
    wind_max: float | None = None
    gust_max: float | None = None
    vis_min: float | None = None
    fog_hours: int = 0
    low_cloud_mean: float | None = None
    wet72: float | None = None
    soil: float | None = None
    snow_depth: float | None = None
    drone_severe_hours: int = 0
    drone_degraded_hours: int = 0
    drone_reasons: Counter = field(default_factory=Counter)
    cover_windows: list[Window] = field(default_factory=list)
    going: str = ""
    going_level: int = OK
    exposure: str = ""
    exposure_level: int = OK

    @property
    def drone_rating(self) -> str:
        if self.drone_severe_hours >= DAY_POOR_HOURS:
            return "POOR"
        if self.drone_severe_hours + self.drone_degraded_hours >= DAY_MARGINAL_HOURS:
            return "MARGINAL"
        return "GOOD"

    @property
    def bad(self) -> bool:
        """The headline question: is this a bad-weather day at this sector?"""
        return (self.drone_rating == "POOR" or self.going_level == SEVERE
                or self.exposure_level == SEVERE)

    def to_dict(self) -> dict:
        return {
            "date": self.day.isoformat(),
            "hours": self.hours,
            "hindcast_hours": self.hindcast_hours,
            "t_min": self.t_min, "t_max": self.t_max,
            "precip_mm": round(self.precip, 1), "snowfall_cm": round(self.snowfall, 1),
            "wind_max_ms": self.wind_max, "gust_max_ms": self.gust_max,
            "visibility_min_m": self.vis_min, "fog_hours": self.fog_hours,
            "low_cloud_mean_pct": self.low_cloud_mean,
            "wet72_mm": None if self.wet72 is None else round(self.wet72, 1),
            "soil_moisture": self.soil, "snow_depth_m": self.snow_depth,
            "drones": {
                "rating": self.drone_rating,
                "severe_hours": self.drone_severe_hours,
                "degraded_hours": self.drone_degraded_hours,
                "reasons": dict(self.drone_reasons.most_common()),
            },
            "cover_windows": [{"start": w.start, "end": w.end, "reasons": w.reasons}
                              for w in self.cover_windows],
            "ground": {"going": self.going, "going_level": LEVEL_NAME[self.going_level],
                       "exposure": self.exposure,
                       "exposure_level": LEVEL_NAME[self.exposure_level]},
            "bad": self.bad,
        }


def _hour_time(h: dict) -> datetime:
    return datetime.fromisoformat(h["time"])


def _windows(levels: list[tuple[int, int, list[tuple[int, str]]]]) -> list[Window]:
    """Runs of SEVERE hours spanning at least COVER_MIN_HOURS, bridging lulls
    of up to COVER_MAX_GAP hours."""
    out: list[Window] = []
    run: list[tuple[int, list[tuple[int, str]]]] = []

    def flush() -> None:
        if run and run[-1][0] + 1 - run[0][0] >= COVER_MIN_HOURS:
            reasons = Counter(r for _, rs in run for lv, r in rs if lv == SEVERE)
            out.append(Window(run[0][0], run[-1][0] + 1, [r for r, _ in reasons.most_common()]))
        run.clear()

    for hour, level, reasons in levels:
        if level != SEVERE:
            continue
        if run and hour - run[-1][0] - 1 > COVER_MAX_GAP:
            flush()
        run.append((hour, reasons))
    flush()
    return out


def summarise_day(hourly: list[dict], day: date, now: datetime | None = None) -> DaySummary | None:
    """Summarise one local day from a sector's full hourly series.

    `hourly` may (and for wet72 should) start at least two days earlier: the
    72-hour rain total reads back into it. `now` (naive, local) splits the day
    into hindcast and forecast hours; None means the whole day is settled.
    """
    rows = [h for h in hourly if _hour_time(h).date() == day]
    if not rows:
        return None
    s = DaySummary(day=day, hours=len(rows),
                   hindcast_hours=sum(1 for h in rows if now is None or _hour_time(h) < now))

    def col(key: str) -> list[float]:
        return [float(h[key]) for h in rows if h.get(key) is not None]

    temps, app = col("temperature_2m"), col("apparent_temperature")
    s.t_min, s.t_max = (min(temps), max(temps)) if temps else (None, None)
    s.precip = sum(col("precipitation"))
    s.snowfall = sum(col("snowfall"))
    winds, gusts, vis = col("wind_speed_10m"), col("wind_gusts_10m"), col("visibility")
    s.wind_max = max(winds) if winds else None
    s.gust_max = max(gusts) if gusts else None
    s.vis_min = min(vis) if vis else None
    low = col("cloud_cover_low")
    s.low_cloud_mean = round(sum(low) / len(low)) if low else None
    soil = col("soil_moisture_3_to_9cm")
    s.soil = round(max(soil), 3) if soil else None
    depth = col("snow_depth")
    s.snow_depth = max(depth) if depth else None

    end = datetime.combine(day + timedelta(days=1), datetime.min.time())
    window = [h for h in hourly if end - timedelta(hours=72) <= _hour_time(h) < end]
    if len(window) >= 72:
        s.wet72 = sum(float(h.get("precipitation") or 0.0) for h in window)

    levels = []
    for h in rows:
        level, reasons = drone_hour(h)
        levels.append((_hour_time(h).hour, level, reasons))
        if level == SEVERE:
            s.drone_severe_hours += 1
        elif level == DEGRADED:
            s.drone_degraded_hours += 1
        s.drone_reasons.update({r for _, r in reasons})
        if any(r == "fog" for lv, r in reasons):
            s.fog_hours += 1
    s.cover_windows = _windows(levels)

    s.going, s.going_level = trafficability(s.wet72, s.soil, s.t_max, s.snow_depth)
    s.exposure, s.exposure_level = exposure(min(app) if app else None, max(app) if app else None)
    return s
