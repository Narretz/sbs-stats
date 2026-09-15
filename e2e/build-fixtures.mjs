import initSqlJs from "sql.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// e2e fixtures are generated from scratch — they never copy or mutate the
// committed data/*.db (which are large and CI-updated, so their freshness and
// values can't be relied on in tests). We build the smallest synthetic dataset
// each suite needs, using only the committed *schema* files for structure:
//   - SBS       → data/schema.sql              (daily_stats, monthly_stats)
//   - SBS units → scripts/sbs_units/schema.sql (units, unit_*_stats)
//   - Rubikon   → scripts/rubikon/schema.sql   (reports, counters)
//   - GSUA      → scripts/gsua/schema.sql      (posts)
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

// Month `offset` months back from FIXED_TODAY's month, as "YYYY-MM".
function monthISO(offset) {
  const [y, m] = FIXED_TODAY.slice(0, 7).split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + offset, 1));
  return d.toISOString().slice(0, 7);
}

// computeEodProjection needs ≥5 complete prior days sharing today's checkpoint
// (MIN_SAMPLES), so 7 history days gives margin while staying tiny.
const HISTORY_DAYS = 7;
// Which day carries the RU air-attacks sub-type itemization; the spec derives
// the same date from FIXED_TODAY.
export const SUBTYPE_DAY_OFFSET = 4;
// The day whose sub-type was also given a row of its own by the same report.
export const ROWED_SEPARATELY_DAY_OFFSET = 5;

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
  // `hit_21` (Shelters) is the one target here that NO canonical compare row
  // maps, so it is what puts an "Only in SBS" section on the compare page —
  // the section that regressed by reading the entity's snapshot instead of
  // the column's. Keep at least one unmapped native populated.
  "hit_21", "destroyed_21",
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

  // Monthly rows for the grouping, so the monthly page's default "all" option
  // has something to draw. Values are an order of magnitude above any unit's,
  // which is what lets a test tell "showing the grouping" from "showing a
  // unit" without reading the title.
  const insM = db.prepare(
    `INSERT INTO monthly_stats (date, data_collected_at, ${SBS_COLS.join(", ")}) ` +
    `VALUES (?, ?, ${SBS_COLS.map(() => "?").join(", ")})`
  );
  for (let k = 2; k >= 0; k--) {
    const month = monthISO(-k);
    insM.run([`${month}-01`, `${FIXED_TODAY}T00:00:00Z`, ...SBS_COLS.map(() => 5000 + k)]);
  }
  insM.free();

  fs.writeFileSync(path.join(FIX_DIR, "sbs.db"), Buffer.from(db.export()));
  db.close();
}

// ── SBS sub-units: `units` + capture-bucketed stat tables ────────────────────
// The monthly page's unit picker needs three distinguishable cases: an active
// unit, a retired one (listed under its own optgroup, labelled "(retired)"),
// and a unit with NO monthly rows — which the hook filters out of the registry
// entirely, because an option that resolves to an empty page is worse than no
// option. Values are chosen so a test can tell the units apart by sight.
export const SBS_UNITS = [
  { slug: "alpha-unit", title: "Alpha Unit", active: 1, months: 3, hit: 100 },
  { slug: "bravo-unit", title: "Bravo Unit", active: 1, months: 3, hit: 200 },
  // Retired: no daily rows, and its months stop well in the past — which is
  // also what makes DataWindow report it as far behind.
  { slug: "gone-unit", title: "Gone Unit", active: 0, months: 2, hit: 50, retiredMonths: true },
  // Registry row with no stats at all: must NOT appear in the picker.
  { slug: "empty-unit", title: "Empty Unit", active: 1, months: 0, hit: 0 },
];

const UNIT_COLS = [
  "personnel_killed", "personnel_wounded", "total_targets_hit", "total_targets_destroyed",
  "total_personnel_casualties", "flights_strike", "flights_recon",
  "hit_1", "destroyed_1", "hit_24", "destroyed_24",
  "hit_21", "destroyed_21",   // unmapped — see SBS_COLS
];

