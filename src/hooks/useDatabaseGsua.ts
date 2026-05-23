import { useState, useEffect, useCallback, useRef } from "react";
import { createDbWorker, type WorkerHttpvfs } from "sql.js-httpvfs";
import type {
  GsuaDailyRow,
  GsuaDirectionRow,
  GsuaMetricKey,
  GsuaMonthlyRow,
  LoadState,
} from "@/types";
import { GSUA_METRIC_KEYS } from "@/types";

const DB_URL = import.meta.env.VITE_GSUA_DB_URL ?? "/data/general-staff.db";
const WORKER_URL = "/vendor/httpvfs/sqlite.worker.js";
const WASM_URL = "/vendor/httpvfs/sql-wasm.wasm";

// SQLite default page size is 4096; matching it keeps range fetches aligned.
const REQUEST_CHUNK_SIZE = 4096;
// Hard cap on total bytes the worker will fetch over its lifetime. Plenty for
// a few months of queries on a 32 MB file; cap protects against runaway scans.
const MAX_BYTES = 50 * 1024 * 1024;

function getKyivDateString(): string {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });
}

let workerPromise: Promise<WorkerHttpvfs> | null = null;

async function loadWorker(): Promise<WorkerHttpvfs> {
  return createDbWorker(
    [
      {
        from: "inline",
        config: {
          serverMode: "full",
          url: DB_URL,
          requestChunkSize: REQUEST_CHUNK_SIZE,
        },
      },
    ],
    WORKER_URL,
    WASM_URL,
    MAX_BYTES
  );
}

function getOrCreateWorker(): Promise<WorkerHttpvfs> {
  if (!workerPromise) workerPromise = loadWorker();
  return workerPromise;
}

const METRIC_COLS = GSUA_METRIC_KEYS.map((k) => `MAX(${k}) AS ${k}`).join(", ");

export const REFRESH_INTERVAL_MS = 10 * 60 * 1000;

