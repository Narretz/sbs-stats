import { useState, useEffect, useCallback, useRef } from "react";
import type { Database } from "sql.js";
import type { RuAdDailyRow, RuAdGlobalStats, RuAdMonthlyRow, RuAdStat, LoadState } from "@/types";

// Tiny DB → fetch whole via sql.js, like the SBS / RU-losses loaders (no httpvfs).
const DB_URL =
  import.meta.env.VITE_RU_MOD_DB_URL ?? `${import.meta.env.BASE_URL}data/ru-mod-ad.db`;
const SQL_JS_CDN = "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.12.0";
const SQL_WASM_URL = import.meta.env.DEV ? "/vendor/sql-wasm.wasm" : `${SQL_JS_CDN}/sql-wasm.wasm`;
const SQL_JS_URL = import.meta.env.DEV ? "/vendor/sql-wasm.js" : `${SQL_JS_CDN}/sql-wasm.js`;

// Report dates are MSK (the MoD's timezone). MSK is UTC+3 year-round.
function getMskDateString(): string {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Moscow" });
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
  if (!response.ok) throw new Error(`RU air-defense database not available at ${DB_URL} (HTTP ${response.status})`);
  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const MAGIC = "SQLite format 3\0";
  const head = String.fromCharCode(...bytes.slice(0, MAGIC.length));
  if (head !== MAGIC) {
    throw new Error(`RU air-defense database not available at ${DB_URL} (got ${bytes.byteLength} bytes that aren't a SQLite file — usually means the file is missing and the dev server returned index.html)`);
  }
  return new SQL.Database(bytes);
}

