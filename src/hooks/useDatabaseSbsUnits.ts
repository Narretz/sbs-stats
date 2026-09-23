import { useCallback } from "react";
import type { Database } from "sql.js";
import type { MonthlyRow, SbsUnit, StatKey } from "@/types";
import { TARGET_IDS } from "@/types";
import { makeResourceCache, useRefreshableResource } from "@/hooks/useRefreshableResource";
import { getKyivDateString, loadWholeDb, queryRows } from "@/hooks/sqlLoader";

// Separate DB from sbs.db on purpose: that one is fetched whole by every SBS
// page including the hourly one, and this is read only by the monthly view
// (and, later, compare / combined). See scripts/sbs_units/README.md.
const DB_URL = import.meta.env.VITE_SBS_UNITS_DB_URL ?? "/data/sbs-units.db";
const loadDatabase = () => loadWholeDb(DB_URL, "SBS units");

const dbCache = makeResourceCache<Database>();

// Matches the ingest's cadence rather than sbs.db's: the workflow writes twice
// a day, so a 10-minute poll would be 143 wasted fetches out of 144.
export const REFRESH_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

const BASE_COLS: StatKey[] = [
  "personnel_killed",
  "personnel_wounded",
  "total_targets_hit",
  "total_targets_destroyed",
  "total_personnel_casualties",
  "flights_strike",
  "flights_recon",
];

function getTableColumns(db: Database, table: string): string[] {
  const result = db.exec(`PRAGMA table_info(${table})`);
  if (!result.length) return [];
  return result[0].values.map((row) => row[1] as string);
}

// Project every StatKey the app knows about, substituting 0 for columns this DB
// doesn't carry — same contract sbs.db's hook provides, so a unit row is
// structurally a MonthlyRow and every existing chart accepts it unchanged.
function buildStatColumns(available: string[]): string {
  const dynamic = TARGET_IDS.flatMap((id) => [
    `hit_${id}` as StatKey,
    `destroyed_${id}` as StatKey,
  ]);
  return [...BASE_COLS, ...dynamic]
    .map((col) => {
      // Flights are genuinely absent on some rows rather than zero; keeping
      // NULL lets the charts distinguish "no sorties" from "not reported",
      // exactly as the SBS hook does.
      if (col === "flights_strike" || col === "flights_recon") {
        return available.includes(col) ? `${col} AS ${col}` : `NULL AS ${col}`;
      }
      return available.includes(col) ? `COALESCE(${col}, 0) AS ${col}` : `0 AS ${col}`;
    })
    .join(", ");
}

// Latest capture wins. `capture_bucket` is a date string, so MAX() on it is
// chronological — that is the whole reason the version key is a date and not,
// say, an incrementing counter.
function latestPerBucket(table: string, statCols: string, where: string): string {
  return `
    SELECT t.unit_slug, t.date, ${statCols}
    FROM ${table} t
    INNER JOIN (
      SELECT unit_slug, date, MAX(capture_bucket) AS latest
      FROM ${table}
      GROUP BY unit_slug, date
    ) l ON l.unit_slug = t.unit_slug AND l.date = t.date
       AND l.latest = t.capture_bucket
    WHERE ${where}
    ORDER BY t.date ASC
  `;
}

