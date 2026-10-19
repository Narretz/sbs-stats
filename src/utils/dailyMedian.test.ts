import { describe, expect, it } from "vitest";
import { attachDailyMedians, attachDayCounts, dailyMediansByMonth, dayCountsByMonth } from "@/utils/dailyMedian";

const day = (date: string, a: number | null, b?: number | null) => ({ date, values: { a, b } });

describe("dailyMediansByMonth", () => {
  it("takes each month's median day, per metric", () => {
    const m = dailyMediansByMonth([
      day("2026-09-01", 10, 1), day("2026-09-02", 30, 2), day("2026-09-03", 20, 3),
      day("2026-10-01", 5, 9),
    ], ["a", "b"], "2026-10-13");
    expect(m.get("2026-09")).toEqual({ a: 20, b: 2 });
    expect(m.get("2026-10")).toEqual({ a: 5, b: 9 });
  });

  it("takes the upper middle of an even count, like every MED", () => {
    const m = dailyMediansByMonth([day("2026-09-01", 10), day("2026-09-02", 40)], ["a"], "2026-10-01");
    expect(m.get("2026-09")).toEqual({ a: 40 });
  });

  it("skips gaps and today's partial day", () => {
    const m = dailyMediansByMonth([
      day("2026-10-01", 50, null), day("2026-10-02", 60, null),
      day("2026-10-03", 1, 7), // today, half reported
    ], ["a", "b"], "2026-10-03");
    expect(m.get("2026-10")).toEqual({ a: 60 });
  });

  it("writes <key>_daily_median onto a month's row", () => {
    const row: { date: string } & Record<string, unknown> = { date: "2026-09" };
    attachDailyMedians(row, new Map([["2026-09", { a: 20 }]]));
    expect(row.a_daily_median).toBe(20);
  });
});

describe("dayCountsByMonth", () => {
  it("counts each month's days with a figure, per metric, before today", () => {
    const m = dayCountsByMonth([
      day("2023-04-30", 36, null),
      day("2023-05-01", 41, null), day("2023-05-02", null, 3), day("2023-05-02", 30, null),
      day("2023-05-19", 7, 2), // today: still filling in
    ], ["a", "b"], "2023-05-19");
    expect(m.get("2023-04")).toEqual({ a: 1, b: 0 });
    // A date seen twice (two sources) counts once.
    expect(m.get("2023-05")).toEqual({ a: 2, b: 1 });
  });

  it("writes them as <key>_days", () => {
    const row: { date: string } & Record<string, unknown> = { date: "2023-04" };
    attachDayCounts(row, new Map([["2023-04", { a: 1, b: 0 }]]));
    expect(row).toEqual({ date: "2023-04", a_days: 1, b_days: 0 });
  });
});
