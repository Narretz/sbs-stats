import { useState, useEffect, useCallback, useRef } from "react";
import type { Database } from "sql.js";
import type {
  MediazonaRolesRow,
  MediazonaEstimateRow,
  MediazonaRoleGroupKey,
  LoadState,
} from "@/types";
import { MEDIAZONA_ROLE_GROUPS, MEDIAZONA_ROLE_GROUP_KEYS, MEDIAZONA_ROLE_COLS } from "@/types";

// Tiny DB (~40 KB) → fetch whole via sql.js, like the RU-losses loader (no httpvfs).
const DB_URL =
  import.meta.env.VITE_MEDIAZONA_DB_URL ??
  `${import.meta.env.BASE_URL}data/mediazona.db`;
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

let dbPromise: Promise<Database> | null = null;

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
  if (!response.ok) throw new Error(`Mediazona database not available at ${DB_URL} (HTTP ${response.status})`);
  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const MAGIC = "SQLite format 3\0";
  const head = String.fromCharCode(...bytes.slice(0, MAGIC.length));
  if (head !== MAGIC) {
    throw new Error(`Mediazona database not available at ${DB_URL} (got ${bytes.byteLength} bytes that aren't a SQLite file — usually means the file is missing and the dev server returned index.html)`);
  }
  return new SQL.Database(bytes);
}

function getOrCreateDbPromise(): Promise<Database> {
  if (!dbPromise) dbPromise = loadDatabase();
  return dbPromise;
}

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

// Map each raw role column to its display group, so we can sum into groups in JS.
const COL_TO_GROUP = new Map<string, MediazonaRoleGroupKey>();
for (const key of MEDIAZONA_ROLE_GROUP_KEYS)
  for (const col of MEDIAZONA_ROLE_GROUPS[key].cols) COL_TO_GROUP.set(col, key);

// Both tables are append-only / edit-versioned: a week can have multiple
// scraped_at rows (one per Mediazona release we ingested). Every read resolves
// to the latest version per week. Mirrors ru_losses' LATEST_PER_DATE pattern.
const LATEST_ROLES = `(
  SELECT d.*
  FROM weekly_roles d
  JOIN (SELECT week, MAX(scraped_at) AS ms FROM weekly_roles GROUP BY week) l
    ON d.week = l.week AND d.scraped_at = l.ms
) latest`;
const LATEST_ESTIMATE = `(
  SELECT d.*
  FROM weekly_estimate d
  JOIN (SELECT week, MAX(scraped_at) AS ms FROM weekly_estimate GROUP BY week) l
    ON d.week = l.week AND d.scraped_at = l.ms
) latest`;

