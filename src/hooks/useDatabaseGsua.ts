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
import { GSUA_METRIC_KEYS, directionAxis } from "@/types";
import { computeEodProjection, type EodReading } from "@/utils/eodProjection";
import { projectFromDays } from "@/utils/monthProjection";
import { makeResourceCache, useRefreshableResource } from "@/hooks/useRefreshableResource";
import { getKyivDateString } from "@/hooks/sqlLoader";
import { windowStartSql } from "@/utils/dayRange";
import {
  LATEST_POSTS, METRIC_COLS, canonicalDailySql, coverageMonthlySql, pickCanonicalDaily,
  pivotCoverageMonthly, recentFloor, sumMetricsByMonth,
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

  const queryDaily = useCallback(
    async (days: number, endDate?: string): Promise<GsuaDailyRow[]> => {
      if (!worker) return [];
      const todayStr = getKyivDateString();
      const endDateSql = endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate) ? endDate : todayStr;
      const startDateSql = windowStartSql(endDateSql, days);

      const sql = `
        WITH per_date_source AS (
          SELECT date, source, MAX(snapshot_at) AS latest_snapshot, ${METRIC_COLS}
          FROM ${LATEST_POSTS} posts
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

  // Does the app copy carry this precomputed table (scripts/gsua/app_db.sql)?
  // The schema is on page 1, which every query has already read.
  const hasTable = useCallback(async (name: string): Promise<boolean> => {
    if (!worker) return false;
    const rows = (await worker.db.query(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '${name}'`,
    )) as unknown[];
    return rows.length > 0;
  }, [worker]);

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

      const sql = `
        WITH latest_posts AS (
          -- The date window is applied HERE, not in per_date_source_snap below.
          -- latest_posts is referenced twice (here + the final join), so SQLite
          -- MATERIALISES it; without the window it would SCAN all of posts (all
          -- history) to resolve every post's latest version, then filter. With
          -- the window it SEARCHes idx_posts_date for just the window's rows —
          -- ~75 for 30 days vs ~2600 total — a big cut in httpvfs range fetches.
          -- Safe: 'date' is invariant across a post's edit-versions, so the
          -- filter never splits a (source, source_id) version chain.
          SELECT p.* FROM posts p
          WHERE p.date >= ${windowStartSql(endDateSql, days)}
            AND p.date <= '${endDateSql}'
            AND NOT EXISTS (
              SELECT 1 FROM posts n
              WHERE n.source = p.source AND n.source_id = p.source_id
                AND n.scraped_at > p.scraped_at
            )
        ),
        per_date_source_snap AS (
          -- One row per (date, source, snapshot_at), collapsing multipart posts;
          -- MAX(combat_engagements) mirrors the daily_combined view's merge.
          SELECT date, source, snapshot_at,
                 MAX(combat_engagements) AS combat_engagements
          FROM latest_posts
          WHERE snapshot_at IS NOT NULL
          GROUP BY date, source, snapshot_at
        ),
        best_per_date AS (
          -- Pick the canonical row per date: prefer telegram, then latest snapshot.
          SELECT date, source, snapshot_at, combat_engagements
          FROM (
            SELECT *,
                   ROW_NUMBER() OVER (
                     PARTITION BY date
                     ORDER BY CASE source WHEN 'telegram' THEN 0 ELSE 1 END,
                              snapshot_at DESC
                   ) AS rn
            FROM per_date_source_snap
          ) t
          WHERE rn = 1
        )
        SELECT
          b.date,
          b.snapshot_at       AS snapshot_at,
          b.combat_engagements AS total,
          d.direction         AS direction,
          -- Fair-share: paired-anchor sentences ("На X і Y напрямках N ...")
          -- store the raw N on each row with attacks_group_size = k; the
          -- honest per-direction contribution is N/k, so k=2 halves the
          -- credit each direction takes. Solo entries have group_size=1
          -- and pass through unchanged.
          -- MAX (not SUM) over the joined posts: best_per_date collapses a
          -- (date, source, snapshot_at) to one group, but the join to
          -- latest_posts re-expands it to every source_id sharing that key.
          -- When the GS channel double-posts the SAME report (two message
          -- ids, identical directions — e.g. 2026-07-11 msgs 41031/41041),
          -- SUM would count each direction twice and inflate 'attributed'
          -- past the day total. A given direction is written once per report, so
          -- MAX yields its single value — and still merges multipart posts,
          -- where each direction lives in exactly one part.
          MAX(d.attacks * 1.0 / d.attacks_group_size) AS attacks
        FROM best_per_date b
        LEFT JOIN latest_posts p
          ON p.source = b.source AND p.date = b.date AND p.snapshot_at = b.snapshot_at
        LEFT JOIN directions d
          ON d.source = p.source AND d.source_id = p.source_id AND d.scraped_at = p.scraped_at
        -- b.snapshot_at is functionally dependent on b.date (best_per_date is
        -- one row per date), so grouping by it splits nothing; it's listed to
        -- carry the value out rather than rely on a bare column.
        GROUP BY b.date, b.snapshot_at, d.direction
        ORDER BY b.date ASC
      `;
      const rows = (await worker.db.query(sql)) as Record<string, unknown>[];

      // Pivot to one row per date.
      const byDate = new Map<string, GsuaDirectionCoverageRow>();
      for (const r of rows) {
        const date = String(r.date);
        const total = typeof r.total === "number" ? r.total : null;
        let row = byDate.get(date);
        if (!row) {
          row = {
            date, total, attributed: 0, unattributed: 0,
            byDirection: {},
            snapshot_at: typeof r.snapshot_at === "string" ? r.snapshot_at : null,
            is_today: date === todayStr,
          };
          byDate.set(date, row);
        }
        // Key by AXIS, not raw direction: the two halves of a jointly-reported
        // pair land on the same key and re-add to the figure the report gave
        // (0.5 + 0.5 = 1). `attributed` is unaffected — folding two rows into
        // one changes which bucket the credit lands in, not how much there is.
        const raw = r.direction == null ? null : String(r.direction);
        const dir = raw == null ? null : directionAxis(raw);
        const attacks = typeof r.attacks === "number" ? r.attacks : 0;
        if (dir && attacks > 0) {
          row.byDirection[dir] = (row.byDirection[dir] ?? 0) + attacks;
          row.attributed += attacks;
          // The fold happened on this date, so the line was joint here. Only
          // the folded-away member trips this, so it records once per axis.
          if (raw !== dir) (row.mergedAxes ??= []).push(dir);
        }
      }
      for (const row of byDate.values()) {
        row.unattributed = row.total == null ? 0 : Math.max(0, row.total - row.attributed);
      }
      return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
    },
    [worker]
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
      return pivotCoverageMonthly([...settled, ...recent]);
    },
    [worker, hasTable]
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
    queryDirectionCoverage, queryDirectionCoverageMonthly,
    refresh, lastRefreshed, refreshCount,
    refreshIntervalMs,
  };
}
