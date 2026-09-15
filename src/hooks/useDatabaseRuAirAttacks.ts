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
import {
  ATTACK_CATEGORY_KEYS, ATTACK_CATEGORY_LABELS, ATTACK_DB_CATEGORIES,
  ATTACK_SUBTYPE_CATEGORY, attackSubtypeLabel,
} from "@/types";
import { makeResourceCache, useRefreshableResource } from "@/hooks/useRefreshableResource";
import { getKyivDateString, loadWholeDb, queryRows } from "@/hooks/sqlLoader";
import { windowStartSql } from "@/utils/dayRange";

// Small DB (~2 MB) → fetch whole via sql.js, like the RU-losses loader (no httpvfs).
const DB_URL =
  import.meta.env.VITE_RU_AIR_ATTACKS_DB_URL ?? `${import.meta.env.BASE_URL}data/ru-air-attacks-gsua.db`;

async function loadDatabase(): Promise<Database> {
  const db = await loadWholeDb(DB_URL, "RU air-attacks");
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
  const has = (col: string) =>
    nameIdx >= 0 && (cols[0]?.values ?? []).some((r) => r[nameIdx] === col);

  const isHidden = has("status_data") ? "status_data = 'hidden'" : "0";
  const known = (c: string) => `SUM(CASE WHEN ${isHidden} THEN NULL ELSE ${c} END)`;
  const hiddenCount = `SUM(CASE WHEN ${isHidden} THEN 1 ELSE 0 END)`;

  // Parse the itemizations first — the aggregates below read them.
  installSubtypeTables(db, has("destroyed_types"), isHidden);

  // One relation every aggregate groups: the stored rows, with any sub-type
  // that belongs to another category carved out of its parent's group and
  // re-attributed to its own weapon (see ATTACK_SUBTYPE_CATEGORY). Carving at
  // the group level rather than per row is equivalent here — every aggregate
  // groups by at least (date, category, model) — and keeps this one join.
  db.run(`
    DROP VIEW IF EXISTS attack_contributions;
    CREATE VIEW attack_contributions AS
      SELECT b.date, b.category, b.model,
             b.launched  - COALESCE(mv.launched, 0)  AS launched,
             -- A sub-type upstream didn't itemize intercepts for leaves
             -- mv.destroyed NULL; subtracting nothing keeps those intercepts
             -- with the parent rather than inventing a split.
             b.destroyed - COALESCE(mv.destroyed, 0) AS destroyed,
             b.hidden
      FROM (
        SELECT attack_date AS date, category, model,
               ${known("launched")}  AS launched,
               ${known("destroyed")} AS destroyed,
               ${hiddenCount}        AS hidden
        FROM missile_attacks_latest
        GROUP BY attack_date, category, model
      ) b
      LEFT JOIN (
        SELECT date, from_category, parent_model,
               SUM(launched) AS launched, SUM(destroyed) AS destroyed
        FROM subtype_moves
        GROUP BY date, from_category, parent_model
      ) mv
        ON mv.date = b.date AND mv.from_category = b.category AND mv.parent_model = b.model
      UNION ALL
      -- The carved-out counts, under the weapon's own name, so a day that also
      -- has a stored row for that weapon (a regional command reporting the same
      -- missile as its own attack) folds into one model row rather than two.
      SELECT date, to_category AS category, subtype AS model,
             SUM(launched) AS launched, SUM(destroyed) AS destroyed, 0 AS hidden
      FROM subtype_moves
      GROUP BY date, to_category, subtype;
  `);

  db.run(`
    DROP VIEW IF EXISTS daily_by_category;
    CREATE VIEW daily_by_category AS
      SELECT date, category,
             SUM(launched)  AS launched,
             SUM(destroyed) AS destroyed,
             SUM(hidden)    AS hidden
      FROM attack_contributions
      GROUP BY date, category;

    DROP VIEW IF EXISTS daily_by_model;
    CREATE VIEW daily_by_model AS
      SELECT date, model,
             SUM(launched)  AS launched,
             SUM(destroyed) AS destroyed,
             SUM(hidden)    AS hidden
      FROM attack_contributions
      GROUP BY date, model;

    DROP VIEW IF EXISTS daily_by_model_category;
    CREATE VIEW daily_by_model_category AS
      SELECT date, category, model,
             SUM(launched)  AS launched,
             SUM(destroyed) AS destroyed,
             SUM(hidden)    AS hidden
      FROM attack_contributions
      GROUP BY date, category, model;
  `);
}

