import type { Database } from "sql.js";

// Shared sql.js plumbing for the whole-DB dataset hooks. Every small dataset
// (SBS / RU losses / RU MoD / RU air-attacks / UA losses / SBU Alfa / Mediazona)
// fetches its entire SQLite file and opens it in-memory via sql.js — only the
// large GSUA attacks DB range-fetches via sql.js-httpvfs (see useDatabaseGsua).
// The fetch + wasm init + SQLite-magic validation and the row-mapping helper
// were copy-pasted into each hook; they live here once now.

const SQL_JS_CDN = "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.12.0";
const SQL_WASM_URL = import.meta.env.DEV ? "/vendor/sql-wasm.wasm" : `${SQL_JS_CDN}/sql-wasm.wasm`;
const SQL_JS_URL = import.meta.env.DEV ? "/vendor/sql-wasm.js" : `${SQL_JS_CDN}/sql-wasm.js`;

// Returns today's date string (YYYY-MM-DD) in Kyiv local time. The GSUA/SBS
// datasets reconcile to Kyiv time; the RU MoD hook uses its own MSK variant.
export function getKyivDateString(): string {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });
}

// Turn a sql.js result set into an array of plain column→value objects.
export function queryRows<T>(db: Database, sql: string): T[] {
  const results = db.exec(sql);
  if (!results.length) return [];
  const { columns, values } = results[0];
  return values.map((row) => {
    const obj: Record<string, unknown> = {};
    columns.forEach((col, i) => (obj[col] = row[i]));
    return obj as T;
  });
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

// Fetch an entire SQLite DB and open it via sql.js (whole-file, no httpvfs).
// `label` names the dataset in error messages (e.g. "SBS", "RU losses").
export async function loadWholeDb(url: string, label: string): Promise<Database> {
  await loadSqlJsScript();

  const wasmResponse = await fetch(SQL_WASM_URL);
  if (!wasmResponse.ok) throw new Error(`Failed to fetch sql-wasm.wasm: ${wasmResponse.status}`);
  const wasmBinary = await wasmResponse.arrayBuffer();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const initSqlJs = (window as any)["initSqlJs"] as (config: {
    wasmBinary: ArrayBuffer;
  }) => Promise<{ Database: new (data: Uint8Array) => Database }>;

  const SQL = await initSqlJs({ wasmBinary });

  const response = await fetch(url + `?bust=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`${label} database not available at ${url} (HTTP ${response.status})`);
  const buffer = await response.arrayBuffer();
  // SPA fallbacks can return index.html for missing routes — validate the
  // SQLite magic header before handing bytes to sql.js for a clear error.
  const bytes = new Uint8Array(buffer);
  const MAGIC = "SQLite format 3\0";
  const head = String.fromCharCode(...bytes.slice(0, MAGIC.length));
  if (head !== MAGIC) {
    throw new Error(`${label} database not available at ${url} (got ${bytes.byteLength} bytes that aren't a SQLite file — usually means the file is missing and the dev server returned index.html)`);
  }
  return new SQL.Database(bytes);
}
