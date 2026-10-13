import { describe, expect, it } from "vitest";
import {
  outcomesFromSql,
  projectCitMonth,
  reportDays,
  scaleOutcomes,
  stackTotal,
  spreadTerritoryReports,
  territoryTotals,
  type CitTerritoryReport,
} from "@/utils/citTerritory";
import type { CitKilledInjured } from "@/types";

const ki = (killed: number, injured: number): CitKilledInjured => ({ killed, injured });
const report = (report_date: string, window_days: number,
                ua: CitKilledInjured, occ: CitKilledInjured, ru: CitKilledInjured,
                unattributed = ki(0, 0)): CitTerritoryReport =>
  ({ report_date, window_days, outcomes: { uaControlled: ua, occupiedUkraine: occ, russia: ru, unattributed } });

describe("spreadTerritoryReports", () => {
  it("covers the whole window, leaving uncovered days null rather than zero", () => {
    const out = spreadTerritoryReports(
      [report("2026-09-02", 1, ki(2, 8), ki(1, 3), ki(0, 6))], "2026-09-01", "2026-09-03");
    expect(out.map((r) => r.date)).toEqual(["2026-09-01", "2026-09-02", "2026-09-03"]);
    expect(out.map((r) => r.uaControlled)).toEqual([null, 10, null]);
    expect(out[0].report_date).toBeNull();
    expect(out[0].outcomes).toBeNull();
  });

  it("sums occupied Ukraine and Russia into the Russian-controlled band", () => {
    const [r] = spreadTerritoryReports(
      [report("2026-09-02", 1, ki(2, 8), ki(1, 3), ki(0, 6))], "2026-09-02", "2026-09-02");
    expect(r.ruControlled).toBe(10);
  });

  it("spreads a weekend report over both its days at half each, outcomes too", () => {
    // Saturday + Sunday arrive as one post dated Sunday. Pinning it to Sunday
    // would draw a spike there and a hole on Saturday.
    const out = spreadTerritoryReports(
      [report("2026-09-06", 2, ki(4, 26), ki(2, 6), ki(0, 12), ki(0, 2))], "2026-09-05", "2026-09-06");
    for (const r of out) {
      expect(r).toMatchObject({
        report_date: "2026-09-06", window_days: 2,
        uaControlled: 15, occupiedUkraine: 4, russia: 6, ruControlled: 10, unattributed: 1,
      });
      expect(r.outcomes?.uaControlled).toEqual(ki(2, 13));
    }
  });

  it("keeps a weekend report's first day when only that day is in the window", () => {
    const out = spreadTerritoryReports(
      [report("2026-09-06", 2, ki(4, 26), ki(2, 6), ki(0, 12))], "2026-09-01", "2026-09-05");
    expect(out.at(-1)).toMatchObject({ date: "2026-09-05", uaControlled: 15 });
  });
});

describe("outcomes", () => {
  it("reads the per-part killed/injured columns, a missing cell as 0", () => {
    const o = outcomesFromSql({ uaControlled_killed: 3, uaControlled_injured: 9, russia_injured: 2 });
    expect(o.uaControlled).toEqual(ki(3, 9));
    expect(o.russia).toEqual(ki(0, 2));
    expect(o.occupiedUkraine).toEqual(ki(0, 0));
  });

  it("totals what the bars draw", () => {
    const o = report("2026-09-02", 1, ki(2, 8), ki(1, 3), ki(0, 6), ki(1, 0)).outcomes;
    expect(territoryTotals(o)).toEqual({
      uaControlled: 10, ruControlled: 10, occupiedUkraine: 4, russia: 6, unattributed: 1,
    });
  });

  it("scales back to a weekend report's whole", () => {
    const half = scaleOutcomes(report("2026-09-06", 2, ki(4, 26), ki(2, 6), ki(0, 12)).outcomes, 0.5);
    expect(scaleOutcomes(half, 2).uaControlled).toEqual(ki(4, 26));
  });
});

describe("projectCitMonth", () => {
  it("scales by the days reports covered, not the calendar", () => {
    expect(projectCitMonth("2026-09", 90, 9)).toEqual({ projected: 300, coveredDays: 9, daysInMonth: 30 });
  });

  it("leaves a complete month, or one with no report yet, unprojected", () => {
    expect(projectCitMonth("2026-09", 900, 30)).toBeNull();
    expect(projectCitMonth("2026-09", 0, 0)).toBeNull();
    expect(projectCitMonth("2026-09", null, 9)).toBeNull();
  });
});

describe("stackTotal", () => {
  it("sums the series present, and is a gap when none is", () => {
    expect(stackTotal({ a: 2, b: 3 }, ["a", "b"])).toBe(5);
    expect(stackTotal({ a: 2, b: null }, ["a", "b"])).toBe(2);
    expect(stackTotal({ a: null, b: null }, ["a", "b"])).toBeNull();
  });
});

describe("reportDays", () => {
  it("halves a weekend report over its two days, in the report's month", () => {
    expect(reportDays([
      { report_date: "2026-01-09", window_days: 1, values: { killed: 3 } },
      { report_date: "2026-02-01", window_days: 2, values: { killed: 8 } },
    ])).toEqual([
      { date: "2026-01-09", values: { killed: 3 } },
      // Saturday 31 Jan belongs to the report ending 1 Feb.
      { date: "2026-02-01", values: { killed: 4 } },
      { date: "2026-02-01", values: { killed: 4 } },
    ]);
  });
});
