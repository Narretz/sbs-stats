import { describe, expect, it } from "vitest";
import { spreadTerritoryReports, type CitTerritoryReport } from "@/utils/citTerritory";

const report = (report_date: string, window_days: number, ua: number, occ: number, ru: number,
                unattributed = 0): CitTerritoryReport =>
  ({ report_date, window_days, uaControlled: ua, occupiedUkraine: occ, russia: ru, unattributed });

describe("spreadTerritoryReports", () => {
  it("covers the whole window, leaving uncovered days null rather than zero", () => {
    const out = spreadTerritoryReports([report("2026-09-02", 1, 10, 4, 6)], "2026-09-01", "2026-09-03");
    expect(out.map((r) => r.date)).toEqual(["2026-09-01", "2026-09-02", "2026-09-03"]);
    expect(out.map((r) => r.uaControlled)).toEqual([null, 10, null]);
    expect(out[0].report_date).toBeNull();
  });

  it("sums occupied Ukraine and Russia into the Russian-controlled band", () => {
    const [r] = spreadTerritoryReports([report("2026-09-02", 1, 10, 4, 6)], "2026-09-02", "2026-09-02");
    expect(r.ruControlled).toBe(10);
  });

  it("spreads a weekend report over both its days at half each", () => {
    // Saturday + Sunday arrive as one post dated Sunday. Pinning it to Sunday
    // would draw a spike there and a hole on Saturday.
    const out = spreadTerritoryReports(
      [report("2026-09-06", 2, 30, 8, 12, 2)], "2026-09-05", "2026-09-06");
    for (const r of out) {
      expect(r).toMatchObject({
        report_date: "2026-09-06", window_days: 2,
        uaControlled: 15, occupiedUkraine: 4, russia: 6, ruControlled: 10, unattributed: 1,
      });
    }
  });

  it("keeps a weekend report's first day when only that day is in the window", () => {
    const out = spreadTerritoryReports([report("2026-09-06", 2, 30, 8, 12)], "2026-09-01", "2026-09-05");
    expect(out.at(-1)).toMatchObject({ date: "2026-09-05", uaControlled: 15 });
  });
});
