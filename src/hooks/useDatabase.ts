import { useState, useEffect, useCallback } from "react";
import type { Database } from "sql.js";
import type { DailyRow, MonthlyRow, StatKey, LoadState } from "@/types";
import { TARGET_IDS } from "@/types";

const DB_URL = import.meta.env.VITE_DB_URL ?? "/data/sbs.db";
const SQL_WASM_URL = "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.12.0/sql-wasm.wasm";

// Returns today's date string (YYYY-MM-DD) in Kyiv local time
function getKyivDateString(): string {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });
}

function loadSqlJsScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if ((window as unknown as Record<string, unknown>)["initSqlJs"]) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.12.0/sql-wasm.js";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load sql.js script"));
    document.head.appendChild(script);
  });
}

let dbPromise: Promise<Database> | null = null;

async function loadDatabase(): Promise<Database> {
  await loadSqlJsScript();

  const wasmResponse = await fetch(SQL_WASM_URL);
  if (!wasmResponse.ok) throw new Error(`Failed to fetch sql-wasm.wasm: ${wasmResponse.status}`);
  const wasmBinary = await wasmResponse.arrayBuffer();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const initSqlJs = (window as any)["initSqlJs"] as (config: {
    wasmBinary: ArrayBuffer;
  }) => Promise<{ Database: new (data: Uint8Array) => Database }>;

  const SQL = await initSqlJs({ wasmBinary });

  const response = await fetch(DB_URL + `?bust=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Failed to fetch DB: ${response.status}`);
  const buffer = await response.arrayBuffer();
  return new SQL.Database(new Uint8Array(buffer));
}

function getOrCreateDbPromise(): Promise<Database> {
  if (!dbPromise) dbPromise = loadDatabase();
  return dbPromise;
}

function getTableColumns(db: Database, table: string): string[] {
  const result = db.exec(`PRAGMA table_info(${table})`);
  if (!result.length) return [];
  return result[0].values.map((row) => row[1] as string);
}

function queryRows<T>(db: Database, sql: string): T[] {
  const results = db.exec(sql);
  if (!results.length) return [];
  const { columns, values } = results[0];
  return values.map((row) => {
    const obj: Record<string, unknown> = {};
    columns.forEach((col, i) => (obj[col] = row[i]));
    return obj as T;
  });
}

function buildStatColumns(availableCols: string[]): string {
  const baseCols: StatKey[] = [
    "personnel_killed",
    "personnel_wounded",
    "total_targets_hit",
    "total_targets_destroyed",
    "total_personnel_casualties",
  ];
  const dynamicCols = TARGET_IDS.flatMap((id) => [
    `hit_${id}` as StatKey,
    `destroyed_${id}` as StatKey,
  ]);
  return [...baseCols, ...dynamicCols]
    .map((col) =>
      availableCols.includes(col)
        ? `COALESCE(${col}, 0) AS ${col}`
        : `0 AS ${col}`
    )
    .join(", ");
}

export const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 10 minutes

