import { useCallback } from "react";
import type { Database } from "sql.js";
import type { SbuAlfaBound, SbuAlfaCategoryKey, SbuAlfaCounterRow } from "@/types";
import { makeResourceCache, useRefreshableResource } from "@/hooks/useRefreshableResource";
import { loadWholeDb, queryRows } from "@/hooks/sqlLoader";

// Tiny DB → fetch whole via sql.js (same shape as useDatabaseRuMod). The DB is
// committed to the repo (data/sbu-alfa.db) and copied into public/data/ by
// scripts/setup-dev.cjs so vite serves it in both dev and production builds.
const DB_URL =
  import.meta.env.VITE_SBU_ALFA_DB_URL ?? `${import.meta.env.BASE_URL}data/sbu-alfa.db`;
const loadDatabase = () => loadWholeDb(DB_URL, "SBU Alfa");

const dbCache = makeResourceCache<Database>();

// Manual ingest means SBU might publish a new article only every few weeks; a
// 24h refresh window is plenty (and largely a no-op since the DB ships with the
// build, not via R2).
export const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Synthesize vehicles_auto_total for periods that report the three-way split
// but not the SBU-stated combined number. If a period already has an
// SBU-stated combined value we leave it alone; if it has none of the four
// vehicle counters we also leave it alone (can't derive from nothing).
function deriveVehiclesCombined(rows: SbuAlfaCounterRow[]): SbuAlfaCounterRow[] {
  const byPeriod = new Map<string, SbuAlfaCounterRow[]>();
  for (const r of rows) {
    const list = byPeriod.get(r.period) ?? [];
    list.push(r);
    byPeriod.set(r.period, list);
  }
  const synthesized: SbuAlfaCounterRow[] = [];
  for (const [, list] of byPeriod) {
    if (list.some((r) => r.category === "vehicles_auto_total")) continue;
    const light = list.find((r) => r.category === "vehicles_light");
    const moto = list.find((r) => r.category === "vehicles_moto");
    const trucks = list.find((r) => r.category === "vehicles_trucks");
    const parts = [light, moto, trucks].filter((p): p is SbuAlfaCounterRow => p != null);
    if (!parts.length) continue;
    const sum = parts.reduce((s, p) => s + p.value, 0);
    const seed = parts[0];
    synthesized.push({
      period: seed.period,
      category: "vehicles_auto_total",
      value: sum,
      value_max: null,
      bound: "exact",
      raw_label: null,
      url: seed.url,
      published_at: seed.published_at,
      derived: true,
      derivation_note:
        "Sum of light + motorcycles + trucks. SBU's recap for this month split vehicles three ways without stating a combined total.",
    });
  }
  return [...rows, ...synthesized].sort((a, b) =>
    a.period === b.period ? a.category.localeCompare(b.category) : a.period.localeCompare(b.period)
  );
}

// Categories that must NOT enter the enumerated-targets sum.
//
// `enemy_kia` because SBU counts personnel apart from equipment — its own
// phrasing is "N ІНШИХ цілей" ("N OTHER targets"), i.e. the target total
// already excludes the KIA line. The three `targets_*` are SBU's own
// aggregates, so adding them to the parts they aggregate would double-count.
const NOT_A_TARGET_CATEGORY = new Set<SbuAlfaCategoryKey>([
  "enemy_kia", "targets_total", "targets_destroyed", "targets_damaged",
]);

// Parent → the children it already contains. Verified against every published
// month: armored_total is exactly tanks + ifvs (69 = 23+46, 62 = 15+47,
// 33 = 7+26, 67 = 20+47), and vehicles_auto_total is light + moto + trucks
// (stated from May, derived above for March/April). Counting both sides would
// double-count, so when a parent is present its children are skipped; when it
// is absent the children stand in for it.
const PARENT_CHILDREN: Partial<Record<SbuAlfaCategoryKey, SbuAlfaCategoryKey[]>> = {
  armored_total: ["tanks", "ifvs"],
  vehicles_auto_total: ["vehicles_light", "vehicles_moto", "vehicles_trucks"],
};

