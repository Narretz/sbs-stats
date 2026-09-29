import { useCallback } from "react";
import type { Database } from "sql.js";
import type { ZelenskyBound, ZelenskyWeekRow } from "@/types";
import { makeResourceCache, useRefreshableResource } from "@/hooks/useRefreshableResource";
import { loadWholeDb, queryRows } from "@/hooks/sqlLoader";

// Tiny DB (one tally a week) → fetched whole via sql.js, like Rubikon. Served
// from R2 in production and from ./data/ by the vite dev middleware locally.
const DB_URL =
  import.meta.env.VITE_ZELENSKY_WEEKLY_DB_URL ?? `${import.meta.env.BASE_URL}data/zelensky-weekly.db`;
const loadDatabase = () => loadWholeDb(DB_URL, "Zelensky weekly");

const dbCache = makeResourceCache<Database>();

// The tally is posted once a week; CI polls Sat/Sun/Mon evenings.
export const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

const num = (v: unknown) => (v == null ? null : Number(v));
const bound = (v: unknown) => (v == null ? null : (String(v) as ZelenskyBound));

export function useDatabaseZelenskyWeekly({ enabled = true }: { enabled?: boolean } = {}) {
  const { resource: db, loadState, error, lastRefreshed, refresh, refreshCount, refreshIntervalMs } =
    useRefreshableResource({
      cache: dbCache,
      load: loadDatabase,
      refreshIntervalMs: REFRESH_INTERVAL_MS,
      enabled,
    });

  // The `weekly` view does the resolving — latest version of each post, one
  // whole-week tally per ISO week, partial weeks excluded (see schema.sql).
  const queryWeeks = useCallback((): ZelenskyWeekRow[] => {
    if (!db) return [];
    return queryRows<Record<string, unknown>>(db, "SELECT * FROM weekly ORDER BY period").map((r) => ({
      period: String(r.period),
      period_start: String(r.period_start),
      period_end: String(r.period_end),
      post_id: Number(r.post_id),
      posted_at: String(r.posted_at),
      url: String(r.url),
      drones: num(r.drones),
      drones_bound: bound(r.drones_bound),
      bombs: num(r.bombs),
      bombs_bound: bound(r.bombs_bound),
      missiles: num(r.missiles),
      missiles_bound: bound(r.missiles_bound),
    }));
  }, [db]);

  return {
    loadState, error,
    queryWeeks,
    refresh, lastRefreshed, refreshCount,
    refreshIntervalMs,
  };
}
