/// <reference types="node" />
// The RU air-attacks queries on an in-memory sql.js DB, schema as piterfm's:
// what reaches the tooltips for the two cases that are easy to get silently
// wrong — counts the Air Force withheld, and weapon sub-types itemized inside
// another weapon's row. The SQL is the thing under test, so it runs for real.
// e2e/undisclosed-counts and e2e/subtype-breakdown keep one hover each, for
// these reaching the screen.
import initSqlJs, { type Database } from "sql.js";
import { beforeAll, describe, expect, it } from "vitest";
import {
  installDisclosureAwareViews, queryDaily, queryDailyAggBreakdown, queryDailyBreakdownByCategory, queryGlobalStats,
} from "@/data/ruAirAttacksDb";
import { breakdownToRows } from "@/components/TooltipTable";
import type { ModelBreakdownEntry } from "@/types";

const WITHHELD = "2026-10-07";        // reported, no figures: the 0s are placeholders
const REAL_ZERO = "2026-10-06";       // disclosed, nothing launched
const INTERCEPTS_ONLY = "2026-10-05"; // a withheld report that gave its intercepts
const SUBTYPES = "2026-10-04";        // UAV row itemizing a Banderol and a jet-powered Geran
const ROWED_SEPARATELY = "2026-10-03"; // the same itemization, but the report also rowed it
const PLAIN = "2026-10-02";
const MAX_DAY = "2026-10-01";          // the largest disclosed ballistic count: 7
const END = "2026-10-08", DAYS = 8;

let db: Database;
beforeAll(async () => {
  const SQL = await initSqlJs();
  db = new SQL.Database();
  db.run(`
    CREATE TABLE missile_attacks (
      time_start TEXT, time_end TEXT, model TEXT, launch_place TEXT, target TEXT,
      launched INTEGER, destroyed INTEGER, source TEXT,
      attack_date TEXT, category TEXT, scraped_at TEXT, status_data TEXT DEFAULT '',
      destroyed_types TEXT DEFAULT '',
      num_hit_location TEXT DEFAULT '', num_fall_fragment_location TEXT DEFAULT ''
    );
    CREATE VIEW missile_attacks_latest AS SELECT * FROM missile_attacks;
  `);
  // `impacts` as piterfm stores them: [hit, debris], text, "" for none.
  const row = (date: string, model: string, category: string, launched: number, destroyed: number,
    { status = "", types = "", source, impacts = ["", ""] }:
      { status?: string; types?: string; source?: string; impacts?: [string, string] } = {}) =>
    db.run("INSERT INTO missile_attacks VALUES (?, ?, ?, '', '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [
      `${date} 18:00`, `${date} 09:00`, model, launched, destroyed, source ?? `kpszsu/${date}/${model}`,
      date, category, `${date}T12:00:00+00:00`, status, types, ...impacts,
    ]);

  row(WITHHELD, "Iskander-M and 3M22 Zircon", "ballistic", 0, 0, { status: "hidden" });
  row(WITHHELD, "Shahed-136/131", "drone", 50, 40);
  row(REAL_ZERO, "Iskander-M", "ballistic", 0, 0);
  row(INTERCEPTS_ONLY, "Iskander-M", "ballistic", 3, 1);
  row(INTERCEPTS_ONLY, "C-400 and Iskander-M", "ballistic", 2, 2, { status: "hidden" });
  // A Python dict repr, as piterfm publishes it — and a sub-type with no
  // `destroyed` key at all.
  // Locations hit / debris are one figure per REPORT. Two reports this day,
  // each with its own: they add up.
  row(SUBTYPES, "Shahed-136/131", "drone", 104, 94,
    { types: "{'Banderol': {'launched': 4, 'destroyed': 4}, 'Turbojet': {'launched': 9}}", impacts: ["12.0", "4.0"] });
  row(SUBTYPES, "X-101", "cruise", 10, 5, { impacts: ["4.0", "1.0"] });
  // One report, two rows, and piterfm copies its figure onto both: counted once.
  row(ROWED_SEPARATELY, "Shahed-136/131", "drone", 105, 95,
    { types: "{'Banderol': {'launched': 2, 'destroyed': 2}}", source: "kpszsu/shared", impacts: ["15.0", "5.0"] });
  row(ROWED_SEPARATELY, "Banderol", "cruise", 2, 2, { source: "kpszsu/shared", impacts: ["15.0", "5.0"] });
  row(PLAIN, "Shahed-136/131", "drone", 102, 92);
  row(MAX_DAY, "Iskander-M", "ballistic", 7, 1);
  installDisclosureAwareViews(db);
});

const day = (date: string) => queryDaily(db, DAYS, END).find((r) => r.date === date)!;
const models = (cat: "drone" | "cruise" | "ballistic", date: string) =>
  queryDailyBreakdownByCategory(db, cat, DAYS, END).get(date) ?? [];
const entry = (list: ModelBreakdownEntry[], model: string) => list.find((e) => e.model === model);