// Weekly data updates at most daily; an hourly poll is plenty (plus on-focus +
// manual refresh).
export const REFRESH_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export function useDatabaseMediazona({ enabled = true }: { enabled?: boolean } = {}) {
  const [db, setDb] = useState<Database | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const lastRefreshedRef = useRef<Date | null>(null);
  const [refreshCount, setRefreshCount] = useState(0);

  const doLoad = useCallback(() => {
    setLoadState("loading");
    getOrCreateDbPromise()
      .then((database) => {
        setDb(database);
        setLoadState("ready");
        const now = new Date();
        setLastRefreshed(now);
        lastRefreshedRef.current = now;
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setLoadState("error");
        dbPromise = null;
      });
  }, []);

  const doRefresh = useCallback(() => {
    dbPromise = null;
    setDb(null);
    setRefreshCount((c) => c + 1);
    doLoad();
  }, [doLoad]);

  // `enabled` gates initial load + the refresh/visibility effects so per-site
  // pages that always need the DB (default true) behave exactly as before,
  // while the homepage's combined view can opt out when no Mediazona metric is
  // selected — keeping the network spend on demand.
  useEffect(() => {
    if (!enabled) return;
    doLoad();
  }, [doLoad, enabled]);

  useEffect(() => {
    if (!enabled) return;
    const interval = setInterval(() => {
      if (document.hidden) return;
      doRefresh();
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [doRefresh, enabled]);

  useEffect(() => {
    if (!enabled) return;
    const handle = () => {
      if (document.hidden) return;
      const age = lastRefreshedRef.current ? Date.now() - lastRefreshedRef.current.getTime() : Infinity;
      if (age >= REFRESH_INTERVAL_MS) doRefresh();
    };
    document.addEventListener("visibilitychange", handle);
    return () => document.removeEventListener("visibilitychange", handle);
  }, [doRefresh, enabled]);

  const refresh = useCallback(() => { doRefresh(); }, [doRefresh]);

  // ── Roles: one row per week, raw role columns summed into display groups ──────
  const queryRoles = useCallback((): MediazonaRolesRow[] => {
    if (!db) return [];
    const cols = ["total", ...MEDIAZONA_ROLE_COLS].join(", ");
    const rows = queryRows<Record<string, number>>(
      db,
      `SELECT week, ${cols} FROM ${LATEST_ROLES} ORDER BY week ASC`
    );
    return rows.map((r) => {
      const grouped = MEDIAZONA_ROLE_GROUP_KEYS.reduce((acc, k) => {
        acc[k] = 0;
        return acc;
      }, {} as Record<MediazonaRoleGroupKey, number>);
      for (const col of MEDIAZONA_ROLE_COLS) {
        const g = COL_TO_GROUP.get(col);
        if (g) grouped[g] += typeof r[col] === "number" ? r[col] : 0;
      }
      return { week: String(r.week), total: typeof r.total === "number" ? r.total : 0, ...grouped };
    });
  }, [db]);

  // ── Estimate: documented (named) vs probate-registry modelled total per week ──
  const queryEstimate = useCallback((): MediazonaEstimateRow[] => {
    if (!db) return [];
    const rows = queryRows<Record<string, number | null>>(
      db,
      `SELECT week, documented, estimate FROM ${LATEST_ESTIMATE} ORDER BY week ASC`
    );
    return rows.map((r) => ({
      week: String(r.week),
      documented: typeof r.documented === "number" ? r.documented : null,
      estimate: typeof r.estimate === "number" ? r.estimate : null,
    }));
  }, [db]);

  // ── Monthly buckets: sum weekly values by the start-date's calendar month ─────
  // A week's value is assigned entirely to the month its start date falls in
  // (no proportional split for week 0/53 straddling month boundaries — the
  // smearing is small and matches how Mediazona itself labels weeks).
  const queryRolesMonthly = useCallback((): MediazonaRolesRow[] => {
    const weekly = queryRoles();
    const buckets = new Map<string, MediazonaRolesRow>();
    for (const r of weekly) {
      const month = r.week.slice(0, 7) + "-01";
      let bucket = buckets.get(month);
      if (!bucket) {
        const empty = MEDIAZONA_ROLE_GROUP_KEYS.reduce(
          (acc, k) => { acc[k] = 0; return acc; },
          {} as Record<MediazonaRoleGroupKey, number>,
        );
        bucket = { week: month, total: 0, ...empty };
        buckets.set(month, bucket);
      }
      bucket.total += r.total;
      for (const k of MEDIAZONA_ROLE_GROUP_KEYS) bucket[k] += r[k];
    }
    return [...buckets.values()].sort((a, b) => a.week.localeCompare(b.week));
  }, [queryRoles]);

  const queryEstimateMonthly = useCallback((): MediazonaEstimateRow[] => {
    const weekly = queryEstimate();
    const buckets = new Map<string, { documented: number | null; estimate: number | null }>();
    for (const r of weekly) {
      const month = r.week.slice(0, 7) + "-01";
      let bucket = buckets.get(month);
      if (!bucket) {
        bucket = { documented: null, estimate: null };
        buckets.set(month, bucket);
      }
      if (typeof r.documented === "number") bucket.documented = (bucket.documented ?? 0) + r.documented;
      if (typeof r.estimate === "number") bucket.estimate = (bucket.estimate ?? 0) + r.estimate;
    }
    return [...buckets.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([week, v]) => ({ week, documented: v.documented, estimate: v.estimate }));
  }, [queryEstimate]);

  // Covered week range across BOTH series (min start, max end), for the
  // "Data … – …" freshness note in the page header.
  const queryDataWindow = useCallback((): { minDate: string | null; maxDate: string | null } => {
    if (!db) return { minDate: null, maxDate: null };
    const rows = queryRows<{ minDate: string | null; maxDate: string | null }>(
      db,
      `SELECT MIN(week) AS minDate, MAX(week) AS maxDate FROM (
         SELECT week FROM weekly_roles UNION ALL SELECT week FROM weekly_estimate
       )`
    );
    return rows[0] ?? { minDate: null, maxDate: null };
  }, [db]);

  return {
    loadState, error,
    queryRoles, queryEstimate,
    queryRolesMonthly, queryEstimateMonthly,
    queryDataWindow,
    refresh, lastRefreshed, refreshCount,
    refreshIntervalMs: REFRESH_INTERVAL_MS,
  };
}
