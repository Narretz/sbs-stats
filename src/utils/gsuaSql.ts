// The GSUA queries that have a precomputed twin in the app copy, kept out of
// the hook so a test can run them against the twin (gsuaSql.test.ts): the app
// copy is built with scripts/gsua/app_db.sql, which materialises the same
// answers for whole months, and the two must never drift.
//
// Why the twin: over httpvfs a query costs a range request per page it
// touches, and these aggregate the whole history — the monthly coverage alone
// read ~1,070 pages (~4.4 MB) per visit, for numbers that only change when a
// scrape lands. The hook reads completed months from the tables and runs the
// SQL here only for the recent months (`floor`), which a scrape can still
// change; a copy built without the tables gets the SQL over everything.
import { GSUA_METRIC_KEYS, directionAxis, type GsuaDirectionCoverageRow, type GsuaMetricKey } from "@/types";

export const METRIC_COLS = GSUA_METRIC_KEYS.map((k) => `MAX(${k}) AS ${k}`).join(", ");

// `posts`/`directions` are edit-versioned: a post (source, source_id) can have
// several rows, one per scrape that saw changed text, keyed by scraped_at. Reads
// must use only the latest version per post. This "no newer version exists"
// subquery is index-only (the PK covers it) and flattens in SQLite, so an outer
// WHERE date>=… still pushes down — important over httpvfs. Substituted for the
// `posts` table in every query; direction joins additionally match scraped_at.
export const LATEST_POSTS = `(
  SELECT p.* FROM posts p
  WHERE NOT EXISTS (
    SELECT 1 FROM posts n
    WHERE n.source = p.source AND n.source_id = p.source_id
      AND n.scraped_at > p.scraped_at
  )
)`;

// The first day of the month before `today`'s: months from here on are read
// live, since a scrape can still change them — the current month's days, and
// the previous month's last day, whose wrap-up report lands the next morning.
export function recentFloor(today: string): string {
  const [y, m] = today.split("-").map(Number);
  const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
  return `${prev}-01`;
}

const dateFrom = (col: string, floor?: string) => (floor ? `${col} >= '${floor}'` : "1");

// One row per (date, source) — the source's latest snapshot of that day — with
// telegram first among a date's rows, then by source name so a date with two
// other sources picks the same one every time (and the same one app_db.sql's
// gsua_daily picks). `pickCanonicalDaily` keeps the first per date.
export function canonicalDailySql(floor?: string): string {
  return `
    WITH per_date_source AS (
      SELECT date, source, MAX(snapshot_at) AS latest_snapshot, ${METRIC_COLS}
      FROM ${LATEST_POSTS} posts
      WHERE ${dateFrom("date", floor)}
      GROUP BY date, source, snapshot_at
    ),
    last_per_date_source AS (
      SELECT date, source, MAX(latest_snapshot) AS latest_snapshot
      FROM per_date_source
      GROUP BY date, source
    )
    SELECT p.date, p.source, ${GSUA_METRIC_KEYS.join(", ")}
    FROM per_date_source p
    INNER JOIN last_per_date_source l
      ON p.date = l.date AND p.source = l.source AND p.latest_snapshot = l.latest_snapshot
    ORDER BY p.date ASC,
             CASE p.source WHEN 'telegram' THEN 0 ELSE 1 END ASC,
             p.source ASC
  `;
}

export function pickCanonicalDaily<R extends Record<string, unknown>>(rows: R[]): R[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const d = String(row.date);
    if (seen.has(d)) return false;
    seen.add(d);
    return true;
  });
}

