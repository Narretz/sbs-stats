import initSqlJs from "sql.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The end-of-day projection only renders for the *current* day, which the app
// derives from the wall clock (Europe/Kyiv). Rather than freeze the browser
// clock (which stalls recharts' line animation and kills hover/tooltips), we
// inject the synthetic partial "today" at the *real* current Kyiv date, so no
// clock mocking is needed. Fixtures are copies of the committed DBs with that
// partial day injected:
//   - SBS: hours 0–14 of the most recent prior day (~62% complete)
//   - GSUA: the 16:00 + 22:00 cumulative snapshots (settles next morning)
// The committed DBs are CI-updated continuously, so today always sits within the
// projection's 90-day history window.
export const FIXED_TODAY = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });

const ROOT = process.cwd();
const FIX_DIR = path.join(ROOT, "e2e", "fixtures");

const cols = (db, table) => db.exec(`PRAGMA table_info(${table})`)[0].values.map((v) => String(v[1]));
const scalar = (db, sql) => {
  const r = db.exec(sql);
  return r.length && r[0].values.length ? r[0].values[0][0] : null;
};
const rows = (db, sql) => {
  const r = db.exec(sql);
  if (!r.length) return [];
  const { columns, values } = r[0];
  return values.map((v) => Object.fromEntries(columns.map((c, i) => [c, v[i]])));
};

export async function buildFixtures() {
  fs.mkdirSync(FIX_DIR, { recursive: true });
  const SQL = await initSqlJs({ locateFile: (f) => path.join(ROOT, "node_modules/sql.js/dist", f) });

  // ── SBS: partial today = hours 0..14 of the most recent day that has hour 14 ──
  const sbs = new SQL.Database(fs.readFileSync(path.join(ROOT, "data/sbs.db")));
  sbs.run(`DELETE FROM daily_stats WHERE date='${FIXED_TODAY}'`);
  const sbsCols = cols(sbs, "daily_stats");
  const sbsSrc = scalar(sbs, `SELECT MAX(date) FROM daily_stats WHERE date < '${FIXED_TODAY}' AND hour = 14`);
  const sbsRows = rows(sbs, `SELECT ${sbsCols.join(",")} FROM daily_stats WHERE date='${sbsSrc}' AND hour<=14 ORDER BY hour`);
  const sbsIns = sbs.prepare(`INSERT INTO daily_stats (${sbsCols.join(",")}) VALUES (${sbsCols.map(() => "?").join(",")})`);
  for (const r of sbsRows) {
    r.date = FIXED_TODAY;
    sbsIns.run(sbsCols.map((c) => r[c]));
  }
  sbsIns.free();
  fs.writeFileSync(path.join(FIX_DIR, "sbs.db"), Buffer.from(sbs.export()));
  sbs.close();

  // ── GSUA: partial today = 16:00 + 22:00 cumulative snapshots of a recent day ──
  const gsua = new SQL.Database(fs.readFileSync(path.join(ROOT, "data/ru-attacks-gsua.db")));
  gsua.run(`DELETE FROM posts WHERE date='${FIXED_TODAY}'`);
  const pCols = cols(gsua, "posts");
  const gSrc = scalar(gsua, `SELECT MAX(date) FROM posts WHERE date < '${FIXED_TODAY}' AND substr(snapshot_at,12,5)='22:00'`);
  const gRows = rows(gsua, `SELECT ${pCols.join(",")} FROM posts WHERE date='${gSrc}' AND substr(snapshot_at,12,5) IN ('16:00','22:00')`);
  const gIns = gsua.prepare(`INSERT INTO posts (${pCols.join(",")}) VALUES (${pCols.map(() => "?").join(",")})`);
  for (const r of gRows) {
    const tod = String(r.snapshot_at).slice(11, 19); // HH:MM:SS
    r.date = FIXED_TODAY;
    r.snapshot_at = `${FIXED_TODAY}T${tod}`;
    r.source_id = `test-${tod}-${r.source}`; // keep (source, source_id) PK unique
    gIns.run(pCols.map((c) => r[c] ?? null));
  }
  gIns.free();
  fs.writeFileSync(path.join(FIX_DIR, "ru-attacks-gsua.db"), Buffer.from(gsua.export()));
  gsua.close();
}

// Run the build when invoked directly (`node e2e/build-fixtures.mjs`).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  buildFixtures().then(
    () => console.log(`e2e fixtures built for ${FIXED_TODAY}`),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
