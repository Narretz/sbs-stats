import { useCallback } from "react";
import { createDbWorker, type WorkerHttpvfs } from "sql.js-httpvfs";
import type {
  GsuaDailyRow,
  GsuaDirectionCoverageRow,
  GsuaGlobalStats,
  GsuaMetricKey,
  GsuaMonthlyRow,
  EodEstimate,
} from "@/types";
import { GSUA_METRIC_KEYS } from "@/types";
import { computeEodProjection, type EodReading } from "@/utils/eodProjection";
import { projectFromDays } from "@/utils/monthProjection";
import { attachDailyMedians, attachDayCounts, dailyMediansByMonth, dayCountsByMonth } from "@/utils/dailyMedian";
import { gsuaSourcesByDate, type GsuaPostSource } from "@/utils/sources";
import type { SheetSource } from "@/components/TooltipTable";
import { makeResourceCache, useRefreshableResource } from "@/hooks/useRefreshableResource";
import { getKyivDateString } from "@/hooks/sqlLoader";
import { daysBetweenInclusive, windowStartDate, windowStartSql } from "@/utils/dayRange";
import { projectCoverageMonth } from "@/utils/gsuaDirections";
import {
  LATEST_POSTS, METRIC_COLS, canonicalDailySql, coverageDailySql, coverageFromTables, coverageMonthlySql,
  pickCanonicalDaily, pivotCoverageDaily, pivotCoverageMonthly, recentFloor, sumMetricsByMonth,
} from "@/utils/gsuaSql";

// Dev default is the `.app.db` copy, the same object production reads: same
// schema with `posts.text` blanked, ~3x smaller, and nothing here queries the
// text. Pointing dev at the full DB instead made local range-fetches behave
// unlike the deployed site. `scripts/fetch_prod_dbs.sh` downloads both copies;
// after a LOCAL reparse rebuild this one with scripts/build_app_db.py, or dev
// keeps serving the pre-reparse rows.
const DB_URL =
  import.meta.env.VITE_GSUA_DB_URL ?? `${import.meta.env.BASE_URL}data/ru-attacks-gsua.app.db`;
const WORKER_URL = `${import.meta.env.BASE_URL}vendor/httpvfs/sqlite.worker.js`;
const WASM_URL = `${import.meta.env.BASE_URL}vendor/httpvfs/sql-wasm.wasm`;

// SQLite default page size is 4096; matching it keeps range fetches aligned.
const REQUEST_CHUNK_SIZE = 4096;
// Hard cap on total bytes the worker will fetch over its lifetime. Plenty for
// a few months of queries on a 32 MB file; cap protects against runaway scans.
const MAX_BYTES = 50 * 1024 * 1024;

async function loadWorker(): Promise<WorkerHttpvfs> {
  return createDbWorker(
    [
      {
        from: "inline",
        config: {
          serverMode: "full",
          url: DB_URL,
          requestChunkSize: REQUEST_CHUNK_SIZE,
          // The R2 object is overwritten by every scrape, and httpvfs reads it
          // as many byte-ranges rather than one download. Without a cache-bust
          // the caching layers (browser HTTP cache, CDN edge) can serve a range
          // cached from the old object next to one fetched from the new — and
          // since different queries touch different pages, the result is
          // inconsistent or empty reads. A per-worker token gives every load
          // its own cache key, so ranges cached under a previous token can
          // never be mixed into this one. Mirrors the SBS loader's `?bust=` +
          // no-store. (sql.js-httpvfs appends this as a query param.)
          //
          // It does NOT pin a version. R2 keys on the object path and ignores
          // the query string, so if an upload lands mid-session the next range
          // comes from the new file with the same token attached. Nothing on
          // the client can prevent that: pinning needs the server in on it —
          // ETag + If-Match so a mid-flight change fails instead of tearing
          // silently, or immutable versioned object names. Exposure is one
          // torn result set until the next refresh, three uploads a day.
          cacheBust: String(Date.now()),
        },
      },
    ],
    WORKER_URL,
    WASM_URL,
    MAX_BYTES
  );
}

const workerCache = makeResourceCache<WorkerHttpvfs>();

