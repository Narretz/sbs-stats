import { useState, useEffect, useCallback, useRef } from "react";
import type { Database } from "sql.js";
import type {
  GsuaDailyRow,
  GsuaDirectionRow,
  GsuaMetricKey,
  LoadState,
} from "@/types";
import { GSUA_METRIC_KEYS } from "@/types";

const DB_URL = import.meta.env.VITE_GSUA_DB_URL ?? "/data/general-staff.db";
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
  if (!response.ok) throw new Error(`Failed to fetch GSUA DB: ${response.status}`);
  const buffer = await response.arrayBuffer();
  return new SQL.Database(new Uint8Array(buffer));
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

const METRIC_COLS = GSUA_METRIC_KEYS.map((k) => `MAX(${k}) AS ${k}`).join(", ");

export const REFRESH_INTERVAL_MS = 10 * 60 * 1000;

export function useDatabaseGsua() {
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

  // Daily: one row per date, using the latest snapshot per (date, source).
  // GS posts run totals throughout the day; the last snapshot ≈ daily total.
  // Telegram and Facebook may both exist for a date; prefer telegram if present.
  const queryDaily = useCallback(
    (days: number, endDate?: string): GsuaDailyRow[] => {
      if (!db) return [];
      const todayStr = getKyivDateString();
      const endDateSql = endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate) ? endDate : todayStr;

      const sql = `
        WITH per_date_source AS (
          SELECT
            date,
            source,
            MAX(snapshot_at) AS latest_snapshot,
            ${METRIC_COLS}
          FROM posts
          WHERE date >= date('${endDateSql}', '-${days} days')
            AND date <= date('${endDateSql}')
          GROUP BY date, source, snapshot_at
        ),
        last_snapshot_per_date_source AS (
          SELECT date, source, MAX(latest_snapshot) AS latest_snapshot
          FROM per_date_source
          GROUP BY date, source
        )
        SELECT p.date, p.source, p.latest_snapshot AS snapshot_at, ${GSUA_METRIC_KEYS.join(", ")}
        FROM per_date_source p
        INNER JOIN last_snapshot_per_date_source l
          ON p.date = l.date AND p.source = l.source AND p.latest_snapshot = l.latest_snapshot
        ORDER BY p.date ASC,
                 CASE p.source WHEN 'telegram' THEN 0 ELSE 1 END ASC
      `;

      // De-dup to one row per date (telegram wins via ORDER BY).
      const seen = new Set<string>();
      const result: GsuaDailyRow[] = [];
      for (const row of queryRows<Record<string, unknown>>(db, sql)) {
        const d = String(row.date);
        if (seen.has(d)) continue;
        seen.add(d);
        const typed: GsuaDailyRow = {
          date: d,
          snapshot_at: String(row.snapshot_at ?? ""),
          source: String(row.source ?? ""),
          is_today: d === todayStr,
          ...(GSUA_METRIC_KEYS.reduce((acc, k) => {
            acc[k] = typeof row[k] === "number" ? (row[k] as number) : null;
            return acc;
          }, {} as Record<GsuaMetricKey, number | null>)),
        } as GsuaDailyRow;
        result.push(typed);
      }
      return result;
    },
    [db]
  );

  // Hourly: every snapshot in the range. X-axis = hour-of-snapshot,
  // one line per (date, source).
  const querySnapshots = useCallback(
    (days: number, endDate?: string): GsuaDailyRow[] => {
      if (!db) return [];
      const todayStr = getKyivDateString();
      const endDateSql = endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate) ? endDate : todayStr;

      const sql = `
        SELECT
          date,
          source,
          snapshot_at,
          ${METRIC_COLS}
        FROM posts
        WHERE date >= date('${endDateSql}', '-${days} days')
          AND date <= date('${endDateSql}')
          AND snapshot_at IS NOT NULL
        GROUP BY date, source, snapshot_at
        ORDER BY date ASC, snapshot_at ASC
      `;

      return queryRows<Record<string, unknown>>(db, sql).map((row) => {
        const d = String(row.date);
        const r: GsuaDailyRow = {
          date: d,
          snapshot_at: String(row.snapshot_at ?? ""),
          source: String(row.source ?? ""),
          is_today: d === todayStr,
          ...(GSUA_METRIC_KEYS.reduce((acc, k) => {
            acc[k] = typeof row[k] === "number" ? (row[k] as number) : null;
            return acc;
          }, {} as Record<GsuaMetricKey, number | null>)),
        } as GsuaDailyRow;
        return r;
      });
    },
    [db]
  );

  // Global stats: max + median across entire history (using daily totals).
  const queryGlobalStats = useCallback(() => {
    if (!db) return {} as Record<GsuaMetricKey, { max: number; median: number }>;

    const sql = `
      WITH per_date_source AS (
        SELECT date, source, MAX(snapshot_at) AS latest_snapshot, ${METRIC_COLS}
        FROM posts
        GROUP BY date, source, snapshot_at
      ),
      last_per_date_source AS (
        SELECT date, source, MAX(latest_snapshot) AS latest_snapshot
        FROM per_date_source
        GROUP BY date, source
      )
      SELECT p.date, p.source, ${GSUA_METRIC_KEYS.join(", ")}
      FROM per_date_source p
      INNER JOIN last_per_date_source l
        ON p.date = l.date AND p.source = l.source AND p.latest_snapshot = l.latest_snapshot
      ORDER BY p.date ASC,
               CASE p.source WHEN 'telegram' THEN 0 ELSE 1 END ASC
    `;
    const seen = new Set<string>();
    const rows: Record<string, number>[] = [];
    for (const row of queryRows<Record<string, number>>(db, sql)) {
      const d = String(row["date"]);
      if (seen.has(d)) continue;
      seen.add(d);
      rows.push(row);
    }

    const result = {} as Record<GsuaMetricKey, { max: number; median: number }>;
    for (const key of GSUA_METRIC_KEYS) {
      const vals = rows.map((r) => r[key]).filter((v): v is number => typeof v === "number").sort((a, b) => a - b);
      result[key] = {
        max: vals.length ? vals[vals.length - 1] : 0,
        median: vals.length ? vals[Math.floor(vals.length / 2)] : 0,
      };
    }
    return result;
  }, [db]);

  // Distinct directions ever observed (ordered by total attacks desc).
  const queryDirectionList = useCallback((): string[] => {
    if (!db) return [];
    const sql = `
      SELECT direction, SUM(COALESCE(attacks, 0)) AS total
      FROM directions
      GROUP BY direction
      HAVING total > 0
      ORDER BY total DESC
    `;
    return queryRows<{ direction: string }>(db, sql).map((r) => r.direction);
  }, [db]);

  // Per-direction daily totals. `attacks` is cumulative (peaks in the 08:00
  // next-day final summary); `ongoing` is instantaneous (the same final summary
  // typically has it NULL because no engagements are still in progress at that
  // moment). MAX per (date, source) gives the right number for both.
  const queryDirectionDaily = useCallback(
    (direction: string, days: number, endDate?: string): GsuaDirectionRow[] => {
      if (!db) return [];
      const todayStr = getKyivDateString();
      const endDateSql = endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate) ? endDate : todayStr;
      // Escape single quotes in the direction name.
      const dirSafe = direction.replace(/'/g, "''");

      const sql = `
        SELECT
          p.date,
          p.source,
          MAX(p.snapshot_at)       AS snapshot_at,
          '${dirSafe}'             AS direction,
          MAX(d.attacks)           AS attacks,
          MAX(d.ongoing)           AS ongoing
        FROM posts p
        INNER JOIN directions d
          ON p.source = d.source AND p.source_id = d.source_id
        WHERE d.direction = '${dirSafe}'
          AND p.date >= date('${endDateSql}', '-${days} days')
          AND p.date <= date('${endDateSql}')
        GROUP BY p.date, p.source
        ORDER BY p.date ASC,
                 CASE p.source WHEN 'telegram' THEN 0 ELSE 1 END ASC
      `;
      const seen = new Set<string>();
      const out: GsuaDirectionRow[] = [];
      for (const row of queryRows<Record<string, unknown>>(db, sql)) {
        const d = String(row.date);
        if (seen.has(d)) continue;
        seen.add(d);
        out.push({
          date: d,
          snapshot_at: String(row.snapshot_at ?? ""),
          direction: String(row.direction ?? ""),
          attacks: typeof row.attacks === "number" ? row.attacks : null,
          ongoing: typeof row.ongoing === "number" ? row.ongoing : null,
          is_today: d === todayStr,
        });
      }
      return out;
    },
    [db]
  );

  return {
    loadState, error,
    queryDaily, querySnapshots, queryGlobalStats,
    queryDirectionList, queryDirectionDaily,
    refresh, lastRefreshed, refreshCount,
  };
}