// piterfm's `destroyed_types` (added Aug 2026; the first populated row reached
// our DB on 2026-08-23) itemizes what was *inside* a weapon row. The Air Force
// reports an overnight raid as a single "Shahed-136/131" line and then names
// the handful of Banderol cruise missiles or jet-powered airframes among them,
// so an itemized count is a SUBSET of its parent row's launched/destroyed,
// never an addition to it.
//
// The cell is a Python dict repr, not JSON —
// `{'Banderol': {'launched': 2, 'destroyed': 2}, 'Turbojet': {'launched': 82}}`
// — so JSON.parse is out. The regexes below tolerate either quote style, skip
// non-numeric values (`NaN` shows up in piterfm's other dict-valued columns)
// and treat a missing `destroyed` as unknown rather than zero: the raid was
// itemized, its intercepts weren't.
const SUBTYPE_ENTRY_RE = /(['"])([^'"]+)\1\s*:\s*\{([^}]*)\}/g;
const SUBTYPE_FIELD_RE = /(['"])(launched|destroyed)\1\s*:\s*(-?\d+)/g;

function parseDestroyedTypes(raw: string): Array<{ subtype: string; launched: number; destroyed: number | null }> {
  const out: Array<{ subtype: string; launched: number; destroyed: number | null }> = [];
  for (const entry of raw.matchAll(SUBTYPE_ENTRY_RE)) {
    const fields = new Map<string, number>();
    for (const f of entry[3].matchAll(SUBTYPE_FIELD_RE)) fields.set(f[2], Number(f[3]));
    const launched = fields.get("launched");
    // No launch count is nothing to report — the whole point of these rows.
    if (launched == null) continue;
    out.push({ subtype: entry[2], launched, destroyed: fields.get("destroyed") ?? null });
  }
  return out;
}

// Parse the column once at load into a real table, then aggregate it like any
// other view. Done here rather than in the ingest for the same reason the
// disclosure views are: the site then reads a DB of any vintage correctly,
// instead of waiting for the next workflow run to reach R2. A DB built before
// the column existed (the e2e fixtures included) gets the empty table, so every
// downstream query has the same surface either way.
function installSubtypeTables(db: Database, hasSubtypes: boolean, isHidden: string): void {
  db.run(`
    -- Sub-types that belong to their parent's category: shown as "of which"
    -- rows under it, counted where they already are.
    DROP TABLE IF EXISTS attack_subtypes;
    CREATE TABLE attack_subtypes (
      date TEXT, category TEXT, parent_model TEXT, subtype TEXT,
      launched INTEGER, destroyed INTEGER
    );
    -- Sub-types that don't: carved out of the parent group and counted under
    -- their own weapon instead (see attack_contributions).
    DROP TABLE IF EXISTS subtype_moves;
    CREATE TABLE subtype_moves (
      date TEXT, from_category TEXT, to_category TEXT, parent_model TEXT, subtype TEXT,
      launched INTEGER, destroyed INTEGER
    );
  `);

  if (hasSubtypes) {
    const rows = queryRows<{ date: string; category: string; model: string; source: string; destroyed_types: string }>(
      db,
      // A withheld parent carries placeholder 0s, so nothing itemized inside it
      // can be reconciled against a count nobody published — skipped here, the
      // same way the views above refuse to sum one.
      `SELECT attack_date AS date, category, model, source, destroyed_types
       FROM missile_attacks_latest
       WHERE TRIM(COALESCE(destroyed_types, '')) <> ''
         AND COALESCE(${isHidden}, 0) = 0`
    );
    // Whether an itemized count is *inside* its parent row or *alongside* it
    // depends on whether piterfm also gave that weapon a row of its own for the
    // same report, and that has changed over time:
    //
    //   2025-09-27 — Air Force reported "595 drones and 48 missiles". The DB has
    //     Shahed 593 plus a separate Banderol row of 2 (593 + 2 = 595), and the
    //     Shahed row *also* names Banderol 2 in `destroyed_types`. So there the
    //     itemization repeats the sibling row; the 593 does not contain it.
    //   2026-09-11 — "129 Shahed-type UAVs (half of them jet-powered), S8000
    //     Banderol and Parodiya decoys". The DB has one Shahed row of 129, no
    //     Banderol row, and `destroyed_types` naming Banderol 1 and Turbojet 64
    //     (64/129 = the reported half). There the 129 contains both.
    //
    // A sibling row from the same source post is what separates the two, so an
    // itemization that has one is dropped: the weapon is already charted under
    // its own model (Banderol is `cruise`), and repeating it under the UAV row
    // would both double-show it and misstate the parent's count.
    const rowedSeparately = new Set(
      queryRows<{ source: string; model: string }>(db, "SELECT source, model FROM missile_attacks_latest")
        .map((r) => `${r.source}\u0000${r.model}`)
    );
    const insertStay = `INSERT INTO attack_subtypes
      (date, category, parent_model, subtype, launched, destroyed)
      VALUES (?, ?, ?, ?, ?, ?)`;
    const insertMove = `INSERT INTO subtype_moves
      (date, from_category, to_category, parent_model, subtype, launched, destroyed)
      VALUES (?, ?, ?, ?, ?, ?, ?)`;
    for (const r of rows) {
      for (const s of parseDestroyedTypes(String(r.destroyed_types))) {
        if (rowedSeparately.has(`${r.source}\u0000${s.subtype}`)) continue;
        // An itemization inherits its parent row's category, which is wrong for
        // a weapon that isn't of the parent's kind: the Air Force counts
        // Banderol inside the night's UAV headline, but it's a cruise missile
        // and every standalone `model='Banderol'` row is already charted as
        // one. Where our own classification disagrees with the row it arrived
        // in, the counts move; otherwise they stay nested.
        // Bound, not interpolated: `subtype` is upstream text, and it reaches
        // the tooltip as a label either way.
        const from = String(r.category);
        const to = ATTACK_SUBTYPE_CATEGORY[s.subtype] ?? from;
        if (to === from) {
          db.run(insertStay, [String(r.date), from, String(r.model), s.subtype, s.launched, s.destroyed]);
        } else {
          db.run(insertMove, [String(r.date), from, to, String(r.model), s.subtype, s.launched, s.destroyed]);
        }
      }
    }
  }

  db.run(`
    DROP VIEW IF EXISTS daily_by_subtype;
    CREATE VIEW daily_by_subtype AS
      SELECT date, category, parent_model, subtype,
             SUM(launched) AS launched,
             -- One un-itemized entry leaves the whole group unknown: a partial
             -- sum would read as a complete intercept count.
             CASE WHEN SUM(destroyed IS NULL) > 0 THEN NULL ELSE SUM(destroyed) END AS destroyed
      FROM attack_subtypes
      GROUP BY date, category, parent_model, subtype;
  `);
}

type SubtypeRow = {
  bucket: string; parent: string; subtype: string;
  launched: number | null; destroyed: number | null;
};

// Splice each bucket's sub-type rows in directly under the model row they were
// itemized from. Position is what marks them as a subset of that row rather
// than another sibling adding to the category total, so an entry whose parent
// isn't in the list goes to the end instead of floating mid-list.
function mergeSubtypeEntries(out: Map<string, ModelBreakdownEntry[]>, rows: SubtypeRow[]): void {
  for (const r of rows) {
    const list = out.get(String(r.bucket));
    if (!list) continue;
    const entry: ModelBreakdownEntry = {
      model: attackSubtypeLabel(String(r.subtype)),
      launched: num(r.launched),
      intercepted: typeof r.destroyed === "number" ? r.destroyed : null,
      nested: true,
    };
    const at = list.findIndex((e) => e.model === String(r.parent));
    if (at < 0) {
      list.push(entry);
      continue;
    }
    // Append after the parent's existing nested run, so several sub-types keep
    // the launched-DESC order the query returned them in.
    let i = at + 1;
    while (i < list.length && list[i].nested) i++;
    list.splice(i, 0, entry);
  }
}

const dbCache = makeResourceCache<Database>();

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
      // Sub-types itemized inside one of those model rows (Banderol and
      // jet-powered airframes inside the nightly UAV line). Only the tooltip
      // carries them: they're reported on some days and not others, so as a
      // series of their own the silent days would chart as zeros.
      mergeSubtypeEntries(
        out,
        queryRows<SubtypeRow>(
          db,
          `SELECT date AS bucket, parent_model AS parent, subtype, launched, destroyed
           FROM daily_by_subtype
           WHERE category = '${safe}'
             AND date >= ${windowStartSql(endDateSql, days)}
             AND date <= date('${endDateSql}')
           ORDER BY date ASC, launched DESC`
        )
      );
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
      // Same sub-type rows as the daily tooltip, rolled up per month. A month
      // with one un-itemized intercept count reads unknown rather than partial,
      // which is what the CASE in `daily_by_subtype` does per day.
      mergeSubtypeEntries(
        out,
        queryRows<SubtypeRow>(
          db,
          `SELECT substr(date, 1, 7) AS bucket, parent_model AS parent, subtype,
                  SUM(launched) AS launched,
                  CASE WHEN SUM(destroyed IS NULL) > 0 THEN NULL ELSE SUM(destroyed) END AS destroyed
           FROM daily_by_subtype
           WHERE category = '${safe}'
           GROUP BY bucket, parent, subtype
           ORDER BY bucket ASC, launched DESC`
        )
      );
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
