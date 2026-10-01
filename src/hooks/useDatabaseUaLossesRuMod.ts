import { useCallback } from "react";
import type { Database } from "sql.js";
import type {
  UaLossesRuModDailyRow,
  UaLossesRuModGlobalStats,
  UaLossesRuModMetricKey,
  UaLossesRuModMonthlyRow,
} from "@/types";
import { UA_LOSSES_RU_MOD_ARMOUR_KEYS, UA_LOSSES_RU_MOD_METRIC_KEYS } from "@/types";
import { makeResourceCache, useRefreshableResource } from "@/hooks/useRefreshableResource";
import { loadWholeDb, queryRows } from "@/hooks/sqlLoader";
import { windowStartSql } from "@/utils/dayRange";
import { projectFromDays } from "@/utils/monthProjection";

// ~1 MB → fetched whole via sql.js. Local only: no production URL exists (the
// sheet has no licence), so this resolves to the dev server's data/ copy.
const DB_URL =
  import.meta.env.VITE_UA_LOSSES_RU_MOD_DB_URL ??
  `${import.meta.env.BASE_URL}data/ua-losses-ru-mod-john-felix.db`;
const loadDatabase = () => loadWholeDb(DB_URL, "UA losses (RU MoD)");

const dbCache = makeResourceCache<Database>();

// Every key the pages read: the MoD's categories plus the armour itemisation.
const KEYS = [...UA_LOSSES_RU_MOD_METRIC_KEYS, ...UA_LOSSES_RU_MOD_ARMOUR_KEYS];
const COLS = KEYS.join(", ");

// The MoD's day is Moscow's.
const getMskDateString = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Moscow" });

// Hand-maintained, updated about once a day.
export const REFRESH_INTERVAL_MS = 60 * 60 * 1000;

// Rows come off the ingest's `daily` view: the MoD's running totals already
// diffed into one row per report day, latest version of every cell. Dates are
// the report day (`report_date`), not the derived `loss_date`.
export function useDatabaseUaLossesRuMod({ enabled = true }: { enabled?: boolean } = {}) {
  const { resource: db, loadState, error, lastRefreshed, refresh, refreshCount, refreshIntervalMs } =
    useRefreshableResource({
      cache: dbCache,
      load: loadDatabase,
      refreshIntervalMs: REFRESH_INTERVAL_MS,
      enabled,
    });

  const queryDaily = useCallback(
    (days: number, endDate?: string): UaLossesRuModDailyRow[] => {
      if (!db) return [];
      const todayStr = getMskDateString();
      const end = endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate) ? endDate : todayStr;
      return queryRows<Record<string, unknown>>(
        db,
        `SELECT report_date AS date, ${COLS}
         FROM daily
         WHERE report_date >= ${windowStartSql(end, days)} AND report_date <= date('${end}')
         ORDER BY report_date ASC`,
      ).map((row) => {
        const out = { date: String(row.date), is_today: row.date === todayStr } as UaLossesRuModDailyRow;
        for (const k of KEYS) out[k] = typeof row[k] === "number" ? (row[k] as number) : null;
        return out;
      });
    },
    [db],
  );

  const queryGlobalStats = useCallback((): UaLossesRuModGlobalStats => {
    if (!db) return {} as UaLossesRuModGlobalStats;
    const rows = queryRows<Record<string, number | null>>(db, `SELECT ${COLS} FROM daily`);
    const result = {} as UaLossesRuModGlobalStats;
    for (const key of UA_LOSSES_RU_MOD_METRIC_KEYS) {
      const vals = rows.map((r) => r[key]).filter((v): v is number => typeof v === "number").sort((a, b) => a - b);
      result[key] = {
        max: vals.length ? vals[vals.length - 1] : 0,
        median: vals.length ? vals[Math.floor(vals.length / 2)] : 0,
        total: vals.reduce((s, n) => s + n, 0),
      };
    }
    return result;
  }, [db]);

  const queryMonthly = useCallback((): UaLossesRuModMonthlyRow[] => {
    if (!db) return [];
    const rows = queryRows<Record<string, number>>(
      db,
      `SELECT substr(report_date, 1, 7) AS month, ${KEYS.map((k) => `SUM(${k}) AS ${k}`).join(", ")}
       FROM daily GROUP BY month ORDER BY month ASC`,
    );
    const today = getMskDateString();
    const currentMonth = today.slice(0, 7);
    const projection = projectFromDays(
      currentMonth,
      today,
      queryRows<Record<string, number | null>>(
        db,
        `SELECT report_date AS date, ${UA_LOSSES_RU_MOD_METRIC_KEYS.join(", ")}
         FROM daily WHERE report_date >= '${currentMonth}-01'`,
      ).map((r) => ({ date: String(r.date), values: r as Partial<Record<UaLossesRuModMetricKey, number | null>> })),
      UA_LOSSES_RU_MOD_METRIC_KEYS,
    );

    return rows.map((row) => {
      const month = String(row.month);
      const p = month === currentMonth ? projection : null;
      const out = {
        date: month,
        is_current_month: month === currentMonth,
        projection_day: p?.completedDays ?? null,
        projection_days_in_month: p?.daysInMonth ?? null,
        projection_partial_day: p?.partialDay,
      } as UaLossesRuModMonthlyRow;
      for (const k of KEYS) out[k] = typeof row[k] === "number" ? row[k] : 0;
      for (const [k, v] of Object.entries(p?.projected ?? {})) {
        out[`${k as UaLossesRuModMetricKey}_projected`] = v;
      }
      return out;
    });
  }, [db]);

  const queryDataWindow = useCallback((): { minDate: string | null; maxDate: string | null } => {
    if (!db) return { minDate: null, maxDate: null };
    const rows = queryRows<{ minDate: string | null; maxDate: string | null }>(
      db,
      "SELECT MIN(report_date) AS minDate, MAX(report_date) AS maxDate FROM daily",
    );
    return rows[0] ?? { minDate: null, maxDate: null };
  }, [db]);

  return {
    loadState, error,
    queryDaily, queryGlobalStats, queryMonthly, queryDataWindow,
    refresh, lastRefreshed, refreshCount,
    refreshIntervalMs,
  };
}