// LATEST_POSTS / METRIC_COLS and the queries with a precomputed twin live in
// utils/gsuaSql.ts.

// GSUA reports update only ~3×/day, so polling the 32 MB R2 DB every 10 min is
// wasteful. Refresh hourly; the on-focus + manual refresh paths still apply.
export const REFRESH_INTERVAL_MS = 60 * 60 * 1000;

export function useDatabaseGsua({ enabled = true }: { enabled?: boolean } = {}) {
  const { resource: worker, loadState, error, lastRefreshed, refresh, refreshCount, refreshIntervalMs } =
    useRefreshableResource({
      cache: workerCache,
      load: loadWorker,
      refreshIntervalMs: REFRESH_INTERVAL_MS,
      enabled,
    });

  // ── Queries ─────────────────────────────────────────────────────────────────
  // Each query is async: the worker reads SQLite pages over HTTP range
  // requests rather than the whole DB up-front.

  // Does the app copy carry this precomputed table (scripts/gsua/app_db.sql)?
  // The schema is on page 1, which every query has already read.
  const hasTable = useCallback(async (name: string): Promise<boolean> => {
    if (!worker) return false;
    const rows = (await worker.db.query(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '${name}'`,
    )) as unknown[];
    return rows.length > 0;
  }, [worker]);

  const queryDaily = useCallback(
    async (days: number, endDate?: string): Promise<GsuaDailyRow[]> => {
      if (!worker) return [];
      const todayStr = getKyivDateString();
      const endDateSql = endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate) ? endDate : todayStr;
      const startDateSql = windowStartSql(endDateSql, days);
      // Days before the recent floor come from gsua_daily when the app copy
      // has it — one small row per day, where reading them live walks the
      // posts' indexes: what makes a ranking (utils/barOrder), which reads
      // every day there is, cheap. The recent days, which a scrape can still
      // change and which carry the interim snapshot, stay live.
      const floor = recentFloor(todayStr);
      const settled = await hasTable("gsua_daily")
        ? (await worker.db.query(
            `SELECT * FROM gsua_daily WHERE date >= ${startDateSql} AND date < '${floor}' AND date <= '${endDateSql}' ORDER BY date`,
          )) as Record<string, unknown>[]
        : null;
      const liveFrom = settled ? `MAX(${startDateSql}, '${floor}')` : startDateSql;

      const sql = `
        WITH per_date_source AS (
          SELECT date, source, MAX(snapshot_at) AS latest_snapshot, ${METRIC_COLS}
          FROM ${LATEST_POSTS} posts
          WHERE date >= ${liveFrom} AND date <= '${endDateSql}'
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
      const rows = [...(settled ?? []), ...(await worker.db.query(sql)) as Record<string, unknown>[]];
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
    [worker, hasTable]
  );

  const queryGlobalStats = useCallback(
    async (): Promise<GsuaGlobalStats> => {
      if (!worker) return {} as GsuaGlobalStats;
      const deduped = pickCanonicalDaily((await worker.db.query(canonicalDailySql())) as Record<string, number>[]);

      const result = {} as GsuaGlobalStats;
      for (const key of GSUA_METRIC_KEYS) {
        const vals = deduped.map((r) => r[key]).filter((v): v is number => typeof v === "number").sort((a, b) => a - b);
        result[key] = {
          max: vals.length ? vals[vals.length - 1] : 0,
          median: vals.length ? vals[Math.floor(vals.length / 2)] : 0,
          total: vals.reduce((s, n) => s + n, 0),
        };
      }
      return result;
    },
    [worker]
  );

  // Completed months from `gsua_monthly` when the app copy has it; the recent
  // months — which a scrape can still change, and whose days the projection
  // needs — live, from their own days only. Without the table, everything live.
  const queryMonthly = useCallback(async (): Promise<GsuaMonthlyRow[]> => {
    if (!worker) return [];
    const today = getKyivDateString();
    const floor = recentFloor(today);
    const precomputed = await hasTable("gsua_monthly");
    const daily = pickCanonicalDaily(
      (await worker.db.query(canonicalDailySql(precomputed ? floor : undefined))) as Record<string, number | null>[],
    );
    const byMonth = sumMetricsByMonth(daily);
    if (precomputed) {
      const settled = (await worker.db.query(
        `SELECT * FROM gsua_monthly WHERE month < '${floor.slice(0, 7)}'`,
      )) as Record<string, unknown>[];
      for (const r of settled) {
        byMonth.set(String(r.month), Object.fromEntries(
          GSUA_METRIC_KEYS.map((k) => [k, typeof r[k] === "number" ? r[k] : 0]),
        ) as Record<GsuaMetricKey, number>);
      }
    }

    // Each month's median day. The live query above holds the recent months'
    // days (or every day, without the precomputed tables); completed months'
    // come from gsua_daily, an app copy built before it existed has none, and
    // those months simply show no median until it's rebuilt.
    const settledDays = precomputed && await hasTable("gsua_daily")
      ? (await worker.db.query(
          `SELECT * FROM gsua_daily WHERE date < '${floor}'`,
        )) as Record<string, unknown>[]
      : [];
    const allDays = [...settledDays, ...daily].map((row) => ({
      date: String(row["date"]),
      values: row as Partial<Record<GsuaMetricKey, number | null>>,
    }));
    const medians = dailyMediansByMonth(allDays, GSUA_METRIC_KEYS, today);
    // …and how many days each metric was reported on — the 2023 backfill's
    // reports carry no shellings or KAB counts at all, and drones on a handful
    // of days, which a month's sum alone can't tell from a quiet month.
    const dayCounts = dayCountsByMonth(allDays, GSUA_METRIC_KEYS, today);

    const currentMonth = today.slice(0, 7);
    const projection = projectFromDays(
      currentMonth,
      today,
      daily.map((row) => ({ date: String(row["date"]), values: row as Partial<Record<GsuaMetricKey, number | null>> })),
      GSUA_METRIC_KEYS,
    );

    return Array.from(byMonth.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, sums]) => {
        const isCurrent = month === currentMonth;
        const p = isCurrent ? projection : null;
        const row: GsuaMonthlyRow = {
          date: month,
          is_current_month: isCurrent,
          projection_day: p?.completedDays ?? null,
          projection_days_in_month: p?.daysInMonth ?? null,
          projection_partial_day: p?.partialDay,
          ...sums,
        } as GsuaMonthlyRow;
        for (const [k, v] of Object.entries(p?.projected ?? {})) {
          row[`${k as GsuaMetricKey}_projected`] = v;
        }
        attachDailyMedians(row, medians);
        attachDayCounts(row, dayCounts);
        return row;
      });
  }, [worker, hasTable]);

  // ── End-of-day projection for today ──────────────────────────────────────────
  // GS posts run cumulative daily totals across the day (e.g. "as of 16:00",
  // "as of 22:00") and settle with next morning's report. Today's latest snapshot
  // is therefore partial; project the settled total from the last 90 days, keying
  // readings by the snapshot's clock hour. day-final = last snapshot of the day.
  const queryEodProjection = useCallback(async (): Promise<Partial<Record<GsuaMetricKey, EodEstimate>>> => {
    if (!worker) return {};
    const todayStr = getKyivDateString();
    const sql = `
      SELECT date, snapshot_at, ${METRIC_COLS}
      FROM ${LATEST_POSTS} posts
      WHERE date >= date('${todayStr}', '-90 days') AND snapshot_at IS NOT NULL
      GROUP BY date, snapshot_at
      ORDER BY date ASC, snapshot_at ASC
    `;
    const rows = (await worker.db.query(sql)) as Record<string, unknown>[];
    const byDate = new Map<string, EodReading<GsuaMetricKey>[]>();
    for (const r of rows) {
      const d = String(r.date);
      const snap = String(r.snapshot_at);
      if (!byDate.has(d)) byDate.set(d, []);
      byDate.get(d)!.push({
        bucket: snap.slice(11, 13), // clock hour, "16"
        asOf: snap.slice(11, 16),   // "16:00"
        values: r as Record<GsuaMetricKey, number | null>,
      });
    }
    return computeEodProjection(byDate, todayStr, GSUA_METRIC_KEYS);
  }, [worker]);

  // Ranked by all-time attacks. Read from `direction_totals`, which the app
  // copy is built with (scripts/gsua/app_db.sql): two pages. Computed live, as
  // below, it walks every direction row ever recorded — ~580 pages, the
  // heaviest read of the daily page — so the live query is only the fallback,
  // for a copy built without that script. Same rows either way.
  const queryDirectionList = useCallback(async (): Promise<string[]> => {
    if (!worker) return [];
    const derived = (await worker.db.query(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'direction_totals'`,
    )) as unknown[];
    if (derived.length) {
      const rows = (await worker.db.query(
        `SELECT direction FROM direction_totals ORDER BY total DESC`,
      )) as { direction: string }[];
      return rows.map((r) => r.direction);
    }
    const sql = `
      SELECT d.direction, SUM(COALESCE(d.attacks, 0)) AS total
      FROM directions d
      INNER JOIN ${LATEST_POSTS} p
        ON p.source = d.source AND p.source_id = d.source_id AND p.scraped_at = d.scraped_at
      GROUP BY d.direction
      HAVING total > 0
      ORDER BY total DESC
    `;
    const rows = (await worker.db.query(sql)) as { direction: string }[];
    return rows.map((r) => r.direction);
  }, [worker]);

  // Per-date "how much of today's `combat_engagements` count is broken down
  // into named directions, and which ones?" — for the coverage/composition
  // chart. Picks ONE canonical post per date (prefer telegram, then latest
  // snapshot) and reads both its aggregate and its per-direction attacks from
  // the SAME post, so the delta (`unattributed`) is honest — we're not
  // comparing totals from one report with directions from another.
  //
  // Query returns flat (date, direction, attacks) rows plus a per-date total;
  // the caller pivots into `{ date, total, unattributed, byDirection: {...} }`.
  const queryDirectionCoverage = useCallback(
    async (days: number, endDate?: string): Promise<GsuaDirectionCoverageRow[]> => {
      if (!worker) return [];
      const todayStr = getKyivDateString();
      const endDateSql = endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate) ? endDate : todayStr;
      const sql = coverageDailySql(windowStartSql(endDateSql, days), `'${endDateSql}'`);
      return pivotCoverageDaily((await worker.db.query(sql)) as Record<string, unknown>[], todayStr);
    },
    [worker]
  );

  // queryDirectionCoverage over a ranking's span (utils/barOrder) — every day
  // up to the window's end, which live would walk most of the file. Settled
  // days come from the app copy's gsua_coverage_daily, and gsua_direction_daily
  // for just `directions` (raw names; [] reads none, for the overview's total
  // and attributed alone): ~8 pages a direction. The recent days, which a
  // scrape can still change, stay live, as in queryDaily.
  const queryDirectionCoverageSpan = useCallback(
    async (days: number, endDate: string | undefined, directions: string[]): Promise<GsuaDirectionCoverageRow[]> => {
      if (!worker) return [];
      if (!(await hasTable("gsua_direction_daily"))) return queryDirectionCoverage(days, endDate);
      const todayStr = getKyivDateString();
      const end = endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate) ? endDate : todayStr;
      const start = windowStartDate(end, days);
      const floor = recentFloor(todayStr);
      const span = `date >= '${start}' AND date < '${floor}' AND date <= '${end}'`;
      const totals = (await worker.db.query(
        `SELECT date, total, attributed FROM gsua_coverage_daily WHERE ${span}`,
      )) as Record<string, unknown>[];
      const quoted = directions.map((d) => `'${d.replace(/'/g, "''")}'`).join(", ");
      const dirs = directions.length
        ? (await worker.db.query(
            `SELECT direction, date, attacks FROM gsua_direction_daily WHERE direction IN (${quoted}) AND ${span}`,
          )) as Record<string, unknown>[]
        : [];
      const liveFrom = start > floor ? start : floor;
      const recent = end >= liveFrom ? await queryDirectionCoverage(daysBetweenInclusive(liveFrom, end) ?? 1, end) : [];
      return [...coverageFromTables(totals, dirs), ...recent];
    },
    [worker, hasTable, queryDirectionCoverage]
  );

  // Monthly-aggregated variant of queryDirectionCoverage. Same canonical-post
  // selection logic (prefer telegram, latest snapshot per date), then rolls
  // both `combat_engagements` and per-direction `attacks` up to the month.
  // Month totals and per-direction sums come from two side-by-side CTEs so
  // the outer JOIN doesn't multiply the month total by the number of
  // directions in it.
  // Completed months from `gsua_direction_monthly` when the app copy has it,
  // the recent ones live — see queryMonthly. Live over everything, this was the
  // site's heaviest read: ~1,070 pages.
  const queryDirectionCoverageMonthly = useCallback(
    async (): Promise<GsuaDirectionCoverageRow[]> => {
      if (!worker) return [];
      const floor = recentFloor(getKyivDateString());
      const precomputed = await hasTable("gsua_direction_monthly");
      const recent = (await worker.db.query(coverageMonthlySql(precomputed ? floor : undefined))) as Record<string, unknown>[];
      const settled = precomputed
        ? ((await worker.db.query(
            `SELECT date, total, direction, attacks FROM gsua_direction_monthly WHERE date < '${floor.slice(0, 7)}'`,
          )) as Record<string, unknown>[])
        : [];
      const months = pivotCoverageMonthly([...settled, ...recent]);
      // The month in progress also carries its end-of-month projection, which
      // needs the month's days rather than its sum — a window of at most 31.
      const today = getKyivDateString();
      const current = months.find((r) => r.date === today.slice(0, 7));
      if (current) {
        const days = await queryDirectionCoverage(Number(today.slice(8, 10)), today);
        current.projection = projectCoverageMonth(current.date, today, days) ?? undefined;
      }
      return months;
    },
    [worker, hasTable, queryDirectionCoverage]
  );

  // Every post behind each day of the window — the pinned sheet's links, the
  // one the day's figures come from first (utils/sources). The latest version
  // of each post; the date window pushes down onto idx_posts_date, so over
  // httpvfs this reads the window's few dozen rows, not the history.
  const querySources = useCallback(
    async (days: number, endDate?: string): Promise<Map<string, SheetSource[]>> => {
      if (!worker) return new Map();
      const endDateSql = endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate) ? endDate : getKyivDateString();
      const rows = (await worker.db.query(
        `SELECT date, source, source_id, snapshot_at, message_date, url FROM ${LATEST_POSTS} posts
         WHERE date >= ${windowStartSql(endDateSql, days)} AND date <= '${endDateSql}'
           AND url IS NOT NULL AND url != ''`,
      )) as GsuaPostSource[];
      return gsuaSourcesByDate(rows);
    },
    [worker],
  );

  // Full covered date range (first/last day) plus the newest snapshot on the last
  // day, for the "Data … – …" freshness note in the page header — the latest
  // snapshot's time tells a finished day (≥22:00 post in) from a partial one.
  // Async like the other queries (httpvfs); MIN/MAX over idx_posts_date, an index
  // seek rather than a full scan.
  const queryDataWindow = useCallback(async (): Promise<{
    minDate: string | null;
    maxDate: string | null;
    latestSnapshotAt: string | null;
  }> => {
    if (!worker) return { minDate: null, maxDate: null, latestSnapshotAt: null };
    const rows = (await worker.db.query(
      `SELECT MIN(date) AS minDate, MAX(date) AS maxDate,
              (SELECT MAX(snapshot_at) FROM posts WHERE date = (SELECT MAX(date) FROM posts)) AS latestSnapshotAt
       FROM posts`
    )) as Record<string, unknown>[];
    const r = rows[0] ?? {};
    return {
      minDate: (r.minDate as string) ?? null,
      maxDate: (r.maxDate as string) ?? null,
      latestSnapshotAt: (r.latestSnapshotAt as string) ?? null,
    };
  }, [worker]);

  return {
    loadState, error,
    queryDaily, queryGlobalStats, queryMonthly, queryEodProjection, queryDataWindow,
    queryDirectionList,
    queryDirectionCoverage, queryDirectionCoverageSpan, queryDirectionCoverageMonthly, querySources,
    refresh, lastRefreshed, refreshCount,
    refreshIntervalMs,
  };
}
