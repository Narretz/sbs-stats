// The RU air-attacks DB's query layer: the disclosure-aware views it installs
// on load, and every query the dataset's pages read — plain functions of a
// sql.js Database, so they run on an in-memory one in a unit test
// (ruAirAttacksDb.test.ts). useDatabaseRuAirAttacks loads and refreshes the DB
// and hands it to these.
import type { Database } from "sql.js";
import type {
  RuAirAttacksDailyRow,
  RuAirAttacksGlobalStats,
  RuAirAttacksMonthlyRow,
  RuAirAttacksModelDailyRow,
  RuAirAttacksModelMonthlyRow,
  AttackCategoryKey,
  AttackDbCategory,
  AirImpactKey,
  ModelBreakdownEntry,
} from "@/types";
import {
  AIR_IMPACT_KEYS, ATTACK_CATEGORY_KEYS, ATTACK_CATEGORY_LABELS, ATTACK_DB_CATEGORIES,
  ATTACK_SUBTYPE_CATEGORY, attackSubtypeLabel,
} from "@/types";
import { getKyivDateString, queryRows } from "@/hooks/sqlLoader";
import { windowStartSql } from "@/utils/dayRange";
import { countedSql, nationalDroneWindowsSql } from "@/utils/airAttacksSql";
import { projectFromDays, reportingMonth } from "@/utils/monthProjection";
import { attachDailyMedians, dailyMediansByMonth, dayCountsByMonth } from "@/utils/dailyMedian";
import type { AirAttackRow } from "@/utils/sources";

// The latest day before today the source has a row for — its frontier.
function latestCompleteDay(dates: Iterable<string>, today: string): string | null {
  let latest: string | null = null;
  for (const d of dates) if (d < today && (latest == null || d > latest)) latest = d;
  return latest;
}

// piterfm added a `status_data` column in Aug 2026. A row flagged `'hidden'` is
// an attack the Ukrainian Air Force reported *without* disclosing counts — it
// stopped publishing ballistic missile launched/intercepted figures on
// 2026-08-13 — and the CSV carries a placeholder `0`, which is
// indistinguishable from a real zero once summed. The DB's own aggregate views
// sum it, so redefine them over our in-memory copy (never written back to R2):
// a hidden row's 0 contributes NULL, and each group carries a `hidden` count so
// the UI can render "not disclosed" rather than draw a zero.
//
// A hidden row's *non-zero* figure is not a placeholder: the Air Force often
// still gives the intercepts ("5 ballistic missiles shot down") and withholds
// only how many were launched, which piterfm records as launched = destroyed =
// 5. Those count — the intercepts as reported, the launched as a lower bound —
// and the `hidden` count is what tells the UI to say so.
//
// Doing this once at load keeps every downstream query correct without each
// one restating the CASE. DBs built before the column existed — including the
// e2e fixtures — get the same views with `hidden` pinned to 0, so the query
// surface is identical either way.
export function installDisclosureAwareViews(db: Database): void {
  const cols = db.exec("PRAGMA table_info(missile_attacks)");
  const nameIdx = cols[0]?.columns.indexOf("name") ?? -1;
  const has = (col: string) =>
    nameIdx >= 0 && (cols[0]?.values ?? []).some((r) => r[nameIdx] === col);

  const isHidden = has("status_data") ? "status_data = 'hidden'" : "0";
  const known = (c: string) => `SUM(CASE WHEN ${isHidden} THEN NULLIF(${c}, 0) ELSE ${c} END)`;
  const hiddenCount = `SUM(CASE WHEN ${isHidden} THEN 1 ELSE 0 END)`;

  // What the aggregates sum: the latest rows, without the regional reports'
  // repeats of the national UAV count (see countedSql). Tables built once at
  // load, like attack_subtypes below, not the file's views of the same name: a
  // view re-runs its per-row window check on every query that reads it (~130 ms
  // natively, more in sql.js), and a page runs dozens of them. Derived display
  // data stays out of the authoritative file, as for GSUA's app-copy tables.
  db.run(`
    DROP VIEW IF EXISTS national_drone_windows;
    DROP TABLE IF EXISTS national_drone_windows;
    CREATE TABLE national_drone_windows AS ${nationalDroneWindowsSql("missile_attacks_latest")};
    DROP VIEW IF EXISTS missile_attacks_counted;
    DROP TABLE IF EXISTS missile_attacks_counted;
    CREATE TABLE missile_attacks_counted AS ${countedSql("missile_attacks_latest", "national_drone_windows")};
  `);

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
        FROM missile_attacks_counted
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

  installImpactsView(db, hasImpactColumns(db));
}