export function useDatabaseSbsUnits({ enabled = true }: { enabled?: boolean } = {}) {
  const { resource: db, loadState, error, lastRefreshed, refresh, refreshCount, refreshIntervalMs } =
    useRefreshableResource({
      cache: dbCache,
      load: loadDatabase,
      refreshIntervalMs: REFRESH_INTERVAL_MS,
      enabled,
    });

  // ── The unit registry ──────────────────────────────────────────────────────
  // Units with no stored months are excluded here rather than in the picker:
  // an option that resolves to an empty chart is worse than no option, and the
  // ingest already refuses to track them (1 ОЦ БПС, whose endpoints are dead).
  const queryUnits = useCallback((): SbsUnit[] => {
    if (!db) return [];
    return queryRows<Record<string, unknown>>(
      db,
      `SELECT u.* FROM units u
       WHERE EXISTS (SELECT 1 FROM unit_monthly_stats m WHERE m.unit_slug = u.slug)
       ORDER BY CAST(COALESCE(u.display_order, 999) AS INTEGER), u.slug`,
    ).map((r) => ({
      slug: String(r.slug),
      subdivision_id: String(r.subdivision_id),
      division_id: r.division_id == null ? null : String(r.division_id),
      title_uk: r.title_uk == null ? null : String(r.title_uk),
      title_en: r.title_en == null ? null : String(r.title_en),
      color: r.color == null ? null : String(r.color),
      display_order: r.display_order == null ? null : Number(r.display_order),
      active: Number(r.active) === 1,
      first_month: r.first_month == null ? null : String(r.first_month),
      last_month: r.last_month == null ? null : String(r.last_month),
    }));
  }, [db]);

  // ── Monthly, for one unit ──────────────────────────────────────────────────
  // Returns MonthlyRow, current-month projection included, so SbsMonthlyPage
  // can swap its data source without touching a single chart.
  const queryMonthly = useCallback((unitSlug: string): MonthlyRow[] => {
    if (!db || !unitSlug) return [];
    const statCols = buildStatColumns(getTableColumns(db, "unit_monthly_stats"));
    const kyivDateStr = getKyivDateString();
    const currentMonth = kyivDateStr.slice(0, 7);
    const dayOfMonth = parseInt(kyivDateStr.slice(8, 10));
    const [y, m] = currentMonth.split("-").map(Number);
    const daysInMonth = new Date(y, m, 0).getDate();

    const safeSlug = unitSlug.replace(/'/g, "''");
    const rows = queryRows<Record<string, unknown>>(
      db,
      latestPerBucket("unit_monthly_stats", statCols, `t.unit_slug = '${safeSlug}'`),
    );

    return rows.map((row) => {
      // The stored date is "YYYY-MM-01" (the column is typed DATE); the app's
      // monthly contract is "YYYY-MM". Spread first so the raw `date` can't
      // clobber the sliced one — the same trap the SBS hook documents.
      const dateStr = String(row["date"]).slice(0, 7);
      const isCurrentMonth = dateStr === currentMonth;
      const typedRow: MonthlyRow = {
        ...(row as unknown as Record<StatKey, number>),
        date: dateStr,
        is_current_month: isCurrentMonth,
        projection_day: isCurrentMonth ? dayOfMonth : null,
        projection_days_in_month: isCurrentMonth ? daysInMonth : null,
      };
      if (isCurrentMonth) {
        const multiplier = daysInMonth / dayOfMonth;
        const keys: StatKey[] = [
          ...BASE_COLS,
          ...TARGET_IDS.flatMap((id) => [`hit_${id}` as StatKey, `destroyed_${id}` as StatKey]),
        ];
        for (const key of keys) {
          const raw = row[key];
          if (typeof raw === "number") {
            typedRow[`${key}_projected`] = Math.round(raw * multiplier);
          }
        }
      }
      return typedRow;
    });
  }, [db]);

  // ── Covered range, for the page header's freshness note ────────────────────
  // The two ends come from different tables on purpose. `minDate` is the start
  // of coverage, which is a monthly question — the monthly backfill reaches
  // back a year and the daily series only starts when the ingest was switched
  // on. `maxDate` drives DataWindow's freshness wording, which is a daily
  // question: month-granular dates would read as a fortnight stale on the 15th.
  //
  // A retired unit has no daily rows, so it falls back to its last month and
  // is reported as far behind — which is exactly true of a unit that stopped.
  const queryDataWindow = useCallback(
    (unitSlug: string): { minDate: string | null; maxDate: string | null } => {
      if (!db || !unitSlug) return { minDate: null, maxDate: null };
      const safeSlug = unitSlug.replace(/'/g, "''");
      const rows = queryRows<{ minDate: string | null; maxDate: string | null }>(
        db,
        `SELECT
           (SELECT MIN(date) FROM unit_monthly_stats WHERE unit_slug = '${safeSlug}') AS minDate,
           COALESCE(
             (SELECT MAX(date) FROM unit_daily_stats   WHERE unit_slug = '${safeSlug}'),
             (SELECT MAX(date) FROM unit_monthly_stats WHERE unit_slug = '${safeSlug}')
           ) AS maxDate`,
      );
      return rows[0] ?? { minDate: null, maxDate: null };
    },
    [db],
  );

  return {
    loadState, error,
    queryUnits, queryMonthly, queryDataWindow,
    refresh, lastRefreshed, refreshCount, refreshIntervalMs,
  };
}