describe("withheld counts", () => {
  it("a disclosed zero stays a zero", () => {
    expect(day(REAL_ZERO).ballistic_launched).toBe(0);
    expect(day(REAL_ZERO).undisclosed).toBeUndefined();
  });

  it("a withheld day is a gap, flagged — not a zero", () => {
    expect(day(WITHHELD).ballistic_launched).toBeNull();
    expect(day(WITHHELD).undisclosed).toEqual(["ballistic"]);
    // The total sums what was disclosed: a lower bound, not a gap.
    expect(day(WITHHELD).all_launched).toBe(50);
  });

  it("a withheld report's intercepts count, its launched as a lower bound", () => {
    expect(day(INTERCEPTS_ONLY).ballistic_launched).toBe(5);
    expect(entry(models("ballistic", INTERCEPTS_ONLY), "C-400 and Iskander-M"))
      .toMatchObject({ launched: 2, intercepted: 2, lowerBound: true });
  });

  it("the aggregate breakdown marks the withheld category, not 0", () => {
    const agg = queryDailyAggBreakdown(db, DAYS, END).get(WITHHELD)!;
    expect(agg.find((e) => e.model === "Ballistic Missiles")).toMatchObject({ undisclosed: true });
  });

  it("the MAX / MED stats read off disclosed days", () => {
    // The withheld day is null in the series they're taken over (above);
    // MAX is the largest disclosed count.
    expect(queryGlobalStats(db).ballistic.launched.max).toBe(7);
  });
});

describe("weapon sub-types", () => {
  it("one of another category is carved out of the UAV row and counted under it", () => {
    const drones = models("drone", SUBTYPES);
    expect(entry(drones, "Banderol")).toBeUndefined();
    expect(entry(drones, "Shahed-136/131")).toMatchObject({ launched: 100, intercepted: 90 });
    // A sibling of the other cruise rows, adding to the category total.
    const cruise = models("cruise", SUBTYPES);
    expect(entry(cruise, "Banderol")).toMatchObject({ launched: 4, intercepted: 4 });
    expect(entry(cruise, "Banderol")?.nested).toBeFalsy();
    expect(day(SUBTYPES).cruise_launched).toBe(14);
  });

  it("one of the parent's own kind stays nested under it, its unnamed intercepts unknown", () => {
    const drones = models("drone", SUBTYPES);
    const parent = drones.findIndex((e) => e.model === "Shahed-136/131");
    expect(drones[parent + 1]).toMatchObject({ model: "of which jet-powered", nested: true, launched: 9, intercepted: null });
  });

  it("is not repeated when the same report also gave it a row of its own", () => {
    expect(models("drone", ROWED_SEPARATELY).some((e) => e.nested)).toBe(false);
    expect(entry(models("drone", ROWED_SEPARATELY), "Shahed-136/131")).toMatchObject({ launched: 105 });
  });

  it("a day with no itemization has no sub-type rows", () => {
    expect(models("drone", PLAIN).some((e) => e.nested)).toBe(false);
  });
});

// What the tooltip makes of those entries (TooltipTable's breakdownToRows).
describe("breakdownToRows", () => {
  const text = (v: unknown): string =>
    v == null ? "" : typeof v === "object" && "props" in v
      ? [(v as { props: { children: unknown } }).props.children].flat().map(text).join("")
      : String(v);

  it("a withheld entry reads 'not disclosed', with no subset or share", () => {
    const [r] = breakdownToRows([{ model: "Ballistic Missiles", launched: 0, intercepted: 0, undisclosed: true }], "#000", { totalForShare: 10 });
    expect(text(r.value)).toBe("not disclosed");
    expect(r.subset).toBeUndefined();
    expect(r.share).toBeUndefined();
  });

  it("a lower bound reads '≥ N', and gets no change against last period", () => {
    const [r] = breakdownToRows([{ model: "C-400 and Iskander-M", launched: 2, intercepted: 2, lowerBound: true }], "#000", { totalForShare: 5 });
    expect(text(r.value)).toBe("≥ 2");
    expect(r.share).toBe(40);
    expect(r.vsPrev).toBeNull();
  });

  it("a nested sub-type is indented, shareless, and its unknown intercepts an em dash", () => {
    const rows = breakdownToRows(models("drone", SUBTYPES), "#000", { totalForShare: 109 });
    const nested = rows.find((r) => r.label === "↳ of which jet-powered")!;
    expect(text(nested.subset)).toBe("—");
    expect(nested.share).toBeUndefined();
    expect(rows.indexOf(nested)).toBe(rows.findIndex((r) => r.label === "Shahed-136/131") + 1);
  });
});

// Locations hit / hit by falling debris (PLAIN gives no figure at all).
describe("impact figures", () => {
  it("counts a figure copied onto two rows of one report once", () => {
    expect(day(ROWED_SEPARATELY)).toMatchObject({ impact_hit: 15, impact_debris: 5 });
  });

  it("adds up two reports of a day", () => {
    expect(day(SUBTYPES)).toMatchObject({ impact_hit: 16, impact_debris: 5 });
  });

  it("leaves a day without a figure a gap, out of the stats", () => {
    expect(day(PLAIN)).toMatchObject({ impact_hit: null, impact_debris: null });
    // Only the two days with a figure, 16 and 15: read as 0s, the five days
    // without one would pull the median down to 0.
    expect(queryGlobalStats(db).impacts!.impact_hit).toMatchObject({ max: 16, median: 16, total: 31 });
  });
});
