// The GSUA app copy's precomputed tables (scripts/gsua/app_db.sql) against
// the live SQL they stand in for (gsuaSql.ts): the frontend reads completed
// months from the tables and recent ones live, so the two must give the same
// rows — on a database that has every case the queries take care over.
//
// A database in a unit test, against vitest.config's rule of thumb: it is
// in-memory sql.js on synthetic rows (no browser, no data/), and the thing
// under test is the SQL itself, which no e2e assertion could hold to the row.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import initSqlJs, { type Database } from "sql.js";
import { beforeAll, describe, expect, it } from "vitest";
import {
  canonicalDailySql, coverageMonthlySql, pickCanonicalDaily, recentFloor, sumMetricsByMonth,
} from "@/utils/gsuaSql";
import { GSUA_METRIC_KEYS } from "@/types";

const ROOT = join(__dirname, "..", "..");

function rows(db: Database, sql: string): Record<string, unknown>[] {
  const res = db.exec(sql)[0];
  if (!res) return [];
  return res.values.map((v) => Object.fromEntries(res.columns.map((c, i) => [c, v[i]])));
}

type Post = {
  source: string; id: string; date: string; snap: string | null; scraped: string;
  ce: number | null; air?: number; dirs?: [string, number, number?][]; // [direction, attacks, group size]
};

// Two settled months and a little of a third.
const POSTS: Post[] = [
  // An edited post: only the later version (ce 30) may count.
  { source: "telegram", id: "1", date: "2026-07-01", snap: "2026-07-02T08:00:00", scraped: "a", ce: 10, dirs: [["Pokrovsk", 9]] },
  { source: "telegram", id: "1", date: "2026-07-01", snap: "2026-07-02T08:00:00", scraped: "b", ce: 30, dirs: [["Pokrovsk", 20], ["Lyman", 5]] },
  // Telegram and Facebook the same day: telegram wins.
  { source: "telegram", id: "2", date: "2026-07-02", snap: "2026-07-03T08:00:00", scraped: "a", ce: 40, air: 3, dirs: [["Pokrovsk", 15]] },
  { source: "facebook", id: "f2", date: "2026-07-02", snap: "2026-07-03T08:00:00", scraped: "a", ce: 99, air: 99 },
  // Two non-telegram sources, no telegram: the tie-break (by source name).
  { source: "facebook", id: "f3", date: "2026-07-03", snap: "2026-07-04T08:00:00", scraped: "a", ce: 7 },
  { source: "twitter", id: "t3", date: "2026-07-03", snap: "2026-07-04T08:00:00", scraped: "a", ce: 8 },
  // An interim and the wrap-up: the later snapshot counts.
  { source: "telegram", id: "4a", date: "2026-08-01", snap: "2026-08-01T22:00:00", scraped: "a", ce: 20, dirs: [["Pokrovsk", 4]] },
  { source: "telegram", id: "4b", date: "2026-08-01", snap: "2026-08-02T08:00:00", scraped: "a", ce: 25, dirs: [["Pokrovsk", 6]] },
  // Multipart: one report in two posts, directions split between them.
  { source: "telegram", id: "5a", date: "2026-08-02", snap: "2026-08-03T08:00:00", scraped: "a", ce: 50, dirs: [["Pokrovsk", 10]] },
  { source: "telegram", id: "5b", date: "2026-08-02", snap: "2026-08-03T08:00:00", scraped: "a", ce: null, dirs: [["Lyman", 12]] },
  // Double-posted: the same report under two ids — counted once.
  { source: "telegram", id: "6a", date: "2026-08-03", snap: "2026-08-04T08:00:00", scraped: "a", ce: 60, dirs: [["Pokrovsk", 30]] },
  { source: "telegram", id: "6b", date: "2026-08-03", snap: "2026-08-04T08:00:00", scraped: "a", ce: 60, dirs: [["Pokrovsk", 30]] },
  // A joint line ("На X і Y напрямках 8"): 8 stored on each, group size 2.
  { source: "telegram", id: "7", date: "2026-08-04", snap: "2026-08-05T08:00:00", scraped: "a", ce: 20, dirs: [["Kurakhove", 8, 2], ["Pokrovsk", 8, 2]] },
  // No snapshot: never canonical.
  { source: "telegram", id: "8", date: "2026-08-05", snap: null, scraped: "a", ce: 500 },
  // A month with no direction lines at all.
  { source: "telegram", id: "9", date: "2026-09-01", snap: "2026-09-02T08:00:00", scraped: "a", ce: 15 },
];