export function useDatabase() {
  const [db, setDb] = useState<Database | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [refreshCount, setRefreshCount] = useState(0);

  const doLoad = useCallback(() => {
    setLoadState("loading");
    getOrCreateDbPromise()
      .then((database) => {
        setDb(database);
        setLoadState("ready");
        setLastRefreshed(new Date());
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setLoadState("error");
        dbPromise = null;
      });
  }, []);

  // Initial load
  useEffect(() => {
    doLoad();
  }, [doLoad]);

  // Auto-refresh every REFRESH_INTERVAL_MS
  useEffect(() => {
    const interval = setInterval(() => {
      dbPromise = null; // Force re-fetch from network
      setDb(null);
      setRefreshCount((c) => c + 1);
      doLoad();
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [doLoad]);

  // Manual refresh
  const refresh = useCallback(() => {
    dbPromise = null;
    setDb(null);
    setRefreshCount((c) => c + 1);
    doLoad();
  }, [doLoad]);

  // ── Daily: one row per date (latest hour) ────────────────────────────────────
  const queryDaily = useCallback(
    (days: number): DailyRow[] => {
      if (!db) return [];
      const availableCols = getTableColumns(db, "daily_stats");
      const statCols = buildStatColumns(availableCols);
      const todayStr = getKyivDateString();

      const sql = `
        SELECT
          date,
          hour,
          CASE WHEN date = '${todayStr}' THEN 1 ELSE 0 END AS is_today,
          ${statCols}
        FROM daily_stats
        WHERE date >= date('${todayStr}', '-${days} days')
        ORDER BY date ASC, hour DESC
      `;

      // One row per date: keep only the latest hour
      const seen = new Set<string>();
      const result: DailyRow[] = [];
      for (const row of queryRows<DailyRow>(db, sql)) {
        if (!seen.has(row.date)) {
          seen.add(row.date);
          result.push({ ...row, is_today: (row.is_today as unknown) === 1 });
        }
      }
      return result;
    },
    [db]
  );

  // ── Hourly: ALL rows (every hour × every date) ───────────────────────────────
  const queryHourly = useCallback(
    (days: number): DailyRow[] => {
      if (!db) return [];
      const availableCols = getTableColumns(db, "daily_stats");
      const statCols = buildStatColumns(availableCols);
      const todayStr = getKyivDateString();

      const sql = `
        SELECT
          date,
          hour,
          CASE WHEN date = '${todayStr}' THEN 1 ELSE 0 END AS is_today,
          ${statCols}
        FROM daily_stats
        WHERE date >= date('${todayStr}', '-${days} days')
          AND hour < 24
        ORDER BY date ASC, hour ASC
      `;

      return queryRows<DailyRow>(db, sql).map((row) => {
        return {
          ...row,
          is_today: (row.is_today as unknown) === 1,
        }
      });
    },
    [db]
  );

  // ── Global stats: max + median across ALL daily_stats (ignores day range) ────
  const queryGlobalStats = useCallback((): Record<StatKey, { max: number; median: number }> => {
    if (!db) return {} as Record<StatKey, { max: number; median: number }>;

    const availableCols = getTableColumns(db, "daily_stats");
    const allStatKeys: StatKey[] = [
      "personnel_killed", "personnel_wounded",
      "total_targets_hit", "total_targets_destroyed",
      "total_personnel_casualties",
      ...TARGET_IDS.flatMap((id) => [`hit_${id}` as StatKey, `destroyed_${id}` as StatKey]),
    ];

    // Fetch latest-hour row per date for all time (same logic as queryDaily but no date filter)
    const statCols = allStatKeys
      .map((col) => availableCols.includes(col) ? `COALESCE(${col}, 0) AS ${col}` : `0 AS ${col}`)
      .join(", ");

    const sql = `
      SELECT date, hour, ${statCols}
      FROM daily_stats
      ORDER BY date ASC, hour DESC
    `;

    // Deduplicate to latest hour per date
    const seen = new Set<string>();
    const rows: Record<string, number>[] = [];
    for (const row of queryRows<Record<string, number>>(db, sql)) {
      const d = String(row["date"]);
      if (!seen.has(d)) { seen.add(d); rows.push(row); }
    }

    const result = {} as Record<StatKey, { max: number; median: number }>;
    for (const key of allStatKeys) {
      const vals = rows.map((r) => (r[key] as number) ?? 0).sort((a, b) => a - b);
      result[key] = {
        max: vals.length ? Math.max(...vals) : 0,
        median: vals.length ? vals[Math.floor(vals.length / 2)] : 0,
      };
    }
    return result;
  }, [db]);

  // ── Monthly ──────────────────────────────────────────────────────────────────
  const queryMonthly = useCallback((): MonthlyRow[] => {
    if (!db) return [];
    const availableCols = getTableColumns(db, "monthly_stats");
    const statCols = buildStatColumns(availableCols);
    const kyivDateStr = getKyivDateString();               // YYYY-MM-DD in Kyiv time
    const currentMonth = kyivDateStr.slice(0, 7);          // YYYY-MM
    const dayOfMonth = parseInt(kyivDateStr.slice(8, 10)); // DD
    const [y, m] = currentMonth.split("-").map(Number);
    const daysInMonth = new Date(y, m, 0).getDate();

    const sql = `
      SELECT date, ${statCols}
      FROM monthly_stats
      ORDER BY date ASC
    `;

    return queryRows<Record<string, unknown>>(db, sql).map((row) => {
      const dateStr = String(row["date"]).slice(0, 7);
      const isCurrentMonth = dateStr === currentMonth;

      const typedRow: MonthlyRow = {
        date: dateStr,
        is_current_month: isCurrentMonth,
        projection_day: isCurrentMonth ? dayOfMonth : null,
        projection_days_in_month: isCurrentMonth ? daysInMonth : null,
        ...(row as Record<string, number>),
      };

      if (isCurrentMonth) {
        const multiplier = daysInMonth / dayOfMonth;
        const statKeys: StatKey[] = [
          "personnel_killed", "personnel_wounded",
          "total_targets_hit", "total_targets_destroyed",
          "total_personnel_casualties",
          ...TARGET_IDS.flatMap((id) => [`hit_${id}` as StatKey, `destroyed_${id}` as StatKey]),
        ];
        for (const key of statKeys) {
          const raw = row[key];
          if (typeof raw === "number") {
            typedRow[`${key}_projected`] = Math.round(raw * multiplier);
          }
        }
      }
      return typedRow;
    });
  }, [db]);

  return {
    loadState, error,
    queryDaily, queryHourly, queryMonthly, queryGlobalStats,
    refresh, lastRefreshed, refreshCount,
  };
}