// "Hits at N locations, debris fell at M" (AIR_IMPACT_KEYS). The figure belongs
// to a REPORT — piterfm puts it on the report's main row and sometimes repeats
// it on another row of the same report — so each report (source + window)
// counts once, and a day sums its reports (an overnight raid and a daytime one
// are two). Stored as text ('20.0', '' when not given); a day where no report
// gave one has no row here, so it reads as not reported rather than 0. A DB
// without the columns (older builds, fixtures) gets the same view, empty.
function installImpactsView(db: Database, hasColumns: boolean): void {
  const num = (c: string) => `CASE WHEN TRIM(COALESCE(${c}, '')) != '' THEN CAST(${c} AS REAL) END`;
  db.run(`
    DROP VIEW IF EXISTS daily_impacts;
    CREATE VIEW daily_impacts AS
      ${hasColumns ? `
      SELECT date, SUM(hit) AS impact_hit, SUM(debris) AS impact_debris
      FROM (
        SELECT attack_date AS date,
               MAX(${num("num_hit_location")})           AS hit,
               MAX(${num("num_fall_fragment_location")}) AS debris
        FROM missile_attacks_latest
        GROUP BY attack_date, source, time_start, time_end
      )
      GROUP BY date
      HAVING COUNT(hit) > 0 OR COUNT(debris) > 0` : `
      SELECT NULL AS date, NULL AS impact_hit, NULL AS impact_debris WHERE 0`};
  `);
}

type ImpactDay = Record<AirImpactKey, number | null>;

function hasImpactColumns(db: Database): boolean {
  const names = (db.exec("PRAGMA table_info(missile_attacks)")[0]?.values ?? []).map((r) => r[1]);
  return names.includes("num_hit_location") && names.includes("num_fall_fragment_location");
}

