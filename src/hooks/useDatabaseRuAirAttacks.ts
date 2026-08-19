import { useCallback } from "react";
import type { Database } from "sql.js";
import type {
  RuAirAttacksDailyRow,
  RuAirAttacksGlobalStats,
  RuAirAttacksMonthlyRow,
  RuAirAttacksModelDailyRow,
  RuAirAttacksModelMonthlyRow,
  AttackCategoryKey,
  AttackDbCategory,
  ModelBreakdownEntry,
} from "@/types";
import { ATTACK_CATEGORY_KEYS, ATTACK_CATEGORY_LABELS, ATTACK_DB_CATEGORIES } from "@/types";
import { makeResourceCache, useRefreshableResource } from "@/hooks/useRefreshableResource";
import { windowStartSql } from "@/utils/dayRange";

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
  const db = new SQL.Database(bytes);
  installDisclosureAwareViews(db);
  return db;
}

// piterfm added a `status_data` column in Aug 2026. A row flagged `'hidden'` is
// an attack the Ukrainian Air Force reported *without* disclosing counts — it
// stopped publishing ballistic missile launched/intercepted figures on
// 2026-08-13 — and the CSV carries a placeholder `0`, which is
// indistinguishable from a real zero once summed. The DB's own aggregate views
// sum it, so redefine them over our in-memory copy (never written back to R2):
// hidden rows contribute NULL instead of 0, and each group carries a `hidden`
// count so the UI can render "not disclosed" rather than draw a zero.
//
// Doing this once at load keeps every downstream query correct without each
// one restating the CASE. DBs built before the column existed — including the
// e2e fixtures — get the same views with `hidden` pinned to 0, so the query
// surface is identical either way.
function installDisclosureAwareViews(db: Database): void {
  const cols = db.exec("PRAGMA table_info(missile_attacks)");
  const nameIdx = cols[0]?.columns.indexOf("name") ?? -1;
  const hasStatus =
    nameIdx >= 0 && (cols[0]?.values ?? []).some((r) => r[nameIdx] === "status_data");

  const isHidden = hasStatus ? "status_data = 'hidden'" : "0";
  const known = (c: string) => `SUM(CASE WHEN ${isHidden} THEN NULL ELSE ${c} END)`;
  const hiddenCount = `SUM(CASE WHEN ${isHidden} THEN 1 ELSE 0 END)`;

  db.run(`
    DROP VIEW IF EXISTS daily_by_category;
    CREATE VIEW daily_by_category AS
      SELECT attack_date AS date, category,
             ${known("launched")}  AS launched,
             ${known("destroyed")} AS destroyed,
             ${hiddenCount}        AS hidden
      FROM missile_attacks_latest
      GROUP BY attack_date, category;

    DROP VIEW IF EXISTS daily_by_model;
    CREATE VIEW daily_by_model AS
      SELECT attack_date AS date, model,
             ${known("launched")}  AS launched,
             ${known("destroyed")} AS destroyed,
             ${hiddenCount}        AS hidden
      FROM missile_attacks_latest
      GROUP BY attack_date, model;

    DROP VIEW IF EXISTS daily_by_model_category;
    CREATE VIEW daily_by_model_category AS
      SELECT attack_date AS date, category, model,
             ${known("launched")}  AS launched,
             ${known("destroyed")} AS destroyed,
             ${hiddenCount}        AS hidden
      FROM missile_attacks_latest
      GROUP BY attack_date, category, model;
  `);
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

type CategoryRow = {
  date: string; category: string;
  launched: number | null; destroyed: number | null;
  // Rows in this (date, category) group whose counts upstream withheld. The
  // view nulls their contribution, so `launched`/`destroyed` are null when
  // *nothing* was disclosed and a partial sum when only some rows were.
  hidden?: number | null;
};

function num(v: number | null | undefined): number {
  return typeof v === "number" ? v : 0;
}

// One breakdown row. `undisclosed` marks the case where every row behind the
// entry was withheld, so its 0 is a placeholder rather than a count.
function breakdownEntry(
  model: string,
  r: { launched: number | null; destroyed: number | null; hidden?: number | null },
): ModelBreakdownEntry {
  const entry: ModelBreakdownEntry = {
    model,
    launched: num(r.launched),
    intercepted: num(r.destroyed),
  };
  if (num(r.hidden) > 0 && r.launched === null) entry.undisclosed = true;
  return entry;
}

// Pivot the long `daily_by_category` rows into one wide row per date with
// launched/intercepted for each category + a computed "all" (sum of every
// category, including the small "other" bucket that has no chart of its own).
//
// Categories are zero-filled across every date that has any attack at all, so
// a drones-only day charts cruise/ballistic as a real 0. The exception is a
// category upstream withheld: that stays null so the chart draws a gap, since
// "we aren't told" is not "none were launched".
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
    const withheld = num(r.hidden) > 0;
    const l = typeof r.launched === "number" ? r.launched : null;
    const d = typeof r.destroyed === "number" ? r.destroyed : null;
    // `all` accumulates only what was disclosed — a lower bound on withheld
    // days rather than a gap, since drones dominate it and blanking the
    // headline series over a handful of undisclosed missiles would mislead
    // more than it corrects. `undisclosed` is what marks it as a lower bound.
    row.all_launched = num(row.all_launched) + num(l);
    row.all_intercepted = num(row.all_intercepted) + num(d);
    const cat = String(r.category) as (typeof ATTACK_DB_CATEGORIES)[number];
    if ((ATTACK_DB_CATEGORIES as readonly string[]).includes(cat)) {
      row[`${cat}_launched`] = withheld && l === null ? null : num(row[`${cat}_launched`]) + num(l);
      row[`${cat}_intercepted`] = withheld && d === null ? null : num(row[`${cat}_intercepted`]) + num(d);
      if (withheld) row.undisclosed = [...(row.undisclosed ?? []), cat];
    }
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function maxMedian(values: Array<number | null>): { max: number; median: number; total: number } {
  const vals = values.filter((v): v is number => typeof v === "number").sort((a, b) => a - b);
  return {
    max: vals.length ? vals[vals.length - 1] : 0,
    median: vals.length ? vals[Math.floor(vals.length / 2)] : 0,
    total: vals.reduce((s, n) => s + n, 0),
  };
}

// piterfm re-publishes the Kaggle dataset roughly weekly; hourly polling is plenty.
export const REFRESH_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export function useDatabaseRuAirAttacks({ enabled = true }: { enabled?: boolean } = {}) {
  const { resource: db, loadState, error, lastRefreshed, refresh, refreshCount, refreshIntervalMs } =
    useRefreshableResource({
      cache: dbCache,
      load: loadDatabase,
      refreshIntervalMs: REFRESH_INTERVAL_MS,
      enabled,
    });

  // ── Daily: launched + intercepted per category, attributed to time_start date ─
  const queryDaily = useCallback(
    (days: number, endDate?: string): RuAirAttacksDailyRow[] => {
      if (!db) return [];
      const todayStr = getKyivDateString();
      const endDateSql = endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate) ? endDate : todayStr;
      const sql = `
        SELECT date, category, launched, destroyed, hidden
        FROM daily_by_category
        WHERE date >= ${windowStartSql(endDateSql, days)}
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
      queryRows<CategoryRow>(db, `SELECT date, category, launched, destroyed, hidden FROM daily_by_category`),
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
    const raw = queryRows<{ month: string; category: string; launched: number | null; destroyed: number | null; hidden: number | null }>(
      db,
      `SELECT substr(date, 1, 7) AS month, category,
              SUM(launched) AS launched, SUM(destroyed) AS destroyed,
              SUM(hidden)   AS hidden
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
        // Months keep their partial sum — some days in the month were still
        // disclosed — and carry the flag so the bar reads as a lower bound.
        if (num(r.hidden) > 0) row.undisclosed = [...(row.undisclosed ?? []), cat];
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

  // ── Per-model daily: one row per date with launched + intercepted for the
  // given `model` (exact match on the DB's `model` column — bundled rows like
  // "X-101/X-555 and Kalibr" don't fold into individual model charts).
  //
  // Left-joined against the set of dates that appear in `daily_by_category` so
  // days with attacks in other categories but none for this model render as 0
  // (parity with the per-category charts, whose pivot zero-fills cross-
  // category). Days with no data at all stay absent → the trailing-pad utility
  // can render them as visibly missing instead of as zeros.
  const queryDailyByModel = useCallback(
    (model: string, days: number, endDate?: string): RuAirAttacksModelDailyRow[] => {
      if (!db) return [];
      const todayStr = getKyivDateString();
      const endDateSql = endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate) ? endDate : todayStr;
      const safeModel = model.replace(/'/g, "''");
      const sql = `
        SELECT d.date,
               CASE WHEN m.hidden > 0 AND m.launched  IS NULL THEN NULL ELSE COALESCE(m.launched, 0)  END AS launched,
               CASE WHEN m.hidden > 0 AND m.destroyed IS NULL THEN NULL ELSE COALESCE(m.destroyed, 0) END AS destroyed
        FROM (
          SELECT DISTINCT date FROM daily_by_category
          WHERE date >= ${windowStartSql(endDateSql, days)}
            AND date <= date('${endDateSql}')
        ) d
        LEFT JOIN daily_by_model m
          ON m.date = d.date AND m.model = '${safeModel}'
        ORDER BY d.date ASC
      `;
      // null survives here (rather than collapsing to 0) so a day whose only
      // rows for this model were withheld charts as a gap, same as a category.
      return queryRows<{ date: string; launched: number | null; destroyed: number | null }>(db, sql).map((r) => ({
        date: String(r.date),
        is_today: String(r.date) === todayStr,
        launched: typeof r.launched === "number" ? r.launched : null,
        intercepted: typeof r.destroyed === "number" ? r.destroyed : null,
      }));
    },
    [db]
  );

  // ── Per-model monthly: sums per calendar month, with current-month projection
  // on both launched and intercepted (same pro-rata extrapolation as the
  // per-category monthly query).
  const queryMonthlyByModel = useCallback(
    (model: string): RuAirAttacksModelMonthlyRow[] => {
      if (!db) return [];
      const safeModel = model.replace(/'/g, "''");
      const raw = queryRows<{ month: string; launched: number | null; destroyed: number | null }>(
        db,
        `SELECT substr(date, 1, 7) AS month,
                SUM(launched) AS launched, SUM(destroyed) AS destroyed
         FROM daily_by_model
         WHERE model = '${safeModel}'
         GROUP BY month
         ORDER BY month ASC`
      );

      const kyivDateStr = getKyivDateString();
      const currentMonth = kyivDateStr.slice(0, 7);
      const dayOfMonth = parseInt(kyivDateStr.slice(8, 10), 10);
      const [y, m] = currentMonth.split("-").map(Number);
      const daysInMonth = new Date(y, m, 0).getDate();

      return raw.map((r) => {
        const month = String(r.month);
        const launched = num(r.launched);
        const intercepted = num(r.destroyed);
        const isCurrent = month === currentMonth;
        const row: RuAirAttacksModelMonthlyRow = {
          date: month,
          is_current_month: isCurrent,
          projection_day: isCurrent ? dayOfMonth : null,
          projection_days_in_month: isCurrent ? daysInMonth : null,
          launched,
          intercepted,
        };
        if (isCurrent && dayOfMonth > 0) {
          const mult = daysInMonth / dayOfMonth;
          row.launched_projected = Math.round(launched * mult);
          row.intercepted_projected = Math.round(intercepted * mult);
        }
        return row;
      });
    },
    [db]
  );

  // ── Per-date model breakdown for one DB category. Used by the daily chart
  // tooltip: "what models drove this Cruise spike on 2026-03-12?". Returns
  // each date's contributing models sorted by launched DESC. Bundled "X and Y"
  // rows are returned as their literal model string (callers can decide to
  // collapse them or show them as-is).
  const queryDailyBreakdownByCategory = useCallback(
    (cat: AttackDbCategory, days: number, endDate?: string): Map<string, ModelBreakdownEntry[]> => {
      if (!db) return new Map();
      const todayStr = getKyivDateString();
      const endDateSql = endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate) ? endDate : todayStr;
      const safe = cat.replace(/'/g, "''");
      const rows = queryRows<{ date: string; model: string; launched: number | null; destroyed: number | null; hidden: number | null }>(
        db,
        `SELECT date, model, launched, destroyed, hidden
         FROM daily_by_model_category
         WHERE category = '${safe}'
           AND date >= ${windowStartSql(endDateSql, days)}
           AND date <= date('${endDateSql}')
         ORDER BY date ASC, launched DESC`
      );
      const out = new Map<string, ModelBreakdownEntry[]>();
      for (const r of rows) {
        const date = String(r.date);
        const list = out.get(date) ?? [];
        list.push(breakdownEntry(String(r.model), r));
        out.set(date, list);
      }
      return out;
    },
    [db]
  );

  // Per-date breakdown by category (drone / cruise / ballistic) for the
  // aggregate "All" chart's tooltip. Returns rows labelled with their
  // human-readable category name so they read naturally in the table.
  const queryDailyAggBreakdown = useCallback(
    (days: number, endDate?: string): Map<string, ModelBreakdownEntry[]> => {
      if (!db) return new Map();
      const todayStr = getKyivDateString();
      const endDateSql = endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate) ? endDate : todayStr;
      const rows = queryRows<{ date: string; category: string; launched: number | null; destroyed: number | null; hidden: number | null }>(
        db,
        `SELECT date, category, launched, destroyed, hidden
         FROM daily_by_category
         WHERE date >= ${windowStartSql(endDateSql, days)}
           AND date <= date('${endDateSql}')
         ORDER BY date ASC, launched DESC`
      );
      const out = new Map<string, ModelBreakdownEntry[]>();
      for (const r of rows) {
        const cat = String(r.category) as AttackDbCategory;
        if (!(ATTACK_DB_CATEGORIES as readonly string[]).includes(cat)) continue;
        const date = String(r.date);
        const list = out.get(date) ?? [];
        list.push(breakdownEntry(ATTACK_CATEGORY_LABELS[cat], r));
        out.set(date, list);
      }
      return out;
    },
    [db]
  );

  // Per-month breakdown by category for the aggregate monthly bar chart.
  const queryMonthlyAggBreakdown = useCallback(
    (): Map<string, ModelBreakdownEntry[]> => {
      if (!db) return new Map();
      const rows = queryRows<{ month: string; category: string; launched: number | null; destroyed: number | null; hidden: number | null }>(
        db,
        `SELECT substr(date, 1, 7) AS month, category,
                SUM(launched)  AS launched,
                SUM(destroyed) AS destroyed,
                SUM(hidden)    AS hidden
         FROM daily_by_category
         GROUP BY month, category
         ORDER BY month ASC, launched DESC`
      );
      const out = new Map<string, ModelBreakdownEntry[]>();
      for (const r of rows) {
        const cat = String(r.category) as AttackDbCategory;
        if (!(ATTACK_DB_CATEGORIES as readonly string[]).includes(cat)) continue;
        const month = String(r.month);
        const list = out.get(month) ?? [];
        list.push(breakdownEntry(ATTACK_CATEGORY_LABELS[cat], r));
        out.set(month, list);
      }
      return out;
    },
    [db]
  );

  // Per-month model breakdown for one DB category. Same shape as the daily
  // version (Map<bucket-key, ModelBreakdownEntry[]>) but bucketed by YYYY-MM.
  // Used by the monthly chart tooltip: "what models drove this month's Cruise
  // number?".
  const queryMonthlyBreakdownByCategory = useCallback(
    (cat: AttackDbCategory): Map<string, ModelBreakdownEntry[]> => {
      if (!db) return new Map();
      const safe = cat.replace(/'/g, "''");
      const rows = queryRows<{ month: string; model: string; launched: number | null; destroyed: number | null; hidden: number | null }>(
        db,
        `SELECT substr(date, 1, 7) AS month, model,
                SUM(launched)  AS launched,
                SUM(destroyed) AS destroyed,
                SUM(hidden)    AS hidden
         FROM daily_by_model_category
         WHERE category = '${safe}'
         GROUP BY month, model
         ORDER BY month ASC, launched DESC`
      );
      const out = new Map<string, ModelBreakdownEntry[]>();
      for (const r of rows) {
        const month = String(r.month);
        const list = out.get(month) ?? [];
        list.push(breakdownEntry(String(r.model), r));
        out.set(month, list);
      }
      return out;
    },
    [db]
  );

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
    queryDaily, queryGlobalStats, queryMonthly,
    queryDailyByModel, queryMonthlyByModel,
    queryDailyBreakdownByCategory, queryMonthlyBreakdownByCategory,
    queryDailyAggBreakdown, queryMonthlyAggBreakdown,
    queryDataWindow,
    refresh, lastRefreshed, refreshCount,
    refreshIntervalMs,
  };
}