// Sum the enumerated equipment categories into one synthetic row per period.
//
// This is NOT `targets_total`: SBU introduces its bullets with "серед"
// ("among") the objects hit, so the list is partial. Where the source states
// both, the sum comes to ~90% of it (2026-03: 6 681 of 7 346; 2026-04: 9 451
// of 10 518). Charted as its own series and flagged as derived so it can't be
// mistaken for SBU's own total — which is exactly why the hook has never
// synthesised `targets_total` from these parts.
function deriveEnumeratedTargets(rows: SbuAlfaCounterRow[]): SbuAlfaCounterRow[] {
  const byPeriod = new Map<string, SbuAlfaCounterRow[]>();
  for (const r of rows) {
    const list = byPeriod.get(r.period) ?? [];
    list.push(r);
    byPeriod.set(r.period, list);
  }
  const synthesized: SbuAlfaCounterRow[] = [];
  for (const [, list] of byPeriod) {
    if (list.some((r) => r.category === "targets_enumerated")) continue;
    const present = new Set(list.map((r) => r.category));
    const covered = new Set<SbuAlfaCategoryKey>();
    for (const [parent, children] of Object.entries(PARENT_CHILDREN)) {
      if (present.has(parent as SbuAlfaCategoryKey)) children.forEach((c) => covered.add(c));
    }
    const parts = list.filter(
      (r) => !NOT_A_TARGET_CATEGORY.has(r.category) && !covered.has(r.category),
    );
    if (!parts.length) continue;
    const seed = parts[0];
    synthesized.push({
      period: seed.period,
      category: "targets_enumerated",
      value: parts.reduce((sum, r) => sum + r.value, 0),
      value_max: null,
      bound: "exact",
      raw_label: null,
      url: seed.url,
      published_at: seed.published_at,
      derived: true,
      derivation_note:
        `Our sum of the ${parts.length} equipment categories SBU listed this month, ` +
        `not a figure SBU states. Excludes the KIA line, which SBU counts separately ` +
        `("N інших цілей" = N OTHER targets). A LOWER BOUND: the recap introduces its ` +
        `list with "серед" ("among") the objects hit, so where SBU also gives a total ` +
        `this sum reaches only ~90% of it.`,
    });
  }
  return [...rows, ...synthesized].sort((a, b) =>
    a.period === b.period ? a.category.localeCompare(b.category) : a.period.localeCompare(b.period)
  );
}

export function useDatabaseSbuAlfa({ enabled = true }: { enabled?: boolean } = {}) {
  const { resource: db, loadState, error, lastRefreshed, refresh, refreshCount, refreshIntervalMs } =
    useRefreshableResource({
      cache: dbCache,
      load: loadDatabase,
      refreshIntervalMs: REFRESH_INTERVAL_MS,
      enabled,
    });

  // Long-table rows: one per (period, category). Frontend pivots/filters by
  // category. `counters_latest` / `reports_latest` are views in the DB that
  // resolve the latest scraped_at per article URL — append-on-edit means a
  // re-scraped article inserts new rows; old rows linger but are filtered out.
  const queryCounters = useCallback((): SbuAlfaCounterRow[] => {
    if (!db) return [];
    const sql = `
      SELECT r.period      AS period,
             c.category    AS category,
             c.value       AS value,
             c.value_max   AS value_max,
             c.bound       AS bound,
             c.raw_label   AS raw_label,
             r.url         AS url,
             r.published_at AS published_at
      FROM counters_latest c
      JOIN reports_latest r USING (url, scraped_at)
      WHERE r.report_type = 'monthly_top1'
        AND r.period IS NOT NULL
      ORDER BY r.period ASC, c.category ASC`;
    const stored: SbuAlfaCounterRow[] = queryRows<Record<string, unknown>>(db, sql).map((r) => ({
      period: String(r.period),
      category: r.category as SbuAlfaCategoryKey,
      value: Number(r.value),
      value_max: typeof r.value_max === "number" ? r.value_max : null,
      bound: r.bound as SbuAlfaBound,
      raw_label: r.raw_label == null ? null : String(r.raw_label),
      url: String(r.url),
      published_at: r.published_at == null ? null : String(r.published_at),
      derived: false,
    }));

    // Derive vehicles_auto_total = light + moto + trucks for months that have
    // the split but no SBU-stated combined number (March/April use the split;
    // May lumps everything into the combined bucket directly). This lets the
    // "Vehicles (combined)" chart compare months on the same y-axis. We do NOT
    // also synthesise the inverse (splitting May's combined into buckets) —
    // there's no way to know how SBU's combined breaks down.
    //
    // Likewise we don't synthesise targets_total from the per-category bullets:
    // the source explicitly frames the bullets as "серед" / "among" the hit
    // objects, with an unenumerated remainder (~10% of targets_total). Summing
    // would understate it.
    // Order matters: the vehicles parent must exist before the enumerated sum
    // runs, or March/April would sum the three vehicle children instead and
    // land on the same number by a different route (fine here, but only by
    // luck — the parent/child skip is what keeps it correct in general).
    return deriveEnumeratedTargets(deriveVehiclesCombined(stored));
  }, [db]);

  const queryDataWindow = useCallback((): { minPeriod: string | null; maxPeriod: string | null } => {
    if (!db) return { minPeriod: null, maxPeriod: null };
    const rows = queryRows<{ minPeriod: string | null; maxPeriod: string | null }>(
      db,
      "SELECT MIN(period) AS minPeriod, MAX(period) AS maxPeriod FROM reports_latest WHERE report_type = 'monthly_top1'"
    );
    return rows[0] ?? { minPeriod: null, maxPeriod: null };
  }, [db]);

  return {
    loadState, error,
    queryCounters, queryDataWindow,
    refresh, lastRefreshed, refreshCount,
    refreshIntervalMs,
  };
}
