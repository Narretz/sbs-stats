import { useCallback } from "react";
import type { Database } from "sql.js";
import type {
  RubikonCategoryKey, RubikonCounterRow, RubikonKind,
  RubikonEpisodeCategoryKey, RubikonEpisodeKind, RubikonEpisodeRow,
} from "@/types";
import { makeResourceCache, useRefreshableResource } from "@/hooks/useRefreshableResource";
import { loadWholeDb, queryRows } from "@/hooks/sqlLoader";

// Tiny DB (two posts a month) → fetch whole via sql.js, same shape as
// useDatabaseSbuAlfa. Served from R2 in production and from ./data/ by the
// vite dev middleware locally.
//
// One DB, TWO independent series (see src/types RUBIKON_* comments and
// scripts/rubikon/README.md): `report_type='monthly'` is the General-Staff-plan
// recap, `report_type='monthly_digest'` is the count of strike videos the
// channel published. Both sites share this hook — the module-level cache means
// the DB is still fetched once.
const DB_URL =
  import.meta.env.VITE_RUBIKON_DB_URL ?? `${import.meta.env.BASE_URL}data/rubikon.db`;
const loadDatabase = () => loadWholeDb(DB_URL, "Rubikon");

const dbCache = makeResourceCache<Database>();

// The source publishes once a month; CI polls it daily across the publication
// window. A 24h client refresh is more than enough.
export const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function useDatabaseRubikon({ enabled = true }: { enabled?: boolean } = {}) {
  const { resource: db, loadState, error, lastRefreshed, refresh, refreshCount, refreshIntervalMs } =
    useRefreshableResource({
      cache: dbCache,
      load: loadDatabase,
      refreshIntervalMs: REFRESH_INTERVAL_MS,
      enabled,
    });

  // Long-table rows: one per (period, category). `counters_latest` /
  // `reports_latest` resolve the latest scraped_at per Telegram post — the
  // storage model is append-on-edit, so a re-scraped (edited) post inserts new
  // rows and the older version lingers but is filtered out here.
  //
  // `report_type = 'monthly'` is belt-and-braces: the ingest only ever stores
  // recaps, but the gate keeps a future non-recap row (e.g. the channel's
  // multi-month cumulative totals) out of a monthly axis.
  const queryCounters = useCallback((): RubikonCounterRow[] => {
    if (!db) return [];
    const sql = `
      SELECT r.period    AS period,
             c.category  AS category,
             c.kind      AS kind,
             c.value     AS value,
             c.raw_label AS raw_label,
             r.url       AS url,
             r.posted_at AS posted_at
      FROM counters_latest c
      JOIN reports_latest r USING (post_id, scraped_at)
      WHERE r.report_type = 'monthly'
        AND r.period IS NOT NULL
      ORDER BY r.period ASC, c.category ASC`;
    return queryRows<Record<string, unknown>>(db, sql).map((r) => ({
      period: String(r.period),
      category: r.category as RubikonCategoryKey,
      kind: r.kind as RubikonKind,
      value: Number(r.value),
      raw_label: r.raw_label == null ? null : String(r.raw_label),
      url: String(r.url),
      posted_at: String(r.posted_at),
    }));
  }, [db]);

  // The «Итоги» published-episode series. Same table, different report_type.
  //
  // NOT WIRED TO ANY PAGE. The ingest stores this series, and this is its read
  // path, kept so the data stays reachable and re-adding a view is trivial —
  // but nothing renders it today. It counts strike videos the channel
  // published (the tally Lostarmour keeps from those videos), which is a
  // different measure from the recap and too spotty to present as-is: 13
  // months, one missing, per-category detail for only 6, three headline
  // figures that are floors. If we want it, take it from Lostarmour directly.
  //
  // The CTE deduplicates by period: Rubikon posted November 2025 twice within
  // the same minute (posts 786 and 787, identical figures, different leading
  // emoji). Both are real posts and both are stored — picking the lowest
  // post_id per period keeps the read deterministic without deleting either.
  const queryEpisodes = useCallback((): RubikonEpisodeRow[] => {
    if (!db) return [];
    const sql = `
      WITH pick AS (
        SELECT period, MIN(post_id) AS post_id
        FROM reports_latest
        WHERE report_type = 'monthly_digest' AND period IS NOT NULL
        GROUP BY period
      )
      SELECT r.period    AS period,
             c.category  AS category,
             c.kind      AS kind,
             c.value     AS value,
             c.bound     AS bound,
             c.raw_label AS raw_label,
             r.url       AS url,
             r.posted_at AS posted_at
      FROM counters_latest c
      JOIN reports_latest r USING (post_id, scraped_at)
      JOIN pick p ON p.post_id = r.post_id
      ORDER BY r.period ASC, c.category ASC`;
    return queryRows<Record<string, unknown>>(db, sql).map((r) => ({
      period: String(r.period),
      category: r.category as RubikonEpisodeCategoryKey,
      kind: r.kind as RubikonEpisodeKind,
      value: Number(r.value),
      bound: r.bound === "at_least" ? "at_least" : "exact",
      raw_label: r.raw_label == null ? null : String(r.raw_label),
      url: String(r.url),
      posted_at: String(r.posted_at),
    }));
  }, [db]);

  const windowFor = useCallback((reportType: string) => {
    if (!db) return { minPeriod: null, maxPeriod: null };
    const rows = queryRows<{ minPeriod: string | null; maxPeriod: string | null }>(
      db,
      `SELECT MIN(period) AS minPeriod, MAX(period) AS maxPeriod
       FROM reports_latest WHERE report_type = '${reportType}'`
    );
    return rows[0] ?? { minPeriod: null, maxPeriod: null };
  }, [db]);

  const queryDataWindow = useCallback(() => windowFor("monthly"), [windowFor]);
  const queryEpisodeDataWindow = useCallback(() => windowFor("monthly_digest"), [windowFor]);

  return {
    loadState, error,
    queryCounters, queryDataWindow,
    queryEpisodes, queryEpisodeDataWindow,
    refresh, lastRefreshed, refreshCount,
    refreshIntervalMs,
  };
}