export function useDatabaseGsua() {
  const [worker, setWorker] = useState<WorkerHttpvfs | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const lastRefreshedRef = useRef<Date | null>(null);
  const [refreshCount, setRefreshCount] = useState(0);

  const doLoad = useCallback(() => {
    setLoadState("loading");
    getOrCreateWorker()
      .then((w) => {
        setWorker(w);
        setLoadState("ready");
        const now = new Date();
        setLastRefreshed(now);
        lastRefreshedRef.current = now;
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setLoadState("error");
        workerPromise = null;
      });
  }, []);

  const doRefresh = useCallback(() => {
    workerPromise = null;
    setWorker(null);
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

  // ── Queries ─────────────────────────────────────────────────────────────────
  // Each query is async: the worker reads SQLite pages over HTTP range
  // requests rather than the whole DB up-front.

  const queryDaily = useCallback(
    async (days: number, endDate?: string): Promise<GsuaDailyRow[]> => {
      if (!worker) return [];
      const todayStr = getKyivDateString();
      const endDateSql = endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate) ? endDate : todayStr;
      const startDateSql = `date('${endDateSql}', '-${days} days')`;

      const sql = `
        WITH per_date_source AS (
          SELECT date, source, MAX(snapshot_at) AS latest_snapshot, ${METRIC_COLS}
          FROM posts
          WHERE date >= ${startDateSql} AND date <= '${endDateSql}'
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
      const rows = (await worker.db.query(sql)) as Record<string, unknown>[];
      const seen = new Set<string>();
      const result: GsuaDailyRow[] = [];
      for (const row of rows) {
        const d = String(row.date);
        if (seen.has(d)) continue;
        seen.add(d);
        result.push({
          date: d,
          snapshot_at: String(row.snapshot_at ?? ""),
          source: String(row.source ?? ""),
          is_today: d === todayStr,
          ...(GSUA_METRIC_KEYS.reduce((acc, k) => {
            acc[k] = typeof row[k] === "number" ? (row[k] as number) : null;
            return acc;
          }, {} as Record<GsuaMetricKey, number | null>)),
        } as GsuaDailyRow);
      }
      return result;
    },
    [worker]
  );

  const querySnapshots = useCallback(
    async (days: number, endDate?: string): Promise<GsuaDailyRow[]> => {
      if (!worker) return [];
      const todayStr = getKyivDateString();
      const endDateSql = endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate) ? endDate : todayStr;
      const startDateSql = `date('${endDateSql}', '-${days} days')`;

      const sql = `
        SELECT date, source, snapshot_at, ${METRIC_COLS}
        FROM posts
        WHERE date >= ${startDateSql} AND date <= '${endDateSql}'
          AND snapshot_at IS NOT NULL
        GROUP BY date, source, snapshot_at
        ORDER BY date ASC, snapshot_at ASC
      `;
      const rows = (await worker.db.query(sql)) as Record<string, unknown>[];
      return rows.map((row) => {
        const d = String(row.date);
        return {
          date: d,
          snapshot_at: String(row.snapshot_at ?? ""),
          source: String(row.source ?? ""),
          is_today: d === todayStr,
          ...(GSUA_METRIC_KEYS.reduce((acc, k) => {
            acc[k] = typeof row[k] === "number" ? (row[k] as number) : null;
            return acc;
          }, {} as Record<GsuaMetricKey, number | null>)),
        } as GsuaDailyRow;
      });
    },
    [worker]
  );

  const queryGlobalStats = useCallback(
    async (): Promise<Record<GsuaMetricKey, { max: number; median: number }>> => {
      if (!worker) return {} as Record<GsuaMetricKey, { max: number; median: number }>;

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
      const rows = (await worker.db.query(sql)) as Record<string, number>[];
      const seen = new Set<string>();
      const deduped: Record<string, number>[] = [];
      for (const row of rows) {
        const d = String(row.date);
        if (seen.has(d)) continue;
        seen.add(d);
        deduped.push(row);
      }

      const result = {} as Record<GsuaMetricKey, { max: number; median: number }>;
      for (const key of GSUA_METRIC_KEYS) {
        const vals = deduped.map((r) => r[key]).filter((v): v is number => typeof v === "number").sort((a, b) => a - b);
        result[key] = {
          max: vals.length ? vals[vals.length - 1] : 0,
          median: vals.length ? vals[Math.floor(vals.length / 2)] : 0,
        };
      }
      return result;
    },
    [worker]
  );

  const queryMonthly = useCallback(async (): Promise<GsuaMonthlyRow[]> => {
    if (!worker) return [];
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
    const rows = (await worker.db.query(sql)) as Record<string, number | null>[];
    const seen = new Set<string>();
    const daily: Record<string, number | null>[] = [];
    for (const row of rows) {
      const d = String(row["date"]);
      if (seen.has(d)) continue;
      seen.add(d);
      daily.push(row);
    }

    const byMonth = new Map<string, Record<GsuaMetricKey, number>>();
    for (const row of daily) {
      const month = String(row["date"]).slice(0, 7);
      const bucket =
        byMonth.get(month) ??
        (GSUA_METRIC_KEYS.reduce((acc, k) => {
          acc[k] = 0;
          return acc;
        }, {} as Record<GsuaMetricKey, number>));
      for (const k of GSUA_METRIC_KEYS) {
        const v = row[k];
        if (typeof v === "number") bucket[k] += v;
      }
      byMonth.set(month, bucket);
    }

    const kyivDateStr = getKyivDateString();
    const currentMonth = kyivDateStr.slice(0, 7);
    const dayOfMonth = parseInt(kyivDateStr.slice(8, 10), 10);
    const [y, m] = currentMonth.split("-").map(Number);
    const daysInMonth = new Date(y, m, 0).getDate();

    return Array.from(byMonth.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, sums]) => {
        const isCurrent = month === currentMonth;
        const row: GsuaMonthlyRow = {
          date: month,
          is_current_month: isCurrent,
          projection_day: isCurrent ? dayOfMonth : null,
          projection_days_in_month: isCurrent ? daysInMonth : null,
          ...sums,
        } as GsuaMonthlyRow;
        if (isCurrent && dayOfMonth > 0) {
          const mult = daysInMonth / dayOfMonth;
          for (const k of GSUA_METRIC_KEYS) {
            row[`${k}_projected`] = Math.round(sums[k] * mult);
          }
        }
        return row;
      });
  }, [worker]);

  const queryDirectionList = useCallback(async (): Promise<string[]> => {
    if (!worker) return [];
    const sql = `
      SELECT direction, SUM(COALESCE(attacks, 0)) AS total
      FROM directions
      GROUP BY direction
      HAVING total > 0
      ORDER BY total DESC
    `;
    const rows = (await worker.db.query(sql)) as { direction: string }[];
    return rows.map((r) => r.direction);
  }, [worker]);

  const queryDirectionDaily = useCallback(
    async (direction: string, days: number, endDate?: string): Promise<GsuaDirectionRow[]> => {
      if (!worker) return [];
      const todayStr = getKyivDateString();
      const endDateSql = endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate) ? endDate : todayStr;
      const dirSafe = direction.replace(/'/g, "''");

      const sql = `
        SELECT
          p.date,
          p.source,
          MAX(p.snapshot_at) AS snapshot_at,
          '${dirSafe}'       AS direction,
          MAX(d.attacks)     AS attacks,
          MAX(d.ongoing)     AS ongoing
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
      const rows = (await worker.db.query(sql)) as Record<string, unknown>[];
      const seen = new Set<string>();
      const out: GsuaDirectionRow[] = [];
      for (const row of rows) {
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
    [worker]
  );

  const queryDirectionSnapshots = useCallback(
    async (direction: string, days: number, endDate?: string): Promise<GsuaDirectionRow[]> => {
      if (!worker) return [];
      const todayStr = getKyivDateString();
      const endDateSql = endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate) ? endDate : todayStr;
      const dirSafe = direction.replace(/'/g, "''");

      const sql = `
        SELECT
          p.date, p.source, p.snapshot_at,
          d.direction, d.attacks, d.ongoing
        FROM posts p
        INNER JOIN directions d
          ON p.source = d.source AND p.source_id = d.source_id
        WHERE d.direction = '${dirSafe}'
          AND p.date >= date('${endDateSql}', '-${days} days')
          AND p.date <= date('${endDateSql}')
          AND p.snapshot_at IS NOT NULL
        ORDER BY p.date ASC, p.snapshot_at ASC,
                 CASE p.source WHEN 'telegram' THEN 0 ELSE 1 END ASC
      `;
      const rows = (await worker.db.query(sql)) as Record<string, unknown>[];
      return rows.map((row) => ({
        date: String(row.date),
        snapshot_at: String(row.snapshot_at ?? ""),
        direction: String(row.direction ?? ""),
        attacks: typeof row.attacks === "number" ? row.attacks : null,
        ongoing: typeof row.ongoing === "number" ? row.ongoing : null,
        is_today: String(row.date) === todayStr,
      }));
    },
    [worker]
  );

  return {
    loadState, error,
    queryDaily, querySnapshots, queryGlobalStats, queryMonthly,
    queryDirectionList, queryDirectionDaily, queryDirectionSnapshots,
    refresh, lastRefreshed, refreshCount,
  };
}
