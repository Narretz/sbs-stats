import { useCallback } from "react";
import type { Database } from "sql.js";
import type {
  RuAirAttacksDailyRow,
  RuAirAttacksGlobalStats,
  RuAirAttacksMonthlyRow,
  RuAirAttacksModelDailyRow,
  RuAirAttacksModelMonthlyRow,
  AttackDbCategory,
  ModelBreakdownEntry,
} from "@/types";
import { makeResourceCache, useRefreshableResource } from "@/hooks/useRefreshableResource";
import { loadWholeDb } from "@/hooks/sqlLoader";
import type { AirAttackRow } from "@/utils/sources";
import * as q from "@/data/ruAirAttacksDb";

// The RU air-attacks dataset: loading and refreshing the DB. What is read off
// it — the views installed on load and every query — is data/ruAirAttacksDb.ts.

// Small DB (~2 MB) → fetch whole via sql.js, like the RU-losses loader (no httpvfs).
const DB_URL =
  import.meta.env.VITE_RU_AIR_ATTACKS_DB_URL ?? `${import.meta.env.BASE_URL}data/ru-air-attacks-gsua.db`;

async function loadDatabase(): Promise<Database> {
  const db = await loadWholeDb(DB_URL, "RU air-attacks");
  q.installDisclosureAwareViews(db);
  return db;
}

const dbCache = makeResourceCache<Database>();

export const REFRESH_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export function useDatabaseRuAirAttacks({ enabled = true }: { enabled?: boolean } = {}) {
  const { resource: db, loadState, error, lastRefreshed, refresh, refreshCount, refreshIntervalMs } =
    useRefreshableResource({
      cache: dbCache,
      load: loadDatabase,
      refreshIntervalMs: REFRESH_INTERVAL_MS,
      enabled,
    });

  const queryDaily = useCallback(
    (days: number, endDate?: string): RuAirAttacksDailyRow[] => (db ? q.queryDaily(db, days, endDate) : []),
    [db],
  );

  const queryGlobalStats = useCallback(
    (): RuAirAttacksGlobalStats => (db ? q.queryGlobalStats(db) : {} as RuAirAttacksGlobalStats),
    [db],
  );

  const queryMonthly = useCallback(
    (): RuAirAttacksMonthlyRow[] => (db ? q.queryMonthly(db) : []),
    [db],
  );

  const queryDailyByModel = useCallback(
    (model: string, days: number, endDate?: string): RuAirAttacksModelDailyRow[] => (db ? q.queryDailyByModel(db, model, days, endDate) : []),
    [db],
  );

  const queryMonthlyByModel = useCallback(
    (model: string): RuAirAttacksModelMonthlyRow[] => (db ? q.queryMonthlyByModel(db, model) : []),
    [db],
  );

  const queryDailyBreakdownByCategory = useCallback(
    (cat: AttackDbCategory, days: number, endDate?: string): Map<string, ModelBreakdownEntry[]> => (db ? q.queryDailyBreakdownByCategory(db, cat, days, endDate) : new Map()),
    [db],
  );

  const queryDailyAggBreakdown = useCallback(
    (days: number, endDate?: string): Map<string, ModelBreakdownEntry[]> => (db ? q.queryDailyAggBreakdown(db, days, endDate) : new Map()),
    [db],
  );

  const queryMonthlyAggBreakdown = useCallback(
    (): Map<string, ModelBreakdownEntry[]> => (db ? q.queryMonthlyAggBreakdown(db) : new Map()),
    [db],
  );

  const queryMonthlyBreakdownByCategory = useCallback(
    (cat: AttackDbCategory): Map<string, ModelBreakdownEntry[]> => (db ? q.queryMonthlyBreakdownByCategory(db, cat) : new Map()),
    [db],
  );

  const queryDataWindow = useCallback(
    (): { minDate: string | null; maxDate: string | null } => (db ? q.queryDataWindow(db) : { minDate: null, maxDate: null }),
    [db],
  );


  const querySourceRows = useCallback(
    (days: number, endDate?: string): AirAttackRow[] => (db ? q.querySourceRows(db, days, endDate) : []),
    [db],
  );
  return {
    loadState, error,
    queryDaily, queryGlobalStats, queryMonthly, querySourceRows,
    queryDailyByModel, queryMonthlyByModel,
    queryDailyBreakdownByCategory, queryMonthlyBreakdownByCategory,
    queryDailyAggBreakdown, queryMonthlyAggBreakdown,
    queryDataWindow,
    refresh, lastRefreshed, refreshCount,
    refreshIntervalMs,
  };
}
