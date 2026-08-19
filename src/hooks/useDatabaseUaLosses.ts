import { useCallback } from "react";
import type { Database } from "sql.js";
import type {
  UaLossesDailyRow,
  UaLossesGlobalStats,
  UaLossesMetricKey,
  UaLossesMonthlyRow,
} from "@/types";
import { UA_LOSSES_METRIC_KEYS } from "@/types";
import { makeResourceCache, useRefreshableResource } from "@/hooks/useRefreshableResource";
import { windowStartSql } from "@/utils/dayRange";

// Tiny DB (~180 KB) → fetch whole via sql.js, like the RU-losses / SBS loaders.
const DB_URL =
  import.meta.env.VITE_UA_LOSSES_DB_URL ??
  `${import.meta.env.BASE_URL}data/ua-losses.db`;
const SQL_JS_CDN = "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.12.0";
const SQL_WASM_URL = import.meta.env.DEV ? "/vendor/sql-wasm.wasm" : `${SQL_JS_CDN}/sql-wasm.wasm`;
const SQL_JS_URL = import.meta.env.DEV ? "/vendor/sql-wasm.js" : `${SQL_JS_CDN}/sql-wasm.js`;

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
    script.src = SQL_JS_URL;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load sql.js script"));
    document.head.appendChild(script);
  });
}

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
  if (!response.ok) throw new Error(`UA losses database not available at ${DB_URL} (HTTP ${response.status})`);
  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const MAGIC = "SQLite format 3\0";
  const head = String.fromCharCode(...bytes.slice(0, MAGIC.length));
  if (head !== MAGIC) {
    throw new Error(`UA losses database not available at ${DB_URL} (got ${bytes.byteLength} bytes that aren't a SQLite file — usually means the file is missing and the dev server returned index.html)`);
  }
  return new SQL.Database(bytes);
}

const dbCache = makeResourceCache<Database>();

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

const METRIC_COLS = UA_LOSSES_METRIC_KEYS.join(", ");

// `daily_losses` is append-only: a date can have several snapshot rows (one per
// version of ualosses' numbers, which revise upward over time). Every read goes
// through this derived table, which keeps only the latest `scraped_at` per date.
const LATEST_PER_DATE = `(
  SELECT d.*
  FROM daily_losses d
  JOIN (SELECT date, MAX(scraped_at) AS ms FROM daily_losses GROUP BY date) l
    ON d.date = l.date AND d.scraped_at = l.ms
) latest`;

export const REFRESH_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export function useDatabaseUaLosses({ enabled = true }: { enabled?: boolean } = {}) {
  const { resource: db, loadState, error, lastRefreshed, refresh, refreshCount, refreshIntervalMs } =
    useRefreshableResource({
      cache: dbCache,
      load: loadDatabase,
      refreshIntervalMs: REFRESH_INTERVAL_MS,
      enabled,
    });

  // ── Daily: latest snapshot per date ───────────────────────────────────────────
  const queryDaily = useCallback(
    (days: number, endDate?: string): UaLossesDailyRow[] => {
      if (!db) return [];
      const todayStr = getKyivDateString();
      const endDateSql = endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate) ? endDate : todayStr;
      const sql = `
        SELECT date, ${METRIC_COLS},
               CASE WHEN date = '${todayStr}' THEN 1 ELSE 0 END AS is_today
        FROM ${LATEST_PER_DATE}
        WHERE date >= ${windowStartSql(endDateSql, days)}
          AND date <= date('${endDateSql}')
        ORDER BY date ASC
      `;
      return queryRows<Record<string, unknown>>(db, sql).map((row) => ({
        date: String(row.date),
        is_today: (row.is_today as unknown) === 1,
        ...(UA_LOSSES_METRIC_KEYS.reduce((acc, k) => {
          acc[k] = typeof row[k] === "number" ? (row[k] as number) : null;
          return acc;
        }, {} as Record<UaLossesMetricKey, number | null>)),
      }) as UaLossesDailyRow);
    },
    [db]
  );

  // ── Global stats: max + median + total per metric across ALL days ─────────────
  const queryGlobalStats = useCallback((): UaLossesGlobalStats => {
    if (!db) return {} as UaLossesGlobalStats;
    const rows = queryRows<Record<string, number>>(
      db,
      `SELECT ${METRIC_COLS} FROM ${LATEST_PER_DATE}`
    );
    const result = {} as UaLossesGlobalStats;
    for (const key of UA_LOSSES_METRIC_KEYS) {
      const vals = rows
        .map((r) => r[key])
        .filter((v): v is number => typeof v === "number")
        .sort((a, b) => a - b);
      result[key] = {
        max: vals.length ? vals[vals.length - 1] : 0,
        median: vals.length ? vals[Math.floor(vals.length / 2)] : 0,
        total: vals.reduce((s, n) => s + n, 0),
      };
    }
    return result;
  }, [db]);

  // ── Monthly: sum of daily counts per month, with current-month projection ─────
  const queryMonthly = useCallback((): UaLossesMonthlyRow[] => {
    if (!db) return [];
    const rows = queryRows<Record<string, number>>(
      db,
      `SELECT substr(date, 1, 7) AS month, ${UA_LOSSES_METRIC_KEYS.map((k) => `SUM(${k}) AS ${k}`).join(", ")}
       FROM ${LATEST_PER_DATE}
       GROUP BY month
       ORDER BY month ASC`
    );

    const kyivDateStr = getKyivDateString();
    const currentMonth = kyivDateStr.slice(0, 7);
    const dayOfMonth = parseInt(kyivDateStr.slice(8, 10), 10);
    const [y, m] = currentMonth.split("-").map(Number);
    const daysInMonth = new Date(y, m, 0).getDate();

    return rows.map((row) => {
      const month = String(row.month);
      const isCurrent = month === currentMonth;
      const out: UaLossesMonthlyRow = {
        date: month,
        is_current_month: isCurrent,
        projection_day: isCurrent ? dayOfMonth : null,
        projection_days_in_month: isCurrent ? daysInMonth : null,
        ...(UA_LOSSES_METRIC_KEYS.reduce((acc, k) => {
          acc[k] = typeof row[k] === "number" ? row[k] : 0;
          return acc;
        }, {} as Record<UaLossesMetricKey, number>)),
      } as UaLossesMonthlyRow;
      if (isCurrent && dayOfMonth > 0) {
        const mult = daysInMonth / dayOfMonth;
        for (const k of UA_LOSSES_METRIC_KEYS) {
          out[`${k}_projected`] = Math.round((out[k] as number) * mult);
        }
      }
      return out;
    });
  }, [db]);

  // Full covered date range (first/last day across all snapshots), for a
  // freshness note.
  const queryDataWindow = useCallback((): { minDate: string | null; maxDate: string | null } => {
    if (!db) return { minDate: null, maxDate: null };
    const rows = queryRows<{ minDate: string | null; maxDate: string | null }>(
      db,
      "SELECT MIN(date) AS minDate, MAX(date) AS maxDate FROM daily_losses"
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