function buildSbsUnits(SQL) {
  const db = new SQL.Database();
  db.run(fs.readFileSync(path.join(ROOT, "scripts/sbs_units/schema.sql"), "utf8"));
  // The per-target columns are added at ingest time from the live payload, so
  // the fixture adds the ones the charts read the same way.
  for (const t of ["unit_daily_stats", "unit_monthly_stats", "unit_yearly_stats"]) {
    for (const c of ["hit_1", "destroyed_1", "hit_24", "destroyed_24", "hit_21", "destroyed_21"]) {
      db.run(`ALTER TABLE ${t} ADD COLUMN ${c} INTEGER`);
    }
  }

  const insUnit = db.prepare(
    `INSERT INTO units (slug, subdivision_id, division_id, title_uk, title_en, color,
                        display_order, active, has_daily, first_month, last_month, scraped_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const insStat = (table) => db.prepare(
    `INSERT INTO ${table} (unit_slug, date, capture_bucket, captured_at, ${UNIT_COLS.join(", ")})
     VALUES (?, ?, ?, ?, ${UNIT_COLS.map(() => "?").join(", ")})`
  );
  const insMonthly = insStat("unit_monthly_stats");
  const insDaily = insStat("unit_daily_stats");

  SBS_UNITS.forEach((u, i) => {
    // Retired units' months sit a year back, so they can't collide with the
    // active ones' window and the "behind" wording is unambiguous.
    const base = u.retiredMonths ? -12 : 0;
    const months = Array.from({ length: u.months }, (_, k) => monthISO(base - k)).reverse();
    insUnit.run([
      u.slug, `sub-${u.slug}`, String(i), `${u.title} UK`, u.title, "#888",
      i, u.active, u.active, months[0] ?? null, months[months.length - 1] ?? null,
      `${FIXED_TODAY}T00:00:00Z`,
    ]);
    months.forEach((m, k) => {
      const v = u.hit + k;
      insMonthly.run([u.slug, `${m}-01`, FIXED_TODAY, `${FIXED_TODAY}T00:00:00Z`,
        ...UNIT_COLS.map(() => v)]);
    });
    // Only active units have a daily series — `prev_day` is the ingest's source
    // for it and retired units have no such period. That absence is what makes
    // the page fall back to the monthly max for their data window.
    if (u.active && u.months) {
      for (let d = 1; d <= 2; d++) {
        insDaily.run([u.slug, dayISO(-d), FIXED_TODAY, `${FIXED_TODAY}T00:00:00Z`,
          ...UNIT_COLS.map(() => u.hit)]);
      }
    }
  });
  insUnit.free();
  insMonthly.free();
  insDaily.free();
  fs.writeFileSync(path.join(FIX_DIR, "sbs-units.db"), Buffer.from(db.export()));
  db.close();
}

// ── Rubikon: monthly counters behind the `*_latest` views ────────────────────
// Needed only by the compare page, which is the one view that renders two
// entities side by side — and therefore the only place the "Only in <entity>"
// sections exist at all. Without a second fixtured entity those sections can't
// be tested, and the page would fall back to whatever data/rubikon.db happens
// to be on disk.
//
// Deliberately sparse: a couple of categories the SBS mapping shares, so rows
// populate on both sides, and NOTHING outside it — the "only in" sections are
// about counters one entity has and the other doesn't.
const RUBIKON_COUNTERS = [
  ["combat_sorties", "sorties", 4000],
  ["personnel", "engaged", 700],
  ["tanks", "engaged", 40],
];

function buildRubikon(SQL) {
  const db = new SQL.Database();
  db.run(fs.readFileSync(path.join(ROOT, "scripts/rubikon/schema.sql"), "utf8"));
  const insR = db.prepare(
    `INSERT INTO reports (post_id, scraped_at, posted_at, report_type, period,
                          period_start, period_end, url, body_text, text_hash)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  );
  const insC = db.prepare(
    `INSERT INTO counters (post_id, scraped_at, category, kind, value, bound, raw_label)
     VALUES (?,?,?,?,?,?,?)`
  );
  // Same three months the SBS fixture covers, so a column of each lines up.
  for (let k = 2; k >= 0; k--) {
    const month = monthISO(-k);
    const postId = 1000 + k;
    insR.run([postId, `${FIXED_TODAY}T00:00:00Z`, `${month}-03T09:00:00Z`, "monthly",
      month, `${month}-01`, `${month}-28`,
      `https://t.me/icpbtrubicon/${postId}`, "synthetic", `hash-${postId}`]);
    for (const [category, kind, base] of RUBIKON_COUNTERS) {
      insC.run([postId, `${FIXED_TODAY}T00:00:00Z`, category, kind, base + k, "exact", null]);
    }
  }
  insR.free();
  insC.free();
  fs.writeFileSync(path.join(FIX_DIR, "rubikon.db"), Buffer.from(db.export()));
  db.close();
}

