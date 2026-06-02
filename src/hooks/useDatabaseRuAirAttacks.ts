import { useCallback } from "react";
import type { Database } from "sql.js";
import type {
  RuAirAttacksDailyRow,
  RuAirAttacksGlobalStats,
  RuAirAttacksMonthlyRow,
  AttackCategoryKey,
} from "@/types";
import { ATTACK_CATEGORY_KEYS, ATTACK_DB_CATEGORIES } from "@/types";
import { makeResourceCache, useRefreshableResource } from "@/hooks/useRefreshableResource";

// Small DB (~2 MB) → fetch whole via sql.js, like the RU-losses loader (no httpvfs).
const DB_URL =
  import.meta.env.VITE_RU_AIR_ATTACKS_DB_URL ?? `${import.meta.env.BASE_URL}data/ru-air-attacks-gsua.db`;
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
  if (!response.ok) throw new Error(`RU air-attacks database not available at ${DB_URL} (HTTP ${response.status})`);
  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const MAGIC = "SQLite format 3\0";
  const head = String.fromCharCode(...bytes.slice(0, MAGIC.length));
  if (head !== MAGIC) {
    throw new Error(`RU air-attacks database not available at ${DB_URL} (got ${bytes.byteLength} bytes that aren't a SQLite file — usually means the file is missing and the dev server returned index.html)`);
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

type CategoryRow = { date: string; category: string; launched: number | null; destroyed: number | null };

function num(v: number | null | undefined): number {
  return typeof v === "number" ? v : 0;
}

// Pivot the long `daily_by_category` rows into one wide row per date with
// launched/intercepted for each category + a computed "all" (sum of every
// category, including the small "other" bucket that has no chart of its own).
function pivotDaily(raw: CategoryRow[], todayStr: string): RuAirAttacksDailyRow[] {
  const byDate = new Map<string, RuAirAttacksDailyRow>();
  for (const r of raw) {
    const date = String(r.date);
    let row = byDate.get(date);
    if (!row) {
      row = { date, is_today: date === todayStr } as RuAirAttacksDailyRow;
      for (const c of ATTACK_CATEGORY_KEYS) {
        row[`${c}_launched`] = 0;
        row[`${c}_intercepted`] = 0;
      }
      byDate.set(date, row);
    }
    const l = num(r.launched);
    const d = num(r.destroyed);
    row.all_launched = num(row.all_launched) + l;
    row.all_intercepted = num(row.all_intercepted) + d;
    const cat = String(r.category) as (typeof ATTACK_DB_CATEGORIES)[number];
    if ((ATTACK_DB_CATEGORIES as readonly string[]).includes(cat)) {
      row[`${cat}_launched`] = num(row[`${cat}_launched`]) + l;
      row[`${cat}_intercepted`] = num(row[`${cat}_intercepted`]) + d;
    }
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function maxMedian(values: Array<number | null>): { max: number; median: number } {
  const vals = values.filter((v): v is number => typeof v === "number").sort((a, b) => a - b);
  return {
    max: vals.length ? vals[vals.length - 1] : 0,
    median: vals.length ? vals[Math.floor(vals.length / 2)] : 0,
  };
}

// piterfm re-publishes the Kaggle dataset roughly weekly; hourly polling is plenty.
export const REFRESH_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export function useDatabaseRuAirAttacks() {
  const { resource: db, loadState, error, lastRefreshed, refresh, refreshCount, refreshIntervalMs } =
    useRefreshableResource({
      cache: dbCache,
      load: loadDatabase,
      refreshIntervalMs: REFRESH_INTERVAL_MS,
    });

  // ── Daily: launched + intercepted per category, attributed to time_start date ─
  const queryDaily = useCallback(
    (days: number, endDate?: string): RuAirAttacksDailyRow[] => {
      if (!db) return [];
      const todayStr = getKyivDateString();
      const endDateSql = endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate) ? endDate : todayStr;
      const sql = `
        SELECT date, category, launched, destroyed
        FROM daily_by_category
        WHERE date >= date('${endDateSql}', '-${days} days')
          AND date <= date('${endDateSql}')
        ORDER BY date ASC
      `;
      return pivotDaily(queryRows<CategoryRow>(db, sql), todayStr);
    },
    [db]
  );

  // ── Global stats: max + median per category/metric across ALL days ────────────
  const queryGlobalStats = useCallback((): RuAirAttacksGlobalStats => {
    if (!db) return {} as RuAirAttacksGlobalStats;
    const all = pivotDaily(
      queryRows<CategoryRow>(db, `SELECT date, category, launched, destroyed FROM daily_by_category`),
      ""
    );
    const result = {} as RuAirAttacksGlobalStats;
    for (const c of ATTACK_CATEGORY_KEYS) {
      result[c] = {
        launched: maxMedian(all.map((r) => r[`${c}_launched`])),
        intercepted: maxMedian(all.map((r) => r[`${c}_intercepted`])),
      };
    }
    return result;
  }, [db]);

  // ── Monthly: launched + intercepted sums per category, with current-month
  // projection on both. Bare key holds launched (legacy); `*_intercepted` holds
  // the destroyed sum so the page can render side-by-side bars + a % rate.
  const queryMonthly = useCallback((): RuAirAttacksMonthlyRow[] => {
    if (!db) return [];
    const raw = queryRows<{ month: string; category: string; launched: number | null; destroyed: number | null }>(
      db,
      `SELECT substr(date, 1, 7) AS month, category,
              SUM(launched) AS launched, SUM(destroyed) AS destroyed
       FROM daily_by_category
       GROUP BY month, category
       ORDER BY month ASC`
    );

    const byMonth = new Map<string, RuAirAttacksMonthlyRow>();
    for (const r of raw) {
      const month = String(r.month);
      let row = byMonth.get(month);
      if (!row) {
        row = {
          date: month, is_current_month: false,
          projection_day: null, projection_days_in_month: null,
        } as RuAirAttacksMonthlyRow;
        for (const c of ATTACK_CATEGORY_KEYS) {
          row[c] = 0;
          row[`${c}_intercepted`] = 0;
        }
        byMonth.set(month, row);
      }
      const l = num(r.launched);
      const d = num(r.destroyed);
      row.all = (row.all as number) + l;
      row.all_intercepted = (row.all_intercepted as number) + d;
      const cat = String(r.category) as (typeof ATTACK_DB_CATEGORIES)[number];
      if ((ATTACK_DB_CATEGORIES as readonly string[]).includes(cat)) {
        row[cat] = (row[cat] as number) + l;
        row[`${cat}_intercepted`] = (row[`${cat}_intercepted`] as number) + d;
      }
    }

    const kyivDateStr = getKyivDateString();
    const currentMonth = kyivDateStr.slice(0, 7);
    const dayOfMonth = parseInt(kyivDateStr.slice(8, 10), 10);
    const [y, m] = currentMonth.split("-").map(Number);
    const daysInMonth = new Date(y, m, 0).getDate();

    return [...byMonth.values()]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((row) => {
        const isCurrent = row.date === currentMonth;
        row.is_current_month = isCurrent;
        row.projection_day = isCurrent ? dayOfMonth : null;
        row.projection_days_in_month = isCurrent ? daysInMonth : null;
        if (isCurrent && dayOfMonth > 0) {
          const mult = daysInMonth / dayOfMonth;
          for (const c of ATTACK_CATEGORY_KEYS) {
            row[`${c}_projected` as `${AttackCategoryKey}_projected`] = Math.round((row[c] as number) * mult);
            row[`${c}_intercepted_projected` as `${AttackCategoryKey}_intercepted_projected`] =
              Math.round((row[`${c}_intercepted`] as number) * mult);
          }
        }
        return row;
      });
  }, [db]);

  // Full covered date range (first/last day), for the "Data … – …" freshness
  // note in the page header.
  const queryDataWindow = useCallback((): { minDate: string | null; maxDate: string | null } => {
    if (!db) return { minDate: null, maxDate: null };
    const rows = queryRows<{ minDate: string | null; maxDate: string | null }>(
      db,
      "SELECT MIN(date) AS minDate, MAX(date) AS maxDate FROM daily_by_category"
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
