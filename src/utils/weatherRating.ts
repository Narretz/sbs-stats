// Weather → small-drone conditions, hour by hour: the app's copy of
// scripts/weather/assess.py (drone_hour, the day rating, drone-denied windows).
//
// The thresholds are not repeated here — both read src/data/weatherRules.json,
// where the reasoning behind each number is in assess.py. The case file
// src/data/weatherRatingCases.json is run against both implementations
// (weatherRating.test.ts / test_report.py), so a rule changed on one side and
// not the other fails a test.
//
// A heuristic about CONDITIONS, from model data: "the kind of hour that grounds
// small quadcopters and FPVs", never "no drones flew".

import rules from "@/data/weatherRules.json";

export const OK = 0;
export const DEGRADED = 1;
export const SEVERE = 2;
export type Level = typeof OK | typeof DEGRADED | typeof SEVERE;

/** The fields the drone rating reads — what the app copy of weather.db carries. */
export interface WeatherHour {
  temperature_2m: number | null;
  precipitation: number | null;   // mm in the hour, snow's water included
  snowfall: number | null;        // cm
  weather_code: number | null;    // WMO
  visibility: number | null;      // m
  wind_speed_10m: number | null;  // m/s
  wind_gusts_10m: number | null;  // m/s
}

export type Reason = "wind" | "thunderstorm" | "snow" | "rain" | "fog" | "mist" | "cold" | "icing";

export interface HourRating {
  level: Level;
  /** In the order the rule checks them — the same order as assess.py. */
  reasons: [Level, Reason][];
}

const D = rules.drone;
const FOG = new Set(D.fog_codes);
const FREEZING = new Set(D.freezing_codes);
const THUNDER = new Set(D.thunder_codes);

export function droneHour(h: WeatherHour): HourRating {
  const reasons: [Level, Reason][] = [];
  const add = (level: Level, reason: Reason) => { if (level) reasons.push([level, reason]); };

  const wind = h.wind_speed_10m, gust = h.wind_gusts_10m;
  if ((wind != null && wind >= D.wind_severe) || (gust != null && gust >= D.gust_severe)) add(SEVERE, "wind");
  else if ((wind != null && wind >= D.wind_degraded) || (gust != null && gust >= D.gust_degraded)) add(DEGRADED, "wind");

  const code = h.weather_code;
  const precip = h.precipitation ?? 0;
  const snow = h.snowfall ?? 0;
  if (code != null && THUNDER.has(code)) add(SEVERE, "thunderstorm");
  if (snow >= D.snow_severe) add(SEVERE, "snow");
  else if (snow >= D.snow_degraded) add(DEGRADED, "snow");
  // `precipitation` includes the snow's water (7 cm of snow = 10 mm), so rain
  // is judged on the liquid remainder.
  const rain = Math.max(0, precip - (snow * 10) / 7);
  if (rain >= D.rain_severe) add(SEVERE, "rain");
  else if (rain >= D.rain_degraded) add(DEGRADED, "rain");

  const vis = h.visibility;
  const isFog = (code != null && FOG.has(code)) || (vis != null && vis < D.vis_severe);
  if (isFog) add(SEVERE, "fog");
  else if (vis != null && vis < D.vis_degraded) add(DEGRADED, "mist");

  const temp = h.temperature_2m;
  if (temp != null) {
    if (temp <= D.cold_severe) add(SEVERE, "cold");
    else if (temp <= D.cold_degraded) add(DEGRADED, "cold");
    const wet = rain >= D.icing_min_liquid || isFog;
    const [lo, hi] = D.icing_temp;
    if ((code != null && FREEZING.has(code)) || (lo <= temp && temp <= hi && wet)) add(SEVERE, "icing");
  }

  const level = reasons.reduce<Level>((m, [l]) => (l > m ? l : m), OK);
  return { level, reasons };
}

// One scale for hours and days alike — ok / limited / severe — so the strips,
// tooltips and CLI share three words. A day takes it from counting its hours.
export type DayRating = "ok" | "limited" | "severe";

/** severe with ≥ day_severe_hours severe hours, limited with
 *  ≥ day_limited_hours limited-or-worse ones, ok otherwise. */
export function droneDay(levels: Level[]): DayRating {
  const severe = levels.filter((l) => l === SEVERE).length;
  const limited = levels.filter((l) => l >= DEGRADED).length;
  if (severe >= D.day_severe_hours) return "severe";
  if (limited >= D.day_limited_hours) return "limited";
  return "ok";
}

export interface CoverWindow {
  start: number;  // hour, inclusive
  end: number;    // hour, exclusive
  reasons: Reason[];  // severe reasons, commonest first
}

/** Runs of SEVERE hours spanning ≥ cover_min_hours, bridging lulls of up to
 *  cover_max_gap hours — the "drone-denied windows". */
export function coverWindows(hours: { hour: number; rating: HourRating }[]): CoverWindow[] {
  const out: CoverWindow[] = [];
  let run: { hour: number; rating: HourRating }[] = [];
  const flush = () => {
    if (run.length && run[run.length - 1].hour + 1 - run[0].hour >= D.cover_min_hours) {
      const counts = new Map<Reason, number>();
      for (const { rating } of run) {
        for (const [l, r] of rating.reasons) if (l === SEVERE) counts.set(r, (counts.get(r) ?? 0) + 1);
      }
      // Commonest first; ties keep first-seen order, like Python's Counter.
      const reasons = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([r]) => r);
      out.push({ start: run[0].hour, end: run[run.length - 1].hour + 1, reasons });
    }
    run = [];
  };
  for (const h of [...hours].sort((a, b) => a.hour - b.hour)) {
    if (h.rating.level !== SEVERE) continue;
    if (run.length && h.hour - run[run.length - 1].hour - 1 > D.cover_max_gap) flush();
    run.push(h);
  }
  flush();
  return out;
}
