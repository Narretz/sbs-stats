import { useCallback } from "react";
import type { Database } from "sql.js";
import type {
  CitDailyRow,
  CitReconciliation,
  CitGlobalStats,
  CitMetricKey,
  CitMonthlyRow,
  CitRegionRow,
  CitTerritoryRow,
} from "@/types";
import { CIT_METRIC_KEYS } from "@/types";
import { makeResourceCache, useRefreshableResource } from "@/hooks/useRefreshableResource";
import { loadWholeDb, queryRows } from "@/hooks/sqlLoader";
import { windowStartSql } from "@/utils/dayRange";

// Fetched whole via sql.js, like the RU-losses / UA-losses / Mediazona
// loaders. In production that points at the stripped `.app.db` (raw post text
// and the per-clause audit labels blanked, 11 MB → 2.1 MB); the authoritative
// copy keeps them so `ingest.py --reparse` can re-read stored posts.
//
// Dev reads the FULL db, unlike GSUA and RU MoD. Those range-fetch, so their
// dev copy has to match production byte-for-byte or local behaviour diverges;
// this one is a whole fetch, where the only difference is download size — and
// reading the full file locally removes the trap where a reparse rewrites
// `<name>.db` and dev keeps serving a stale app copy built from it.
const DB_URL =
  import.meta.env.VITE_CIT_DB_URL ??
  `${import.meta.env.BASE_URL}data/cit-civilians.db`;
const loadDatabase = () => loadWholeDb(DB_URL, "CIT civilians");

const dbCache = makeResourceCache<Database>();

// CIT reports on Moscow time (the 20:00–20:00 window is MSK), so "today" here
// is the Moscow date — not Kyiv, as on the GSUA/SBS datasets.
function getMskDateString(): string {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Moscow" });
}

export const REFRESH_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

// `reports` is append-on-change: a post CIT later edits gets a second row. The
// `*_latest` views in the DB already resolve the newest `scraped_at` per post,
// so every read below goes through them rather than the base tables.

