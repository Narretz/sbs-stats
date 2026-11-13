import { useCallback } from "react";
import type { Database } from "sql.js";
import { makeResourceCache, useRefreshableResource } from "@/hooks/useRefreshableResource";
import { loadWholeDb, queryRows } from "@/hooks/sqlLoader";
import type { WeatherHour } from "@/utils/weatherRating";

// The front-line weather strip's data: the compact app copy of weather.db
// (scripts/weather/app_db.sql), ~3.6 MB a year, fetched whole. Read by one
// component only — WeatherStrip on the SBS hourly page — so it is a plain hook
// rather than a context: nothing else should wait on it, and a failure must
// leave the SBS charts alone.
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
  hour: number;
  /** Still ahead when the last run fetched it — a forecast, not a hindcast. */
  forecast: boolean;
}

export interface WeatherDay {
  sectors: WeatherSector[];
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

  const queryDay = useCallback((date: string): WeatherDay | null => {
    if (!db || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    const sectors = queryRows<Record<string, unknown>>(
      db, "SELECT id, key, gsua, near FROM sectors ORDER BY sort",
    ).map((r) => ({ id: Number(r.id), key: String(r.key), gsua: String(r.gsua), near: String(r.near) }));
    const cells = queryRows<Record<string, unknown>>(
      db, `SELECT * FROM app_hourly WHERE date = '${date}' ORDER BY sector, hour`,
    ).map((r) => ({
      sector: Number(r.sector),
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

  return { loadState, error, queryDay };
}