// Month → each metric summed over the month's canonical days. A metric no day
// reported sums to 0, not null — the monthly charts' long-standing reading.
export function sumMetricsByMonth(
  daily: Record<string, unknown>[],
): Map<string, Record<GsuaMetricKey, number>> {
  const byMonth = new Map<string, Record<GsuaMetricKey, number>>();
  for (const row of daily) {
    const month = String(row.date).slice(0, 7);
    let bucket = byMonth.get(month);
    if (!bucket) {
      bucket = Object.fromEntries(GSUA_METRIC_KEYS.map((k) => [k, 0])) as Record<GsuaMetricKey, number>;
      byMonth.set(month, bucket);
    }
    for (const k of GSUA_METRIC_KEYS) {
      const v = row[k];
      if (typeof v === "number") bucket[k] += v;
    }
  }
  return byMonth;
}

// Per month: the canonical days' combat engagements, and each direction's
// share of them. Rows are (date = month, total, direction, attacks), one per
// direction a month has (one with a null direction for a month with none).
export function coverageMonthlySql(floor?: string): string {
  return `
    WITH latest_posts AS (
      -- With a floor, applied HERE: latest_posts is referenced twice, so
      -- SQLite materialises it, and unbounded that means every post's latest
      -- version across all history.
      SELECT p.* FROM posts p
      WHERE ${dateFrom("p.date", floor)}
        AND NOT EXISTS (
          SELECT 1 FROM posts n
          WHERE n.source = p.source AND n.source_id = p.source_id
            AND n.scraped_at > p.scraped_at
        )
    ),
    per_date_source_snap AS (
      SELECT date, source, snapshot_at,
             MAX(combat_engagements) AS combat_engagements
      FROM latest_posts
      WHERE snapshot_at IS NOT NULL
      GROUP BY date, source, snapshot_at
    ),
    best_per_date AS (
      SELECT date, source, snapshot_at, combat_engagements
      FROM (
        SELECT *,
               ROW_NUMBER() OVER (
                 PARTITION BY date
                 ORDER BY CASE source WHEN 'telegram' THEN 0 ELSE 1 END,
                          snapshot_at DESC
               ) AS rn
        FROM per_date_source_snap
      ) t
      WHERE rn = 1
    ),
    month_totals AS (
      SELECT substr(date, 1, 7) AS month,
             SUM(combat_engagements) AS total
      FROM best_per_date
      GROUP BY substr(date, 1, 7)
    ),
    per_date_direction AS (
      -- Fair-share for paired-anchor rows ("На X і Y напрямках N…" stores N on
      -- each with attacks_group_size = 2). Dedup WITHIN a date first with MAX
      -- (not SUM): a double-posted report (same directions under two message
      -- ids, e.g. 2026-07-11) shares one (date, source, snapshot_at), so the
      -- join re-expands it — MAX takes each direction's single value and still
      -- merges multipart posts (each direction lives in one part).
      SELECT b.date AS date,
             d.direction AS direction,
             MAX(d.attacks * 1.0 / d.attacks_group_size) AS attacks
      FROM best_per_date b
      LEFT JOIN latest_posts p
        ON p.source = b.source AND p.date = b.date AND p.snapshot_at = b.snapshot_at
      LEFT JOIN directions d
        ON d.source = p.source AND d.source_id = p.source_id
        AND d.scraped_at = p.scraped_at
      GROUP BY b.date, d.direction
    ),
    month_direction_attacks AS (
      SELECT substr(date, 1, 7) AS month,
             direction AS direction,
             SUM(attacks) AS attacks
      FROM per_date_direction
      GROUP BY substr(date, 1, 7), direction
    )
    SELECT m.month AS date, m.total,
           a.direction, a.attacks
    FROM month_totals m
    LEFT JOIN month_direction_attacks a ON a.month = m.month
    ORDER BY m.month ASC
  `;
}

