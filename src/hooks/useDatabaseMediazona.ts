import { useCallback } from "react";
import type { Database } from "sql.js";
import type {
  MediazonaRolesRow,
  MediazonaEstimateRow,
  MediazonaRoleGroupKey,
} from "@/types";
import { MEDIAZONA_ROLE_GROUP_KEYS } from "@/types";
import { latestPerWeek, queryRolesWeekly } from "@/utils/mediazonaRoles";
import { makeResourceCache, useRefreshableResource } from "@/hooks/useRefreshableResource";
import { loadWholeDb, queryRows } from "@/hooks/sqlLoader";

// Production reads the app copy (mediazona.app.db, ~0.1 MB: each week's latest
// version only; dev reads the full DB) → fetch whole via sql.js, like the
// RU-losses loader (no httpvfs).
const DB_URL =
  import.meta.env.VITE_MEDIAZONA_DB_URL ??
  `${import.meta.env.BASE_URL}data/mediazona.db`;
const loadDatabase = () => loadWholeDb(DB_URL, "Mediazona");

const dbCache = makeResourceCache<Database>();

// The latest version of each week: see latestPerWeek.
const LATEST_ESTIMATE = latestPerWeek("weekly_estimate");

// Weekly data updates at most daily; an hourly poll is plenty (plus on-focus +
// manual refresh).
export const REFRESH_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export function useDatabaseMediazona({ enabled = true }: { enabled?: boolean } = {}) {
  const { resource: db, loadState, error, lastRefreshed, refresh, refreshCount, refreshIntervalMs } =
    useRefreshableResource({
      cache: dbCache,
      load: loadDatabase,
      refreshIntervalMs: REFRESH_INTERVAL_MS,
      enabled,
    });

  // ── Roles: one row per week, raw role columns summed into display groups ──────
  const queryRoles = useCallback(
    (): MediazonaRolesRow[] => (db ? queryRolesWeekly(db) : []),
    [db],
  );

  // ── Estimate: documented (named) vs probate-registry modelled total per week ──
  const queryEstimate = useCallback((): MediazonaEstimateRow[] => {
    if (!db) return [];
    const rows = queryRows<Record<string, number | null>>(
      db,
      // An empty latest version is a week a newer release dropped.
      `SELECT week, documented, estimate FROM ${LATEST_ESTIMATE}
       WHERE documented IS NOT NULL OR estimate IS NOT NULL ORDER BY week ASC`
    );
    return rows.map((r) => ({
      week: String(r.week),
      documented: typeof r.documented === "number" ? r.documented : null,
      estimate: typeof r.estimate === "number" ? r.estimate : null,
    }));
  }, [db]);

  // ── Monthly buckets: sum weekly values by the start-date's calendar month ─────
  // A week's value is assigned entirely to the month its start date falls in
  // (no proportional split for week 0/53 straddling month boundaries — the
  // smearing is small and matches how Mediazona itself labels weeks).
  const queryRolesMonthly = useCallback((): MediazonaRolesRow[] => {
    const weekly = queryRoles();
    const buckets = new Map<string, MediazonaRolesRow>();
    for (const r of weekly) {
      const month = r.week.slice(0, 7) + "-01";
      let bucket = buckets.get(month);
      if (!bucket) {
        const empty = MEDIAZONA_ROLE_GROUP_KEYS.reduce(
          (acc, k) => { acc[k] = 0; return acc; },
          {} as Record<MediazonaRoleGroupKey, number>,
        );
        bucket = { week: month, total: 0, ...empty };
        buckets.set(month, bucket);
      }
      bucket.total += r.total;
      for (const k of MEDIAZONA_ROLE_GROUP_KEYS) bucket[k] += r[k];
    }
    return [...buckets.values()].sort((a, b) => a.week.localeCompare(b.week));
  }, [queryRoles]);

  const queryEstimateMonthly = useCallback((): MediazonaEstimateRow[] => {
    const weekly = queryEstimate();
    const buckets = new Map<string, { documented: number | null; estimate: number | null }>();
    for (const r of weekly) {
      const month = r.week.slice(0, 7) + "-01";
      let bucket = buckets.get(month);
      if (!bucket) {
        bucket = { documented: null, estimate: null };
        buckets.set(month, bucket);
      }
      if (typeof r.documented === "number") bucket.documented = (bucket.documented ?? 0) + r.documented;
      if (typeof r.estimate === "number") bucket.estimate = (bucket.estimate ?? 0) + r.estimate;
    }
    return [...buckets.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([week, v]) => ({
        week,
        documented: v.documented,
        // `estimate` is a modelled real number — keeping the decimals in the
        // bucket sum is noise, so round here once and every consumer gets a
        // clean integer.
        estimate: v.estimate == null ? null : Math.round(v.estimate),
      }));
  }, [queryEstimate]);

  // Covered week range across BOTH series (min start, max end), for the
  // "Data … – …" freshness note in the page header.
  const queryDataWindow = useCallback((): { minDate: string | null; maxDate: string | null } => {
    if (!db) return { minDate: null, maxDate: null };
    const rows = queryRows<{ minDate: string | null; maxDate: string | null }>(
      db,
      `SELECT MIN(week) AS minDate, MAX(week) AS maxDate FROM (
         SELECT week FROM weekly_roles UNION ALL SELECT week FROM weekly_estimate
       )`
    );
    return rows[0] ?? { minDate: null, maxDate: null };
  }, [db]);

  return {
    loadState, error,
    queryRoles, queryEstimate,
    queryRolesMonthly, queryEstimateMonthly,
    queryDataWindow,
    refresh, lastRefreshed, refreshCount,
    refreshIntervalMs,
  };
}
