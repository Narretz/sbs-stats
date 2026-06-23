import { useCallback } from "react";
import type { Database } from "sql.js";
import type { RuAdDailyRow, RuAdGlobalStats, RuAdMonthlyRow, RuAdStat } from "@/types";
import { makeResourceCache, useRefreshableResource } from "@/hooks/useRefreshableResource";
import { windowStartSql } from "@/utils/dayRange";

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
// 'other'-kind reports fold into `day` so night + day == total. Overlap notes
// concatenate per series so the daily tooltip can say *which* report windows
// overlap — preferred over a bare count when explaining the caveat. Each line
// is prefixed with the report's HH:MM→HH:MM window for context.
const DAILY_SELECT = `
  SELECT report_date AS date,
         SUM(drones) AS total,
         SUM(CASE WHEN window_kind = 'night' THEN drones ELSE 0 END) AS night,
         SUM(CASE WHEN window_kind = 'night' THEN 0 ELSE drones END) AS day,
         COUNT(*) AS reports,
         SUM(CASE WHEN notes IS NOT NULL THEN 1 ELSE 0 END) AS overlap_total,
         SUM(CASE WHEN notes IS NOT NULL AND window_kind = 'night' THEN 1 ELSE 0 END) AS overlap_night,
         SUM(CASE WHEN notes IS NOT NULL AND window_kind != 'night' THEN 1 ELSE 0 END) AS overlap_day,
         GROUP_CONCAT(
           CASE WHEN notes IS NOT NULL
                THEN substr(window_start, 12, 5) || '→' || substr(window_end, 12, 5) || ': ' || notes
           END, char(10)) AS overlap_note_total,
         GROUP_CONCAT(
           CASE WHEN notes IS NOT NULL AND window_kind = 'night'
                THEN substr(window_start, 12, 5) || '→' || substr(window_end, 12, 5) || ': ' || notes
           END, char(10)) AS overlap_note_night,
         GROUP_CONCAT(
           CASE WHEN notes IS NOT NULL AND window_kind != 'night'
                THEN substr(window_start, 12, 5) || '→' || substr(window_end, 12, 5) || ': ' || notes
           END, char(10)) AS overlap_note_day
  FROM ${LATEST_PER_POST}`;

const stat = (vals: number[]): RuAdStat => {
  const s = [...vals].filter((v) => typeof v === "number").sort((a, b) => a - b);
  return {
    max: s.length ? s[s.length - 1] : 0,
    median: s.length ? s[Math.floor(s.length / 2)] : 0,
    total: s.reduce((acc, n) => acc + n, 0),
  };
};

// MoD posts ~2–3×/day; hourly refresh is plenty.
export const REFRESH_INTERVAL_MS = 60 * 60 * 1000;

export function useDatabaseRuMod({ enabled = true }: { enabled?: boolean } = {}) {
  const { resource: db, loadState, error, lastRefreshed, refresh, refreshCount, refreshIntervalMs } =
    useRefreshableResource({
      cache: dbCache,
      load: loadDatabase,
      refreshIntervalMs: REFRESH_INTERVAL_MS,
      enabled,
    });

  const queryDaily = useCallback(
    (days: number, endDate?: string): RuAdDailyRow[] => {
      if (!db) return [];
      const todayStr = getMskDateString();
      const endDateSql = endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate) ? endDate : todayStr;
      const winStart = windowStartSql(endDateSql, days);
      // UNION in `silent_days` rows (dates verified to have NO standalone MoD
      // AD intercept post — usually a Сводка-only day) so the chart renders
      // them as explicit zeros instead of skipping. silent_days is a recent
      // schema addition; some prod DBs may not have it yet, so check first
      // and skip the UNION if the table isn't present.
      const hasSilent = queryRows<Record<string, string>>(
        db,
        "SELECT name FROM sqlite_master WHERE type='table' AND name='silent_days'"
      ).length > 0;
      const sql = hasSilent
        ? `SELECT * FROM (
              ${DAILY_SELECT}
              WHERE report_date >= ${winStart}
                AND report_date <= date('${endDateSql}')
              GROUP BY report_date
            UNION ALL
              SELECT s.report_date AS date,
                     0 AS total, 0 AS night, 0 AS day, 0 AS reports,
                     0 AS overlap_total, 0 AS overlap_night, 0 AS overlap_day,
                     NULL AS overlap_note_total, NULL AS overlap_note_night, NULL AS overlap_note_day
              FROM silent_days s
              WHERE s.report_date >= ${winStart}
                AND s.report_date <= date('${endDateSql}')
                AND NOT EXISTS (SELECT 1 FROM ad_reports r WHERE r.report_date = s.report_date)
            ) ORDER BY date ASC`
        : `${DAILY_SELECT}
            WHERE report_date >= ${winStart}
              AND report_date <= date('${endDateSql}')
            GROUP BY report_date
            ORDER BY report_date ASC`;
      const numOr = (v: unknown, fallback = 0): number => (typeof v === "number" ? v : fallback);
      const strOr = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
      return queryRows<Record<string, number | string>>(db, sql).map((r) => ({
        date: String(r.date),
        is_today: String(r.date) === todayStr,
        total: typeof r.total === "number" ? r.total : null,
        night: typeof r.night === "number" ? r.night : null,
        day: typeof r.day === "number" ? r.day : null,
        reports: numOr(r.reports),
        overlap_total: numOr(r.overlap_total),
        overlap_night: numOr(r.overlap_night),
        overlap_day: numOr(r.overlap_day),
        overlap_note_total: strOr(r.overlap_note_total),
        overlap_note_night: strOr(r.overlap_note_night),
        overlap_note_day: strOr(r.overlap_note_day),
      }));
    },
    [db]
  );

  const queryGlobalStats = useCallback((): RuAdGlobalStats => {
    const zero: RuAdStat = { max: 0, median: 0, total: 0 };
    if (!db) return { total: zero, night: zero, day: zero };
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
    refreshIntervalMs,
  };
}
