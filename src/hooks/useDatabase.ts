import { useCallback } from "react";
import type { Database } from "sql.js";
import type { DailyRow, MonthlyRow, StatKey, EodEstimate } from "@/types";
import { TARGET_IDS } from "@/types";
import { computeEodProjection, type EodReading } from "@/utils/eodProjection";
import { makeResourceCache, useRefreshableResource } from "@/hooks/useRefreshableResource";

const DB_URL = import.meta.env.VITE_DB_URL ?? "/data/sbs.db";
const SQL_JS_CDN = "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.12.0";
const SQL_WASM_URL = import.meta.env.DEV ? "/vendor/sql-wasm.wasm" : `${SQL_JS_CDN}/sql-wasm.wasm`;
const SQL_JS_URL = import.meta.env.DEV ? "/vendor/sql-wasm.js" : `${SQL_JS_CDN}/sql-wasm.js`;

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
  if (!response.ok) throw new Error(`SBS database not available at ${DB_URL} (HTTP ${response.status})`);
  const buffer = await response.arrayBuffer();
  // SPA fallbacks can return index.html for missing routes — validate the
  // SQLite magic header before handing bytes to sql.js for a clear error.
  const bytes = new Uint8Array(buffer);
  const MAGIC = "SQLite format 3\0";
  const head = String.fromCharCode(...bytes.slice(0, MAGIC.length));
  if (head !== MAGIC) {
    throw new Error(`SBS database not available at ${DB_URL} (got ${bytes.byteLength} bytes that aren't a SQLite file — usually means the file is missing and the dev server returned index.html)`);
  }
  return new SQL.Database(bytes);
}

const dbCache = makeResourceCache<Database>();

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
    "flights_strike",
    "flights_recon",
  ];
  const dynamicCols = TARGET_IDS.flatMap((id) => [
    `hit_${id}` as StatKey,
    `destroyed_${id}` as StatKey,
  ]);
  return [...baseCols, ...dynamicCols]
    .map((col) => {
      if (col === "flights_strike" || col === "flights_recon") {
        return availableCols.includes(col) ? `${col} AS ${col}` : `NULL AS ${col}`;
      }
      return availableCols.includes(col)
        ? `COALESCE(${col}, 0) AS ${col}`
        : `0 AS ${col}`;
    })
    .join(", ");
}

export const REFRESH_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

export function useDatabase() {
  const { resource: db, loadState, error, lastRefreshed, refresh, refreshCount, refreshIntervalMs } =
    useRefreshableResource({
      cache: dbCache,
      load: loadDatabase,
      refreshIntervalMs: REFRESH_INTERVAL_MS,
    });

  // ── Daily: one row per date (latest hour) ────────────────────────────────────
  const queryDaily = useCallback(
    (days: number, endDate?: string): DailyRow[] => {
      if (!db) return [];
      const availableCols = getTableColumns(db, "daily_stats");
      const statCols = buildStatColumns(availableCols);
      const todayStr = getKyivDateString();
      const endDateSql = endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate) ? endDate : todayStr;

      const sql = `
        SELECT
          date,
          hour,
          CASE WHEN date = '${todayStr}' THEN 1 ELSE 0 END AS is_today,
          ${statCols}
        FROM daily_stats
        WHERE date >= date('${endDateSql}', '-${days} days')
          AND date <= date('${endDateSql}')
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
    (days: number, endDate?: string): DailyRow[] => {
      if (!db) return [];
      const availableCols = getTableColumns(db, "daily_stats");
      const statCols = buildStatColumns(availableCols);
      const todayStr = getKyivDateString();
      const endDateSql = endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate) ? endDate : todayStr;

      const sql = `
        SELECT
          date,
          hour,
          CASE WHEN date = '${todayStr}' THEN 1 ELSE 0 END AS is_today,
          ${statCols}
        FROM daily_stats
        WHERE date >= date('${endDateSql}', '-${days} days')
          AND date <= date('${endDateSql}')
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
      "flights_strike", "flights_recon",
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

  // ── End-of-day projection for today ──────────────────────────────────────────
  // Today's daily value is only a partial running total (latest hour so far);
  // project where it settles from the last 90 days' intraday curves. Readings are
  // keyed by hour; the day-final is the max-hour value (incl. next-day revisions).
  const queryEodProjection = useCallback((): Partial<Record<StatKey, EodEstimate>> => {
    if (!db) return {};
    const todayStr = getKyivDateString();
    const availableCols = getTableColumns(db, "daily_stats");
    const allKeys: StatKey[] = [
      "personnel_killed", "personnel_wounded",
      "total_targets_hit", "total_targets_destroyed",
      "total_personnel_casualties", "flights_strike", "flights_recon",
      ...TARGET_IDS.flatMap((id) => [`hit_${id}` as StatKey, `destroyed_${id}` as StatKey]),
    ];
    const keys = allKeys.filter((k) => availableCols.includes(k));
    if (!keys.length) return {};

    const statCols = keys.map((k) => `COALESCE(${k}, 0) AS ${k}`).join(", ");
    const sql = `
      SELECT date, hour, ${statCols}
      FROM daily_stats
      WHERE date >= date('${todayStr}', '-90 days')
      ORDER BY date ASC, hour ASC
    `;
    const byDate = new Map<string, EodReading<StatKey>[]>();
    for (const r of queryRows<Record<string, number>>(db, sql)) {
      const d = String(r.date);
      const hour = Number(r.hour);
      if (!byDate.has(d)) byDate.set(d, []);
      byDate.get(d)!.push({
        bucket: String(hour),
        asOf: `${String(hour).padStart(2, "0")}:00`,
        values: r as Record<StatKey, number>,
      });
    }
    return computeEodProjection(byDate, todayStr, keys);
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
      SELECT m.date, ${statCols}
      FROM monthly_stats m
      INNER JOIN (
        SELECT date, MAX(data_collected_at) AS latest
        FROM monthly_stats
        GROUP BY date
      ) latest ON m.date = latest.date AND m.data_collected_at = latest.latest
      ORDER BY m.date ASC
    `;

    return queryRows<Record<string, unknown>>(db, sql).map((row) => {
      const dateStr = String(row["date"]).slice(0, 7);
      const isCurrentMonth = dateStr === currentMonth;

      const typedRow: MonthlyRow = {
        date: dateStr,
        is_current_month: isCurrentMonth,
        projection_day: isCurrentMonth ? dayOfMonth : null,
        projection_days_in_month: isCurrentMonth ? daysInMonth : null,
        ...(row as unknown as Record<StatKey, number>),
      };

      if (isCurrentMonth) {
        const multiplier = daysInMonth / dayOfMonth;
        const statKeys: StatKey[] = [
          "personnel_killed", "personnel_wounded",
          "total_targets_hit", "total_targets_destroyed",
          "total_personnel_casualties",
          "flights_strike", "flights_recon",
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

  // Full covered date range (first/last day), for the "Data … – …" freshness
  // note in the page header.
  const queryDataWindow = useCallback((): { minDate: string | null; maxDate: string | null } => {
    if (!db) return { minDate: null, maxDate: null };
    const rows = queryRows<{ minDate: string | null; maxDate: string | null }>(
      db,
      "SELECT MIN(date) AS minDate, MAX(date) AS maxDate FROM daily_stats"
    );
    return rows[0] ?? { minDate: null, maxDate: null };
  }, [db]);

  return {
    loadState, error,
    queryDaily, queryHourly, queryMonthly, queryGlobalStats, queryEodProjection, queryDataWindow,
    refresh, lastRefreshed, refreshCount,
    refreshIntervalMs,
  };
}