function getOrCreateDbPromise(): Promise<Database> {
  if (!dbPromise) dbPromise = loadDatabase();
  return dbPromise;
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

// `ad_reports` is append-only & versioned: an edited post yields a new row
// tagged with a later `scraped_at`. Every read goes through the latest version
// per post_id (mirrors the ru_losses LATEST_PER_DATE pattern). The DB also ships
// an `ad_latest` view doing the same; we inline it so the query is self-contained.
const LATEST_PER_POST = `(
  SELECT r.*
  FROM ad_reports r
  JOIN (SELECT post_id, MAX(scraped_at) AS ms FROM ad_reports GROUP BY post_id) l
    ON r.post_id = l.post_id AND r.scraped_at = l.ms
) latest`;

// Per drone-day aggregation, split by reporting window (overnight vs daytime).
// 'other'-kind reports fold into `day` so night + day == total.
const DAILY_SELECT = `
  SELECT report_date AS date,
         SUM(drones) AS total,
         SUM(CASE WHEN window_kind = 'night' THEN drones ELSE 0 END) AS night,
         SUM(CASE WHEN window_kind = 'night' THEN 0 ELSE drones END) AS day,
         COUNT(*) AS reports
  FROM ${LATEST_PER_POST}`;

const stat = (vals: number[]): RuAdStat => {
  const s = [...vals].filter((v) => typeof v === "number").sort((a, b) => a - b);
  return { max: s.length ? s[s.length - 1] : 0, median: s.length ? s[Math.floor(s.length / 2)] : 0 };
};

// MoD posts ~2–3×/day; hourly refresh is plenty.
export const REFRESH_INTERVAL_MS = 60 * 60 * 1000;

export function useDatabaseRuMod() {
  const [db, setDb] = useState<Database | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const lastRefreshedRef = useRef<Date | null>(null);
  const [refreshCount, setRefreshCount] = useState(0);

  const doLoad = useCallback(() => {
    setLoadState("loading");
    getOrCreateDbPromise()
      .then((database) => {
        setDb(database);
        setLoadState("ready");
        const now = new Date();
        setLastRefreshed(now);
        lastRefreshedRef.current = now;
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setLoadState("error");
        dbPromise = null;
      });
  }, []);

  const doRefresh = useCallback(() => {
    dbPromise = null;
    setDb(null);
    setRefreshCount((c) => c + 1);
    doLoad();
  }, [doLoad]);

  useEffect(() => { doLoad(); }, [doLoad]);

  useEffect(() => {
    const interval = setInterval(() => {
      if (document.hidden) return;
      doRefresh();
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [doRefresh]);

  useEffect(() => {
    const handle = () => {
      if (document.hidden) return;
      const age = lastRefreshedRef.current ? Date.now() - lastRefreshedRef.current.getTime() : Infinity;
      if (age >= REFRESH_INTERVAL_MS) doRefresh();
    };
    document.addEventListener("visibilitychange", handle);
    return () => document.removeEventListener("visibilitychange", handle);
  }, [doRefresh]);

  const refresh = useCallback(() => { doRefresh(); }, [doRefresh]);

  const queryDaily = useCallback(
    (days: number, endDate?: string): RuAdDailyRow[] => {
      if (!db) return [];
      const todayStr = getMskDateString();
      const endDateSql = endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate) ? endDate : todayStr;
      const sql = `${DAILY_SELECT}
        WHERE report_date >= date('${endDateSql}', '-${days} days')
          AND report_date <= date('${endDateSql}')
        GROUP BY report_date
        ORDER BY report_date ASC`;
      return queryRows<Record<string, number | string>>(db, sql).map((r) => ({
        date: String(r.date),
        is_today: String(r.date) === todayStr,
        total: typeof r.total === "number" ? r.total : null,
        night: typeof r.night === "number" ? r.night : null,
        day: typeof r.day === "number" ? r.day : null,
        reports: typeof r.reports === "number" ? r.reports : 0,
      }));
    },
    [db]
  );

  const queryGlobalStats = useCallback((): RuAdGlobalStats => {
    if (!db) return { total: { max: 0, median: 0 }, night: { max: 0, median: 0 }, day: { max: 0, median: 0 } };
    const rows = queryRows<Record<string, number>>(db, `${DAILY_SELECT} GROUP BY report_date`);
    return {
      total: stat(rows.map((r) => r.total)),
      night: stat(rows.map((r) => r.night)),
      day: stat(rows.map((r) => r.day)),
    };
  }, [db]);

  // ── Monthly: sum per month, split night/day, with current-month projection ────
  // `overlap_reports` counts rows whose `notes` flags a possible double-count
  // (overnight window overlapping a separate evening report) — surfaced as a
  // caveat in the monthly chart, not deducted (we can't verify the double-count).
  const queryMonthly = useCallback((): RuAdMonthlyRow[] => {
    if (!db) return [];
    const rows = queryRows<Record<string, number | string>>(
      db,
      `SELECT substr(report_date, 1, 7) AS month,
              SUM(drones) AS total,
              SUM(CASE WHEN window_kind = 'night' THEN drones ELSE 0 END) AS night,
              SUM(CASE WHEN window_kind = 'night' THEN 0 ELSE drones END) AS day,
              SUM(CASE WHEN notes IS NOT NULL THEN 1 ELSE 0 END) AS overlap_reports
       FROM ${LATEST_PER_POST}
       GROUP BY month
       ORDER BY month ASC`
    );

    const mskDateStr = getMskDateString();
    const currentMonth = mskDateStr.slice(0, 7);
    const dayOfMonth = parseInt(mskDateStr.slice(8, 10), 10);
    const [y, m] = currentMonth.split("-").map(Number);
    const daysInMonth = new Date(y, m, 0).getDate();

    return rows.map((r) => {
      const month = String(r.month);
      const isCurrent = month === currentMonth;
      const num = (k: string) => (typeof r[k] === "number" ? (r[k] as number) : 0);
      const out: RuAdMonthlyRow = {
        date: month,
        is_current_month: isCurrent,
        projection_day: isCurrent ? dayOfMonth : null,
        projection_days_in_month: isCurrent ? daysInMonth : null,
        total: num("total"),
        night: num("night"),
        day: num("day"),
        overlap_reports: num("overlap_reports"),
      };
      if (isCurrent && dayOfMonth > 0) {
        const mult = daysInMonth / dayOfMonth;
        out.total_projected = Math.round(out.total * mult);
        out.night_projected = Math.round(out.night * mult);
        out.day_projected = Math.round(out.day * mult);
      }
      return out;
    });
  }, [db]);

  // Full covered date range (first/last report day, MSK), for the "Data … – …"
  // freshness note in the page header.
  const queryDataWindow = useCallback((): { minDate: string | null; maxDate: string | null } => {
    if (!db) return { minDate: null, maxDate: null };
    const rows = queryRows<{ minDate: string | null; maxDate: string | null }>(
      db,
      "SELECT MIN(report_date) AS minDate, MAX(report_date) AS maxDate FROM ad_reports"
    );
    return rows[0] ?? { minDate: null, maxDate: null };
  }, [db]);

  return {
    loadState, error,
    queryDaily, queryGlobalStats, queryMonthly, queryDataWindow,
    refresh, lastRefreshed, refreshCount,
    refreshIntervalMs: REFRESH_INTERVAL_MS,
  };
}
