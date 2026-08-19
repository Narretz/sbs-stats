import initSqlJs from "sql.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// e2e fixtures are generated from scratch — they never copy or mutate the
// committed data/*.db (which are large and CI-updated, so their freshness and
// values can't be relied on in tests). We build the smallest synthetic dataset
// each suite needs, using only the committed *schema* files for structure:
//   - SBS  → data/schema.sql        (daily_stats)
//   - GSUA → scripts/gsua/schema.sql (posts)
//
// Freshness matters only for the end-of-day projection, which keys off the real
// "today": so we anchor the synthetic days to the current Kyiv date and stop
// "today" mid-day, leaving the projection something to extrapolate. Everything
// else (ranges, MAX/MED scope) is made deterministic by the values we choose.
export const FIXED_TODAY = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });

const ROOT = process.cwd();
const FIX_DIR = path.join(ROOT, "e2e", "fixtures");

// ISO date `offset` days from FIXED_TODAY (UTC math so DST can't shift it).
function dayISO(offset) {
  const d = new Date(`${FIXED_TODAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

// computeEodProjection needs ≥5 complete prior days sharing today's checkpoint
// (MIN_SAMPLES), so 7 history days gives margin while staying tiny.
const HISTORY_DAYS = 7;

// ── SBS: hourly cumulative `daily_stats` ──────────────────────────────────────
// Each day is a cumulative intraday curve (checkpoint hour → share of the day's
// settled total). "today" stops at hour 14 (~62%), so the projection has a tail
// to estimate; prior days run to hour 23 (100%).
const SBS_CURVE = [[0, 0.05], [6, 0.30], [10, 0.50], [14, 0.62], [18, 0.85], [22, 0.97], [23, 1.0]];
// Columns the tested charts read (headline metrics + two target types). All get
// the same per-checkpoint value — the tests only care about shape, not realism.
const SBS_COLS = [
  "personnel_killed", "personnel_wounded", "total_targets_hit", "total_targets_destroyed",
  "total_personnel_casualties", "flights_strike", "flights_recon",
  "hit_1", "destroyed_1", "hit_24", "destroyed_24",
];

function buildSbs(SQL) {
  const db = new SQL.Database();
  db.run(fs.readFileSync(path.join(ROOT, "data/schema.sql"), "utf8"));
  const ins = db.prepare(
    `INSERT INTO daily_stats (date, hour, ${SBS_COLS.join(", ")}) ` +
    `VALUES (?, ?, ${SBS_COLS.map(() => "?").join(", ")})`
  );
  const insertDay = (date, curve, settled) => {
    for (const [hour, frac] of curve) {
      const v = Math.round(settled * frac);
      ins.run([date, hour, ...SBS_COLS.map(() => v)]);
    }
  };
  // History: complete days. Distinct settled totals so the visible-window MAX is
  // a real number well below the sentinel below.
  for (let d = 1; d <= HISTORY_DAYS; d++) insertDay(dayISO(-d), SBS_CURVE, 100 + d * 10);
  // Today: partial, up to hour 14.
  insertDay(FIXED_TODAY, SBS_CURVE.filter(([h]) => h <= 14), 95);
  // Far-past sentinel: a huge total_personnel_casualties on an ancient date that
  // lies OUTSIDE every day-range window (max 180d) but INSIDE the full dataset —
  // so stat-scope.spec can assert "All data" surfaces it and "Window data" can't.
  ins.run(["2020-01-01", 23, ...SBS_COLS.map((c) => (c === "total_personnel_casualties" ? 999999 : 0))]);
  ins.free();
  fs.writeFileSync(path.join(FIX_DIR, "sbs.db"), Buffer.from(db.export()));
  db.close();
}

// ── GSUA: snapshot-versioned `posts` ──────────────────────────────────────────
// A GS day settles the next morning: 16:00 (~70%) → 22:00 (~90%) → next-day
// 08:00 (100%, the final). "today" stops at 22:00, so the projection extrapolates
// from prior days' 22:00→final ratio.
const GSUA_METRICS = [
  "combat_engagements", "missile_strikes", "missiles_used", "air_strikes",
  "kabs_dropped", "kamikaze_drones", "shellings", "mlrs_shellings",
];

function buildGsua(SQL) {
  const db = new SQL.Database();
  db.run(fs.readFileSync(path.join(ROOT, "scripts/gsua/schema.sql"), "utf8"));
  const cols = ["source", "source_id", "date", "message_date", "snapshot_at", "text", "url", ...GSUA_METRICS, "scraped_at"];
  const ins = db.prepare(`INSERT INTO posts (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`);
  const insDir = db.prepare(
    `INSERT INTO directions (source, source_id, scraped_at, direction, attacks, ` +
    `ongoing, attacks_group_size, attacks_group_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  // Insert a post. When `dupCoverage` is set, also write a TWIN post (same
  // date / snapshot / metrics, different source_id) and attach one direction
  // (Pokrovsk = 60% of this post's combat_engagements) to BOTH copies. The GS
  // channel occasionally double-posts the same report this way; the coverage
  // query must dedupe (MAX per direction) or the twin's directions get counted
  // twice — inflating `attributed` past `total` so `unattributed` clamps to 0.
  // 60% is deliberate: deduped attribution reads a clean 60%, but the doubled
  // 120% clamps to 100% — a crisp fixed-vs-regressed signal for the summary.
  const post = (date, snapshotAt, frac, settled, tag, dupCoverage = false) => {
    const v = Math.round(settled * frac);
    const row = {
      source: "telegram", date,
      message_date: `${snapshotAt}Z`, snapshot_at: snapshotAt,
      text: "synthetic", url: "https://t.me/test", scraped_at: `${date}T23:59:59`,
    };
    for (const m of GSUA_METRICS) row[m] = v;
    const ids = dupCoverage ? [`${date}-${tag}`, `${date}-${tag}b`] : [`${date}-${tag}`];
    for (const source_id of ids) {
      ins.run(cols.map((c) => ({ ...row, source_id })[c]));
      if (dupCoverage) {
        insDir.run(["telegram", source_id, row.scraped_at, "Pokrovsk",
          Math.round(v * 0.6), null, 1, null]);
      }
    }
  };
  const day = (date, settled, withFinal) => {
    post(date, `${date}T16:00:00`, 0.70, settled, "16");
    // The canonical (latest-snapshot) post per date carries the coverage
    // duplicate: the next-morning 08:00 final once the day has settled, else
    // the same-day 22:00 for the still-open current day.
    post(date, `${date}T22:00:00`, 0.90, settled, "22", !withFinal);
    // The settled total lands the next morning, still labelled the report day.
    if (withFinal) post(date, `${dayISO(dayOffset(date) + 1)}T08:00:00`, 1.0, settled, "08", true);
  };
  const dayOffset = (date) =>
    Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${FIXED_TODAY}T00:00:00Z`)) / 86_400_000);
  for (let d = 1; d <= HISTORY_DAYS; d++) day(dayISO(-d), 50 + d * 5, true);
  day(FIXED_TODAY, 48, false); // today is still open — no morning-after final yet
  ins.free();
  insDir.free();
  fs.writeFileSync(path.join(FIX_DIR, "ru-attacks-gsua.db"), Buffer.from(db.export()));
  db.close();
}

// ── RU air attacks: append-versioned `missile_attacks` + the `_latest` view ────
// Small by design: enough days to draw a line, plus the two cases the
// disclosure handling has to tell apart on the *same* chart —
//   day -2: ballistic 0 launched, disclosed  → a real zero, plots at 0
//   day -1: ballistic withheld upstream      → unknown, plots as a gap
// piterfm writes a placeholder 0 for the withheld row too, so a fixture that
// only had one of these cases couldn't catch the two being confused.
function buildRuAirAttacks(SQL) {
  const db = new SQL.Database();
  db.run(`
    CREATE TABLE missile_attacks (
      time_start TEXT, time_end TEXT, model TEXT, launch_place TEXT, target TEXT,
      launched INTEGER, destroyed INTEGER, source TEXT,
      attack_date TEXT, category TEXT, scraped_at TEXT, status_data TEXT DEFAULT ''
    );
    CREATE VIEW missile_attacks_latest AS
      SELECT t.* FROM missile_attacks t JOIN (
        SELECT time_start, time_end, model, launch_place, target, source, MAX(scraped_at) ms
        FROM missile_attacks
        GROUP BY time_start, time_end, model, launch_place, target, source
      ) l ON t.time_start = l.time_start AND t.time_end = l.time_end AND t.model = l.model
         AND t.launch_place = l.launch_place AND t.target = l.target AND t.source = l.source
         AND t.scraped_at = l.ms;
  `);
  const cols = ["time_start", "time_end", "model", "launch_place", "target",
    "launched", "destroyed", "source", "attack_date", "category", "scraped_at", "status_data"];
  const ins = db.prepare(`INSERT INTO missile_attacks (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`);
  const row = (date, model, category, launched, destroyed, status = "") =>
    ins.run([`${date} 18:00`, `${date} 09:00`, model, "Kursk oblast", "Kyiv oblast",
      launched, destroyed, `synthetic-${date}-${model}`, date, category, `${date}T12:00:00+00:00`, status]);

  for (let d = HISTORY_DAYS; d >= 1; d--) {
    const date = dayISO(-d);
    row(date, "Shahed-136/131", "drone", 100 + d, 90 + d);
    row(date, "X-101", "cruise", 10, 5);
    if (d === 1) {
      // Withheld: reported, but no figures — the 0s here are placeholders.
      row(date, "Iskander-M and 3M22 Zircon", "ballistic", 0, 0, "hidden");
    } else if (d === 2) {
      row(date, "Iskander-M", "ballistic", 0, 0); // genuinely nothing launched
    } else {
      row(date, "Iskander-M", "ballistic", d, 1);
    }
  }
  ins.free();
  fs.writeFileSync(path.join(FIX_DIR, "ru-air-attacks-gsua.db"), Buffer.from(db.export()));
  db.close();
}

export async function buildFixtures() {
  fs.mkdirSync(FIX_DIR, { recursive: true });
  const SQL = await initSqlJs({ locateFile: (f) => path.join(ROOT, "node_modules/sql.js/dist", f) });
  buildSbs(SQL);
  buildGsua(SQL);
  buildRuAirAttacks(SQL);
}

// Run the build when invoked directly (`node e2e/build-fixtures.mjs`).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  buildFixtures().then(
    () => console.log(`e2e fixtures generated for ${FIXED_TODAY}`),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
