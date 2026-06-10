import { useCallback } from "react";
import type { Database } from "sql.js";
import type { SbuAlfaBound, SbuAlfaCategoryKey, SbuAlfaCounterRow } from "@/types";
import { makeResourceCache, useRefreshableResource } from "@/hooks/useRefreshableResource";

// Tiny DB → fetch whole via sql.js (same shape as useDatabaseRuMod). The DB is
// committed to the repo (data/sbu-alfa.db) and copied into public/data/ by
// scripts/setup-dev.cjs so vite serves it in both dev and production builds.
const DB_URL =
  import.meta.env.VITE_SBU_ALFA_DB_URL ?? `${import.meta.env.BASE_URL}data/sbu-alfa.db`;
const SQL_JS_CDN = "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.12.0";
const SQL_WASM_URL = import.meta.env.DEV ? "/vendor/sql-wasm.wasm" : `${SQL_JS_CDN}/sql-wasm.wasm`;
const SQL_JS_URL = import.meta.env.DEV ? "/vendor/sql-wasm.js" : `${SQL_JS_CDN}/sql-wasm.js`;

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
  if (!response.ok) throw new Error(`SBU Alfa database not available at ${DB_URL} (HTTP ${response.status})`);
  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const MAGIC = "SQLite format 3\0";
  const head = String.fromCharCode(...bytes.slice(0, MAGIC.length));
  if (head !== MAGIC) {
    throw new Error(`SBU Alfa database not available at ${DB_URL} (got ${bytes.byteLength} bytes that aren't a SQLite file — usually means the file is missing and the dev server returned index.html)`);
  }
  return new SQL.Database(bytes);
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

export function useDatabaseSbuAlfa() {
  const { resource: db, loadState, error, lastRefreshed, refresh, refreshCount, refreshIntervalMs } =
    useRefreshableResource({
      cache: dbCache,
      load: loadDatabase,
      refreshIntervalMs: REFRESH_INTERVAL_MS,
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
    return deriveVehiclesCombined(stored);
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