function queryImpacts(db: Database, where = ""): Map<string, ImpactDay> {
  const out = new Map<string, ImpactDay>();
  for (const r of queryRows<{ date: string; impact_hit: number | null; impact_debris: number | null }>(
    db, `SELECT date, impact_hit, impact_debris FROM daily_impacts ${where}`,
  )) {
    out.set(String(r.date), {
      impact_hit: typeof r.impact_hit === "number" ? Math.round(r.impact_hit) : null,
      impact_debris: typeof r.impact_debris === "number" ? Math.round(r.impact_debris) : null,
    });
  }
  return out;
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
       FROM missile_attacks_counted
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
    //     (piterfm dropped that Banderol row in Oct 2026, and no report has the
    //     shape now — the check guards against it coming back.)
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

type CategoryRow = {
  date: string; category: string;
  launched: number | null; destroyed: number | null;
  // Rows in this (date, category) group whose counts upstream withheld. The
  // view nulls their placeholder 0s, so `launched`/`destroyed` are null when
  // *nothing* was disclosed and a partial sum (a lower bound) otherwise.
  hidden?: number | null;
};

function num(v: number | null | undefined): number {
  return typeof v === "number" ? v : 0;
}

// One breakdown row. `undisclosed` marks the case where every row behind the
// entry was withheld, so its 0 is a placeholder rather than a count;
// `lowerBound` the case where a withheld row still gave a figure.
function breakdownEntry(
  model: string,
  r: { launched: number | null; destroyed: number | null; hidden?: number | null },
): ModelBreakdownEntry {
  const entry: ModelBreakdownEntry = {
    model,
    launched: num(r.launched),
    intercepted: num(r.destroyed),
  };
  if (num(r.hidden) > 0) {
    if (r.launched === null) entry.undisclosed = true;
    else entry.lowerBound = true;
  }
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

// A day's impact figures onto its pivoted row: null where no report gave one.
function withImpacts(rows: RuAirAttacksDailyRow[], impacts: Map<string, ImpactDay>): RuAirAttacksDailyRow[] {
  for (const row of rows) {
    const i = impacts.get(row.date);
    for (const k of AIR_IMPACT_KEYS) row[k] = i?.[k] ?? null;
  }
  return rows;
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

// ── Daily: launched + intercepted per category, attributed to time_start date ─
export function queryDaily(db: Database, days: number, endDate?: string): RuAirAttacksDailyRow[] {
  const todayStr = getKyivDateString();
  const endDateSql = endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate) ? endDate : todayStr;
  const sql = `
    SELECT date, category, launched, destroyed, hidden
    FROM daily_by_category
    WHERE date >= ${windowStartSql(endDateSql, days)}
      AND date <= date('${endDateSql}')
    ORDER BY date ASC
  `;
  const impacts = queryImpacts(db, `WHERE date >= ${windowStartSql(endDateSql, days)} AND date <= date('${endDateSql}')`);
  return withImpacts(pivotDaily(queryRows<CategoryRow>(db, sql), todayStr), impacts);
}

// ── Global stats: max + median per category/metric across ALL days ────────────
export function queryGlobalStats(db: Database): RuAirAttacksGlobalStats {
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
  const impacts = [...queryImpacts(db).values()];
  result.impacts = Object.fromEntries(
    AIR_IMPACT_KEYS.map((k) => [k, maxMedian(impacts.map((d) => d[k]))]),
  ) as Record<AirImpactKey, ReturnType<typeof maxMedian>>;
  return result;
}

// ── Monthly: launched + intercepted sums per category, with current-month
// projection on both. Bare key holds launched (legacy); `*_intercepted` holds
// the destroyed sum so the page can render side-by-side bars + a % rate.
export function queryMonthly(db: Database): RuAirAttacksMonthlyRow[] {
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

  // Every day, pivoted into the same keys as the monthly row: the projection
  // tells this month's complete days from today's partial, and each month's
  // median day reads them all. A category with no row on a day another
  // category reported is 0, as on the daily chart; a withheld figure is a
  // gap there, so the median leaves it out (the sums read it as 0).
  const today = getKyivDateString();
  const currentMonth = today.slice(0, 7);
  const projKeys = ATTACK_CATEGORY_KEYS.flatMap((c) => [c, `${c}_intercepted`] as const);
  const byDay = new Map<string, Record<string, number>>();
  const withheld = new Map<string, Set<string>>();
  for (const r of queryRows<{ date: string; category: string; launched: number | null; destroyed: number | null; hidden: number | null }>(
    db,
    `SELECT date, category, launched, destroyed, hidden FROM daily_by_category`,
  )) {
    const v = byDay.get(r.date) ?? Object.fromEntries(projKeys.map((k) => [k, 0]));
    v.all += num(r.launched);
    v.all_intercepted += num(r.destroyed);
    if ((ATTACK_DB_CATEGORIES as readonly string[]).includes(r.category)) {
      v[r.category] += num(r.launched);
      v[`${r.category}_intercepted`] += num(r.destroyed);
      if (num(r.hidden) > 0) {
        const w = withheld.get(r.date) ?? new Set<string>();
        if (r.launched == null) w.add(r.category);
        if (r.destroyed == null) w.add(`${r.category}_intercepted`);
        withheld.set(r.date, w);
      }
    }
    byDay.set(r.date, v);
  }
  const days = [...byDay].map(([date, values]) => ({ date, values }));
  // The source runs ~a week behind, so into a new month the last one is
  // still the month in progress (reportingMonth).
  const projMonth = reportingMonth(latestCompleteDay(byDay.keys(), today), today);
  const projection = projectFromDays(projMonth, today, days, projKeys);

  // The impact figures, summed per month from the days that gave one. Their
  // own day list: a day with attacks but no figure is a gap for them, not 0,
  // so it stays out of the projection, the median and the day count.
  const impactDays = [...queryImpacts(db)].map(([date, values]) => ({ date, values }));
  const impactSums = new Map<string, Partial<Record<AirImpactKey, number>>>();
  for (const { date, values } of impactDays) {
    const m = impactSums.get(date.slice(0, 7)) ?? {};
    for (const k of AIR_IMPACT_KEYS) {
      const v = values[k];
      if (typeof v === "number") m[k] = (m[k] ?? 0) + v;
    }
    impactSums.set(date.slice(0, 7), m);
  }
  const impactProjection = projectFromDays(projMonth, today, impactDays, AIR_IMPACT_KEYS);
  const impactMedians = dailyMediansByMonth(impactDays, AIR_IMPACT_KEYS, today);
  const impactDayCounts = dayCountsByMonth(impactDays, AIR_IMPACT_KEYS, today);
  const medians = dailyMediansByMonth(
    days.map(({ date, values }) => {
      const w = withheld.get(date);
      return { date, values: w ? Object.fromEntries(Object.entries(values).map(([k, v]) => [k, w.has(k) ? null : v])) : values };
    }),
    projKeys,
    today,
  );

  return [...byMonth.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((row) => {
      const isCurrent = row.date === projMonth;
      const p = isCurrent ? projection : null;
      row.is_current_month = row.date === currentMonth;
      row.projection_day = p?.completedDays ?? null;
      row.projection_days_in_month = p?.daysInMonth ?? null;
      row.projection_partial_day = p?.partialDay;
      for (const [k, v] of Object.entries(p?.projected ?? {})) {
        row[`${k}_projected` as `${AttackCategoryKey}_projected`] = v;
      }
      attachDailyMedians(row, medians);
      const sums = impactSums.get(row.date) ?? {};
      for (const k of AIR_IMPACT_KEYS) {
        row[k] = sums[k] ?? null;
        const n = impactDayCounts.get(row.date)?.[k];
        if (n != null) row[`${k}_days`] = n;
        const proj = isCurrent ? impactProjection?.projected[k] : undefined;
        if (proj != null) row[`${k}_projected`] = proj;
      }
      attachDailyMedians(row, impactMedians);
      return row;
    });
}

// ── Per-model daily: one row per date with launched + intercepted for the
// given `model` (exact match on the DB's `model` column — bundled rows like
// "X-101/X-555 and Kalibr" don't fold into individual model charts).
//
// Left-joined against the set of dates that appear in `daily_by_category` so
// days with attacks in other categories but none for this model render as 0
// (parity with the per-category charts, whose pivot zero-fills cross-
// category). Days with no data at all stay absent → the trailing-pad utility
// can render them as visibly missing instead of as zeros.
export function queryDailyByModel(db: Database, model: string, days: number, endDate?: string): RuAirAttacksModelDailyRow[] {
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
}

// ── Per-model monthly: sums per calendar month, with current-month projection
// on both launched and intercepted (same pro-rata extrapolation as the
// per-category monthly query).
export function queryMonthlyByModel(db: Database, model: string): RuAirAttacksModelMonthlyRow[] {
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

  const today = getKyivDateString();
  const currentMonth = today.slice(0, 7);
  // The source's month in progress, off every model's days, not this one's.
  const projMonth = reportingMonth(
    latestCompleteDay(queryRows<{ date: string }>(db, `SELECT DISTINCT date FROM daily_by_category`).map((r) => r.date), today),
    today,
  );
  const projection = projectFromDays(
    projMonth,
    today,
    queryRows<{ date: string; launched: number | null; intercepted: number | null }>(
      db,
      `SELECT date, SUM(launched) AS launched, SUM(destroyed) AS intercepted
       FROM daily_by_model
       WHERE model = '${safeModel}' AND date >= '${projMonth}-01'
       GROUP BY date`,
    ).map(({ date, ...values }) => ({ date, values })),
    ["launched", "intercepted"] as const,
  );
  // Each month's median day over the daily chart's own days: every date
  // any category reported, 0 where this model had none, a gap where its
  // figure was withheld (queryDailyByModel).
  const medians = dailyMediansByMonth(
    queryRows<{ date: string; launched: number | null; intercepted: number | null }>(
      db,
      `SELECT d.date,
              CASE WHEN m.hidden > 0 AND m.launched  IS NULL THEN NULL ELSE COALESCE(m.launched, 0)  END AS launched,
              CASE WHEN m.hidden > 0 AND m.destroyed IS NULL THEN NULL ELSE COALESCE(m.destroyed, 0) END AS intercepted
       FROM (SELECT DISTINCT date FROM daily_by_category) d
       LEFT JOIN daily_by_model m ON m.date = d.date AND m.model = '${safeModel}'`,
    ).map(({ date, ...values }) => ({ date, values })),
    ["launched", "intercepted"] as const,
    today,
  );

  return raw.map((r) => {
    const month = String(r.month);
    const launched = num(r.launched);
    const intercepted = num(r.destroyed);
    const p = month === projMonth ? projection : null;
    const row: RuAirAttacksModelMonthlyRow = {
      date: month,
      is_current_month: month === currentMonth,
      projection_day: p?.completedDays ?? null,
      projection_days_in_month: p?.daysInMonth ?? null,
      projection_partial_day: p?.partialDay,
      launched,
      intercepted,
    };
    if (p) {
      row.launched_projected = p.projected.launched;
      row.intercepted_projected = p.projected.intercepted;
    }
    attachDailyMedians(row, medians);
    return row;
  });
}

// ── Per-date model breakdown for one DB category. Used by the daily chart
// tooltip: "what models drove this Cruise spike on 2026-03-12?". Returns
// each date's contributing models sorted by launched DESC. Bundled "X and Y"
// rows are returned as their literal model string (callers can decide to
// collapse them or show them as-is).
export function queryDailyBreakdownByCategory(db: Database, cat: AttackDbCategory, days: number, endDate?: string): Map<string, ModelBreakdownEntry[]> {
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
}

// Per-date breakdown by category (drone / cruise / ballistic) for the
// aggregate "All" chart's tooltip. Returns rows labelled with their
// human-readable category name so they read naturally in the table.
export function queryDailyAggBreakdown(db: Database, days: number, endDate?: string): Map<string, ModelBreakdownEntry[]> {
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
}

// Per-month breakdown by category for the aggregate monthly bar chart.
export function queryMonthlyAggBreakdown(db: Database): Map<string, ModelBreakdownEntry[]> {
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
}

// Per-month model breakdown for one DB category. Same shape as the daily
// version (Map<bucket-key, ModelBreakdownEntry[]>) but bucketed by YYYY-MM.
// Used by the monthly chart tooltip: "what models drove this month's Cruise
// number?".
export function queryMonthlyBreakdownByCategory(db: Database, cat: AttackDbCategory): Map<string, ModelBreakdownEntry[]> {
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
}

// Full covered date range (first/last day), for the "Data … – …" freshness
// note in the page header.
export function queryDataWindow(db: Database): { minDate: string | null; maxDate: string | null } {
  const rows = queryRows<{ minDate: string | null; maxDate: string | null }>(
    db,
    "SELECT MIN(date) AS minDate, MAX(date) AS maxDate FROM daily_by_category"
  );
  return rows[0] ?? { minDate: null, maxDate: null };
}

// The attack rows of the window with the post each came from — the pinned
// sheet's links, built per chart (utils/sources airAttackSourcesByDate).
export function querySourceRows(db: Database, days: number, endDate?: string): AirAttackRow[] {
  const endDateSql = endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate) ? endDate : getKyivDateString();
  return queryRows<AirAttackRow>(
    db,
    `SELECT attack_date AS date, category, model, source, time_start, time_end, launched, destroyed,
            CASE WHEN status_data = 'hidden' THEN 1 ELSE 0 END AS hidden,
            ${hasImpactColumns(db)
              ? "CASE WHEN TRIM(COALESCE(num_hit_location, '')) != '' OR TRIM(COALESCE(num_fall_fragment_location, '')) != '' THEN 1 ELSE 0 END"
              : "0"} AS has_impacts
     FROM missile_attacks_latest
     WHERE source IS NOT NULL AND source != ''
       AND attack_date >= ${windowStartSql(endDateSql, days)}
       AND attack_date <= date('${endDateSql}')`,
  );
}