// ── GSUA: snapshot-versioned `posts` ──────────────────────────────────────────
// A GS day settles the next morning: 16:00 (~70%) → 22:00 (~90%) → next-day
// 08:00 (100%, the final). "today" stops at 22:00, so the projection extrapolates
// from prior days' 22:00→final ratio.
const GSUA_METRICS = [
  "combat_engagements", "missile_strikes", "missiles_used", "air_strikes",
  "kabs_dropped", "kamikaze_drones", "shellings", "mlrs_shellings",
  "targets_destroyed",
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
//
// Day -4 additionally carries a `destroyed_types` cell on its UAV row — the
// sub-type itemization (Banderol / jet-powered airframes counted *inside* that
// row). Both of its shapes are seeded: one sub-type with intercepts itemized
// and one without, since "launched 9, intercepts not broken out" must not
// render as 9 launched / 0 intercepted.
//
// Day -5 seeds the older shape, where the same report *also* gave the weapon a
// row of its own (as on 2025-09-27: Shahed 593 + a Banderol row of 2, against a
// reported 595). There the itemization repeats that row rather than sitting
// inside the UAV count, so it must not render — hence the shared `source`,
// which is what tells the two shapes apart.
function buildRuAirAttacks(SQL) {
  const db = new SQL.Database();
  db.run(`
    CREATE TABLE missile_attacks (
      time_start TEXT, time_end TEXT, model TEXT, launch_place TEXT, target TEXT,
      launched INTEGER, destroyed INTEGER, source TEXT,
      attack_date TEXT, category TEXT, scraped_at TEXT, status_data TEXT DEFAULT '',
      destroyed_types TEXT DEFAULT ''
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
    "launched", "destroyed", "source", "attack_date", "category", "scraped_at", "status_data",
    "destroyed_types"];
  const ins = db.prepare(`INSERT INTO missile_attacks (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`);
  const row = (date, model, category, launched, destroyed, status = "", types = "", source = null) =>
    ins.run([`${date} 18:00`, `${date} 09:00`, model, "Kursk oblast", "Kyiv oblast",
      launched, destroyed, source ?? `synthetic-${date}-${model}`, date, category, `${date}T12:00:00+00:00`, status,
      types]);

  for (let d = HISTORY_DAYS; d >= 1; d--) {
    const date = dayISO(-d);
    // A Python dict repr, exactly as piterfm publishes it — single quotes, and
    // a sub-type that names no `destroyed` key at all.
    const types = d === SUBTYPE_DAY_OFFSET
      ? "{'Banderol': {'launched': 4, 'destroyed': 4}, 'Turbojet': {'launched': 9}}"
      : d === ROWED_SEPARATELY_DAY_OFFSET
        ? "{'Banderol': {'launched': 2, 'destroyed': 2}}"
        : "";
    const sharedPost = d === ROWED_SEPARATELY_DAY_OFFSET ? `synthetic-${date}-post` : null;
    row(date, "Shahed-136/131", "drone", 100 + d, 90 + d, "", types, sharedPost);
    if (d === ROWED_SEPARATELY_DAY_OFFSET) {
      // Same report, its own row — the itemization above is a repeat of this.
      row(date, "Banderol", "cruise", 2, 2, "", "", sharedPost);
    }
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
  buildSbsUnits(SQL);
  buildRubikon(SQL);
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