// Coverage rows → one chart row per month.
export function pivotCoverageMonthly(rows: Record<string, unknown>[]): GsuaDirectionCoverageRow[] {
  const byMonth = new Map<string, GsuaDirectionCoverageRow>();
  for (const r of rows) {
    const date = String(r.date);
    const total = typeof r.total === "number" ? r.total : null;
    let row = byMonth.get(date);
    if (!row) {
      row = {
        date, total, attributed: 0, unattributed: 0,
        byDirection: {}, is_today: false,
      };
      byMonth.set(date, row);
    }
    // Key by AXIS, not raw direction: the two halves of a jointly-reported
    // pair land on the same key and re-add to the figure the report gave
    // (0.5 + 0.5 = 1). `attributed` is unaffected — folding two rows into
    // one changes which bucket the credit lands in, not how much there is.
    const raw = r.direction == null ? null : String(r.direction);
    const dir = raw == null ? null : directionAxis(raw);
    const attacks = typeof r.attacks === "number" ? r.attacks : 0;
    if (dir && attacks > 0) {
      row.byDirection[dir] = (row.byDirection[dir] ?? 0) + attacks;
      row.attributed += attacks;
      // The fold happened on this date, so the line was joint here. Only
      // the folded-away member trips this, so it records once per axis.
      if (raw !== dir) (row.mergedAxes ??= []).push(dir);
    }
  }
  for (const row of byMonth.values()) {
    row.unattributed = row.total == null ? 0 : Math.max(0, row.total - row.attributed);
  }
  return [...byMonth.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

// Per day: the canonical report's combat engagements and each direction's
// fair share of it. Rows are (date, snapshot_at, total, direction, attacks),
// one per direction a day has (one with a null direction for a day with
// none). `start` / `end` are SQL date expressions; without them, all history —
// what app_db.sql's gsua_coverage_daily / gsua_direction_daily hold.
export function coverageDailySql(start?: string, end?: string): string {
  return `
    WITH latest_posts AS (
      -- The date window is applied HERE, not in per_date_source_snap below.
      -- latest_posts is referenced twice (here + the final join), so SQLite
      -- MATERIALISES it; without the window it would SCAN all of posts (all
      -- history) to resolve every post's latest version, then filter. With
      -- the window it SEARCHes idx_posts_date for just the window's rows —
      -- ~75 for 30 days vs ~2600 total — a big cut in httpvfs range fetches.
      -- Safe: 'date' is invariant across a post's edit-versions, so the
      -- filter never splits a (source, source_id) version chain.
      SELECT p.* FROM posts p
      WHERE ${start ? `p.date >= ${start}` : "1"}
        AND ${end ? `p.date <= ${end}` : "1"}
        AND NOT EXISTS (
          SELECT 1 FROM posts n
          WHERE n.source = p.source AND n.source_id = p.source_id
            AND n.scraped_at > p.scraped_at
        )
    ),
    per_date_source_snap AS (
      -- One row per (date, source, snapshot_at), collapsing multipart posts;
      -- MAX(combat_engagements) mirrors the daily_combined view's merge.
      SELECT date, source, snapshot_at,
             MAX(combat_engagements) AS combat_engagements
      FROM latest_posts
      WHERE snapshot_at IS NOT NULL
      GROUP BY date, source, snapshot_at
    ),
    best_per_date AS (
      -- Pick the canonical row per date: prefer telegram, then latest snapshot.
      SELECT date, source, snapshot_at, combat_engagements
      FROM (
        SELECT *,
               ROW_NUMBER() OVER (
                 PARTITION BY date
                 ORDER BY CASE source WHEN 'telegram' THEN 0 ELSE 1 END,
                          snapshot_at DESC
               ) AS rn
        FROM per_date_source_snap
      ) t
      WHERE rn = 1
    )
    SELECT
      b.date,
      b.snapshot_at       AS snapshot_at,
      b.combat_engagements AS total,
      d.direction         AS direction,
      -- Fair-share: paired-anchor sentences ("На X і Y напрямках N ...")
      -- store the raw N on each row with attacks_group_size = k; the
      -- honest per-direction contribution is N/k, so k=2 halves the
      -- credit each direction takes. Solo entries have group_size=1
      -- and pass through unchanged.
      -- MAX (not SUM) over the joined posts: best_per_date collapses a
      -- (date, source, snapshot_at) to one group, but the join to
      -- latest_posts re-expands it to every source_id sharing that key.
      -- When the GS channel double-posts the SAME report (two message
      -- ids, identical directions — e.g. 2026-07-11 msgs 41031/41041),
      -- SUM would count each direction twice and inflate 'attributed'
      -- past the day total. A given direction is written once per report, so
      -- MAX yields its single value — and still merges multipart posts,
      -- where each direction lives in exactly one part.
      MAX(d.attacks * 1.0 / d.attacks_group_size) AS attacks
    FROM best_per_date b
    LEFT JOIN latest_posts p
      ON p.source = b.source AND p.date = b.date AND p.snapshot_at = b.snapshot_at
    LEFT JOIN directions d
      ON d.source = p.source AND d.source_id = p.source_id AND d.scraped_at = p.scraped_at
    -- b.snapshot_at is functionally dependent on b.date (best_per_date is
    -- one row per date), so grouping by it splits nothing; it's listed to
    -- carry the value out rather than rely on a bare column.
    GROUP BY b.date, b.snapshot_at, d.direction
    ORDER BY b.date ASC
  `;
}

// Coverage rows → one chart row per day.
export function pivotCoverageDaily(rows: Record<string, unknown>[], today: string): GsuaDirectionCoverageRow[] {
  // Pivot to one row per date.
  const byDate = new Map<string, GsuaDirectionCoverageRow>();
  for (const r of rows) {
    const date = String(r.date);
    const total = typeof r.total === "number" ? r.total : null;
    let row = byDate.get(date);
    if (!row) {
      row = {
        date, total, attributed: 0, unattributed: 0,
        byDirection: {},
        snapshot_at: typeof r.snapshot_at === "string" ? r.snapshot_at : null,
        is_today: date === today,
      };
      byDate.set(date, row);
    }
    // Key by AXIS, not raw direction: the two halves of a jointly-reported
    // pair land on the same key and re-add to the figure the report gave
    // (0.5 + 0.5 = 1). `attributed` is unaffected — folding two rows into
    // one changes which bucket the credit lands in, not how much there is.
    const raw = r.direction == null ? null : String(r.direction);
    const dir = raw == null ? null : directionAxis(raw);
    const attacks = typeof r.attacks === "number" ? r.attacks : 0;
    if (dir && attacks > 0) {
      row.byDirection[dir] = (row.byDirection[dir] ?? 0) + attacks;
      row.attributed += attacks;
      // The fold happened on this date, so the line was joint here. Only
      // the folded-away member trips this, so it records once per axis.
      if (raw !== dir) (row.mergedAxes ??= []).push(dir);
    }
  }
  for (const row of byDate.values()) {
    row.unattributed = row.total == null ? 0 : Math.max(0, row.total - row.attributed);
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

// The settled days' chart rows from the app copy's tables: each day's total
// and attributed from gsua_coverage_daily, and from gsua_direction_daily only
// the directions read (a ranking of a picked direction reads its own rows,
// not every direction's). Folded to axes as pivotCoverageDaily folds them. No
// snapshot: a settled day's report is its wrap-up.
export function coverageFromTables(
  totals: Record<string, unknown>[],
  directions: Record<string, unknown>[],
): GsuaDirectionCoverageRow[] {
  const byDate = new Map<string, GsuaDirectionCoverageRow>();
  for (const r of totals) {
    const total = typeof r.total === "number" ? r.total : null;
    const attributed = Number(r.attributed);
    byDate.set(String(r.date), {
      date: String(r.date), total, attributed,
      unattributed: total == null ? 0 : Math.max(0, total - attributed),
      byDirection: {}, snapshot_at: null, is_today: false,
    });
  }
  for (const r of directions) {
    const row = byDate.get(String(r.date));
    if (!row) continue;
    const raw = String(r.direction);
    const dir = directionAxis(raw);
    row.byDirection[dir] = (row.byDirection[dir] ?? 0) + Number(r.attacks);
    if (raw !== dir) (row.mergedAxes ??= []).push(dir);
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}