let db: Database;

beforeAll(async () => {
  const SQL = await initSqlJs({ locateFile: (f) => join(ROOT, "node_modules/sql.js/dist", f) });
  db = new SQL.Database();
  db.run(readFileSync(join(ROOT, "scripts/gsua/schema.sql"), "utf8"));
  for (const p of POSTS) {
    db.run(
      `INSERT INTO posts (source, source_id, date, message_date, snapshot_at, text, url, scraped_at, combat_engagements, air_strikes)
       VALUES (?, ?, ?, ?, ?, '', 'u', ?, ?, ?)`,
      [p.source, p.id, p.date, p.date, p.snap, p.scraped, p.ce, p.air ?? null],
    );
    for (const [dir, attacks, group] of p.dirs ?? []) {
      db.run(
        `INSERT INTO directions (source, source_id, scraped_at, direction, attacks, attacks_group_size) VALUES (?, ?, ?, ?, ?, ?)`,
        [p.source, p.id, p.scraped, dir, attacks, group ?? 1],
      );
    }
  }
  db.run(readFileSync(join(ROOT, "scripts/gsua/app_db.sql"), "utf8"));
});

const byKey = (r: Record<string, unknown>) => `${r.date}|${r.direction ?? ""}`;

describe("gsua_monthly", () => {
  it("is the live monthly sums, month for month", () => {
    const live = sumMetricsByMonth(pickCanonicalDaily(rows(db, canonicalDailySql())));
    const table = rows(db, "SELECT * FROM gsua_monthly ORDER BY month");
    expect(table.map((r) => r.month)).toEqual([...live.keys()].sort());
    for (const r of table) {
      for (const k of GSUA_METRIC_KEYS) expect([r.month, k, r[k]]).toEqual([r.month, k, live.get(String(r.month))![k]]);
    }
  });

  it("reads the cases the way they're meant", () => {
    const m = Object.fromEntries(rows(db, "SELECT month, combat_engagements AS ce, air_strikes AS air FROM gsua_monthly").map((r) => [r.month, r]));
    // Jul: 30 (edited) + 40 (telegram over facebook's 99) + 7 (facebook over twitter).
    expect(m["2026-07"]).toEqual({ month: "2026-07", ce: 77, air: 3 });
    // Aug: 25 (wrap-up) + 50 (multipart) + 60 (double post, once) + 20; the
    // snapshot-less 500 never.
    expect(m["2026-08"].ce).toBe(155);
  });
});

describe("gsua_direction_monthly", () => {
  it("is the live monthly coverage, row for row", () => {
    const live = rows(db, coverageMonthlySql()).sort((a, b) => byKey(a).localeCompare(byKey(b)));
    const table = rows(db, "SELECT date, total, direction, attacks FROM gsua_direction_monthly").sort((a, b) => byKey(a).localeCompare(byKey(b)));
    expect(table).toEqual(live);
  });

  it("reads the cases the way they're meant", () => {
    const aug = Object.fromEntries(
      rows(db, "SELECT direction, attacks FROM gsua_direction_monthly WHERE date = '2026-08'").map((r) => [r.direction, r.attacks]),
    );
    // 6 (wrap-up, not the interim's 4) + 10 (multipart) + 30 (double post,
    // once) + 4 (half the joint 8).
    expect(aug).toEqual({ Pokrovsk: 50, Lyman: 12, Kurakhove: 4 });
    // A month without direction lines still has its total.
    expect(rows(db, "SELECT total, direction FROM gsua_direction_monthly WHERE date = '2026-09'")).toEqual([{ total: 15, direction: null }]);
  });
});

describe("a floored live query", () => {
  // What the hook does: table months before the floor, live ones from it.
  it("gives the recent months exactly as the unfloored one does", () => {
    const floor = "2026-08-01";
    const full = rows(db, coverageMonthlySql()).filter((r) => String(r.date) >= "2026-08");
    expect(rows(db, coverageMonthlySql(floor))).toEqual(full);
    const fullDaily = pickCanonicalDaily(rows(db, canonicalDailySql())).filter((r) => String(r.date) >= floor);
    expect(pickCanonicalDaily(rows(db, canonicalDailySql(floor)))).toEqual(fullDaily);
  });

  it("starts at the month before today's", () => {
    expect(recentFloor("2026-10-06")).toBe("2026-09-01");
    expect(recentFloor("2026-01-15")).toBe("2025-12-01");
  });
});