export function useDatabaseCitCivilians({ enabled = true }: { enabled?: boolean } = {}) {
  const { resource: db, loadState, error, lastRefreshed, refresh, refreshCount, refreshIntervalMs } =
    useRefreshableResource({
      cache: dbCache,
      load: loadDatabase,
      refreshIntervalMs: REFRESH_INTERVAL_MS,
      enabled,
    });

  // ── Daily: the post's own headline figures, one row per covered day ────────
  //
  // Weekend days arrive as ONE 48-hour post, so a weekend report is expanded
  // into its two calendar days at half its total each. That is an average, not
  // a measurement — every expanded row keeps `window_days = 2` so the page can
  // mark the point and put the real 48-hour figures in its tooltip. Spreading
  // happens here and never in the DB, which keeps the source's own numbers
  // intact for anything else reading it.
  const queryDaily = useCallback(
    (days: number, endDate?: string): CitDailyRow[] => {
      if (!db) return [];
      const todayStr = getMskDateString();
      const endDateSql = endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate) ? endDate : todayStr;
      // Fetch one day beyond the window start so a weekend report whose second
      // day is the first day of the window still contributes that day.
      const sql = `
        SELECT report_date, killed, injured, window_days, reconciled
        FROM daily_stated
        WHERE report_date >= date(${windowStartSql(endDateSql, days)}, '-1 day')
          AND report_date <= date('${endDateSql}')
        ORDER BY report_date ASC
      `;
      const out: CitDailyRow[] = [];
      for (const row of queryRows<Record<string, unknown>>(db, sql)) {
        const endDay = String(row.report_date);
        const span = typeof row.window_days === "number" ? row.window_days : 1;
        const reconciled =
          row.reconciled === null || row.reconciled === undefined
            ? null
            : row.reconciled === 1;
        for (let back = span - 1; back >= 0; back--) {
          const date = shiftDate(endDay, -back);
          if (date < windowStartDateOf(endDateSql, days) || date > endDateSql) continue;
          out.push({
            date,
            report_date: endDay,
            is_today: date === todayStr,
            window_days: span,
            reconciled,
            ...(CIT_METRIC_KEYS.reduce((acc, k) => {
              const v = row[k];
              acc[k] = typeof v === "number" ? v / span : null;
              return acc;
            }, {} as Record<CitMetricKey, number | null>)),
          } as CitDailyRow);
        }
      }
      return out;
    },
    [db]
  );

  // ── Global stats: max + median + total per metric across ALL covered days ──
  // Computed on the same per-day basis as the chart, so a weekend's 48-hour
  // figure can't masquerade as a record single day. The totals are unaffected
  // by the spreading — two halves sum to the whole.
  const queryGlobalStats = useCallback((): CitGlobalStats => {
    if (!db) return {} as CitGlobalStats;
    const rows = queryRows<Record<string, number>>(
      db,
      "SELECT killed, injured, window_days FROM daily_stated"
    );
    const result = {} as CitGlobalStats;
    for (const key of CIT_METRIC_KEYS) {
      const perDay: number[] = [];
      let total = 0;
      for (const r of rows) {
        const v = r[key];
        if (typeof v !== "number") continue;
        const span = typeof r.window_days === "number" ? r.window_days : 1;
        total += v;
        for (let i = 0; i < span; i++) perDay.push(v / span);
      }
      perDay.sort((a, b) => a - b);
      result[key] = {
        max: perDay.length ? perDay[perDay.length - 1] : 0,
        median: perDay.length ? perDay[Math.floor(perDay.length / 2)] : 0,
        total,
      };
    }
    return result;
  }, [db]);

  // ── Monthly: sum of the headline figures per month ────────────────────────
  // Bucketed by `report_date`, the window's END date. A Friday-to-Sunday
  // weekend window can straddle a month boundary a few times a year; those
  // land wholly in the month their end date falls in rather than being split.
  // `covered_days` counts the days those reports actually cover, so a partial
  // month reads as partial instead of as a quiet one.
  const queryMonthly = useCallback((): CitMonthlyRow[] => {
    if (!db) return [];
    const rows = queryRows<Record<string, number | string>>(
      db,
      `SELECT substr(report_date, 1, 7) AS month,
              SUM(killed)  AS killed,
              SUM(injured) AS injured,
              SUM(window_days) AS covered_days
       FROM daily_stated
       GROUP BY month
       ORDER BY month ASC`
    );

    const mskDateStr = getMskDateString();
    const currentMonth = mskDateStr.slice(0, 7);
    const dayOfMonth = parseInt(mskDateStr.slice(8, 10), 10);
    const [y, m] = currentMonth.split("-").map(Number);
    const daysInMonth = new Date(y, m, 0).getDate();

    return rows.map((row) => {
      const month = String(row.month);
      const isCurrent = month === currentMonth;
      return {
        date: month,
        is_current_month: isCurrent,
        projection_day: isCurrent ? dayOfMonth : null,
        projection_days_in_month: isCurrent ? daysInMonth : null,
        covered_days: typeof row.covered_days === "number" ? row.covered_days : 0,
        ...(CIT_METRIC_KEYS.reduce((acc, k) => {
          acc[k] = typeof row[k] === "number" ? (row[k] as number) : 0;
          return acc;
        }, {} as Record<CitMetricKey, number>)),
      } as CitMonthlyRow;
    });
  }, [db]);

  // ── Regions: the secondary breakdown ──────────────────────────────────────
  //
  // From `casualties`, NOT from the headline — these are the per-region rows,
  // which reconcile with the post's own total on ~56% of posts. `adjustment`
  // rows are excluded: they are corrections the source itself leaves out of its
  // daily figure (retractions, restatements, and our own −1 injured when
  // someone already counted as injured has died), so including them here would
  // net a region's total against a different basis than the day charts use.
  const queryRegions = useCallback(
    (sinceDate?: string): CitRegionRow[] => {
      if (!db) return [];
      const where = sinceDate && /^\d{4}-\d{2}-\d{2}$/.test(sinceDate)
        ? `AND event_date >= '${sinceDate}'`
        : "";
      return queryRows<Record<string, unknown>>(
        db,
        `SELECT region_key, occupied, country,
                SUM(killed)  AS killed,
                SUM(injured) AS injured
         FROM casualties_latest
         WHERE kind IN ('daily', 'amendment') ${where}
         GROUP BY region_key, occupied
         ORDER BY (SUM(killed) + SUM(injured)) DESC`
      ).map((r) => ({
        region_key: String(r.region_key),
        occupied: r.occupied === null || r.occupied === undefined ? null : r.occupied === 1,
        country: r.country === null || r.country === undefined ? null : String(r.country),
        killed: typeof r.killed === "number" ? r.killed : 0,
        injured: typeof r.injured === "number" ? r.injured : 0,
      }));
    },
    [db]
  );

  // ── Territory: casualties by which side controls the ground ──────────────
  //
  // Killed and injured summed, because the question here is where people are
  // being hurt, not how. Like the region table this reads the breakdown rows
  // rather than the headline, so it inherits their accuracy — see
  // queryReconciliation.
  //
  // Bucketed by the REPORT's month (its window end date), the same key the
  // monthly headline charts use, so the two line up. `event_date` would be the
  // alternative but it is NULL on corrections naming several dates at once.
  const queryTerritory = useCallback((): CitTerritoryRow[] => {
    if (!db) return [];
    return queryRows<Record<string, number | string>>(
      db,
      `SELECT substr(r.report_date, 1, 7) AS month,
              SUM(CASE WHEN c.country = 'UA' AND c.occupied = 0
                       THEN c.killed + c.injured ELSE 0 END) AS uaControlled,
              SUM(CASE WHEN c.country = 'UA' AND c.occupied = 1
                       THEN c.killed + c.injured ELSE 0 END) AS occupiedUkraine,
              SUM(CASE WHEN c.country = 'RU'
                       THEN c.killed + c.injured ELSE 0 END) AS russia,
              SUM(CASE WHEN c.country IS NULL
                       THEN c.killed + c.injured ELSE 0 END) AS unattributed
       FROM casualties_latest c
       JOIN reports_latest r
         ON r.post_id = c.post_id AND r.scraped_at = c.scraped_at
       WHERE c.kind IN ('daily', 'amendment')
       GROUP BY month
       ORDER BY month ASC`
    ).map((row) => {
      const num = (k: string) => (typeof row[k] === "number" ? (row[k] as number) : 0);
      const occupiedUkraine = num("occupiedUkraine");
      const russia = num("russia");
      return {
        date: String(row.month),
        uaControlled: num("uaControlled"),
        ruControlled: occupiedUkraine + russia,
        occupiedUkraine,
        russia,
        unattributed: num("unattributed"),
      };
    });
  }, [db]);

  // How far the region breakdown can be trusted. Surfaced on the page rather
  // than buried, because it is what says how much weight the region table
  // carries — and because one number would misrepresent it. The strict test
  // (both columns exact) passes about half the time, but the killed column
  // alone is exact far more often and the whole breakdown lands within ~1% of
  // the stated totals in aggregate. A reader deserves all three.
  const queryReconciliation = useCallback((): CitReconciliation => {
    const empty: CitReconciliation = {
      reports: 0, bothExact: 0, killedExact: 0, killedDriftPct: 0, injuredDriftPct: 0,
    };
    if (!db) return empty;
    const rows = queryRows<Record<string, number>>(
      db,
      `SELECT COUNT(*) AS reports,
              COALESCE(SUM(reconciled), 0) AS bothExact,
              SUM(CASE WHEN stated_killed = sum_killed THEN 1 ELSE 0 END) AS killedExact,
              COALESCE(SUM(stated_killed), 0)  AS statedKilled,
              COALESCE(SUM(sum_killed), 0)     AS parsedKilled,
              COALESCE(SUM(stated_injured), 0) AS statedInjured,
              COALESCE(SUM(sum_injured), 0)    AS parsedInjured
       FROM reports_latest WHERE reconciled IS NOT NULL`
    );
    const r = rows[0];
    if (!r || !r.reports) return empty;
    const pct = (parsed: number, stated: number) =>
      stated ? (100 * (parsed - stated)) / stated : 0;
    return {
      reports: r.reports,
      bothExact: r.bothExact,
      killedExact: r.killedExact,
      killedDriftPct: pct(r.parsedKilled, r.statedKilled),
      injuredDriftPct: pct(r.parsedInjured, r.statedInjured),
    };
  }, [db]);

  // Full covered date range, for the freshness note. The earliest covered day
  // is the first report's window start, not its report_date — a weekend report
  // covers the day before it too.
  const queryDataWindow = useCallback((): { minDate: string | null; maxDate: string | null } => {
    if (!db) return { minDate: null, maxDate: null };
    const rows = queryRows<{ minDate: string | null; maxDate: string | null }>(
      db,
      `SELECT MIN(date(report_date, '-' || (window_days - 1) || ' days')) AS minDate,
              MAX(report_date) AS maxDate
       FROM reports_latest`
    );
    return rows[0] ?? { minDate: null, maxDate: null };
  }, [db]);

  return {
    loadState, error,
    queryDaily, queryGlobalStats, queryMonthly, queryRegions, queryTerritory,
    queryReconciliation,
    queryDataWindow,
    refresh, lastRefreshed, refreshCount,
    refreshIntervalMs,
  };
}

// Local date helpers — the daily expansion works in plain YYYY-MM-DD strings,
// so it needs no timezone handling of its own.
function shiftDate(iso: string, deltaDays: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

function windowStartDateOf(endDate: string, days: number): string {
  return shiftDate(endDate, -(days - 1));
}
