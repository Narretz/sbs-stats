import { useCallback } from "react";
import type { Database } from "sql.js";
import { makeResourceCache, useRefreshableResource } from "@/hooks/useRefreshableResource";
import { loadWholeDb, queryRows } from "@/hooks/sqlLoader";
import type { WeatherHour } from "@/utils/weatherRating";

// The front-line weather strip's data: the compact app copy of weather.db
// (scripts/weather/app_db.sql), ~3.6 MB a year, fetched whole. Read only by
// the weather strips on the hourly and daily pages, and only while the reader
// has them switched on (useWeatherStripPref) — so it is a plain hook rather
// than a context: nothing else waits on it, and a failure must leave the
// charts alone.
const DB_URL =
  import.meta.env.VITE_WEATHER_DB_URL ?? `${import.meta.env.BASE_URL}data/weather.app.db`;
const loadDatabase = () => loadWholeDb(DB_URL, "Weather");

const dbCache = makeResourceCache<Database>();

// CI fetches hourly; the strip's "today" is mostly forecast that each run
// firms up.
export const REFRESH_INTERVAL_MS = 30 * 60 * 1000;

export interface WeatherSector {
  id: number;
  key: string;    // GSUA direction label
  gsua: string;   // every GSUA label it stands for, comma-joined
  near: string;
}

export interface WeatherCell extends WeatherHour {
  sector: number;
  date: string;   // YYYY-MM-DD, Kyiv
  hour: number;
  /** Still ahead when the last run fetched it — a forecast, not a hindcast. */
  forecast: boolean;
}

export interface WeatherRange {
  sectors: WeatherSector[];
  /** Every stored hour in the range, ordered by date, sector, hour. */
  cells: WeatherCell[];
  /** UTC ISO of the last live run, for the "as of" line. */
  asOf: string | null;
}

// Undo app_db.sql's integer scaling.
const div = (v: unknown, by: number) => (v == null ? null : Number(v) / by);
const num = (v: unknown) => (v == null ? null : Number(v));

export function useDatabaseWeather({ enabled = true }: { enabled?: boolean } = {}) {
  const { resource: db, loadState, error } = useRefreshableResource({
    cache: dbCache,
    load: loadDatabase,
    refreshIntervalMs: REFRESH_INTERVAL_MS,
    enabled,
  });

  // A day for the hourly strip, a window of them for the daily one. Dates are
  // checked rather than escaped: they come from the page's own controls.
  const queryRange = useCallback((start: string, end: string): WeatherRange | null => {
    const ISO = /^\d{4}-\d{2}-\d{2}$/;
    if (!db || !ISO.test(start) || !ISO.test(end)) return null;
    const sectors = queryRows<Record<string, unknown>>(
      db, "SELECT id, key, gsua, near FROM sectors ORDER BY sort",
    ).map((r) => ({ id: Number(r.id), key: String(r.key), gsua: String(r.gsua), near: String(r.near) }));
    const cells = queryRows<Record<string, unknown>>(
      db, `SELECT * FROM app_hourly WHERE date BETWEEN '${start}' AND '${end}' ORDER BY date, sector, hour`,
    ).map((r) => ({
      sector: Number(r.sector),
      date: String(r.date),
      hour: Number(r.hour),
      forecast: Number(r.forecast) === 1,
      temperature_2m: div(r.t10, 10),
      precipitation: div(r.pr10, 10),
      snowfall: div(r.sn100, 100),
      weather_code: num(r.code),
      visibility: num(r.vis),
      wind_speed_10m: div(r.w10, 10),
      wind_gusts_10m: div(r.g10, 10),
    }));
    const asOf = queryRows<{ t: string | null }>(
      db, "SELECT MAX(fetched_at) AS t FROM runs WHERE mode = 'live'",
    )[0]?.t ?? null;
    return { sectors, cells, asOf };
  }, [db]);

  return { loadState, error, queryRange };
}
