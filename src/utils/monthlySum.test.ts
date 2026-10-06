import { describe, expect, it } from "vitest";
import { sumByMonth } from "@/utils/monthlySum";

const days = (month: string, n: number, value: number | null = 1) =>
  Array.from({ length: n }, (_, i) => ({ date: `${month}-${String(i + 1).padStart(2, "0")}`, value }));

describe("sumByMonth", () => {
  it("sums each month, in order", () => {
    const out = sumByMonth([...days("2026-09", 30, 2), ...days("2026-08", 31, 1)], "2026-10-06");
    expect(out.map((p) => [p.date, p.value, p.is_today])).toEqual([["2026-08", 31, false], ["2026-09", 60, false]]);
    expect(out.every((p) => p.note === undefined)).toBe(true);
  });

  it("a month with no figure at all is a gap, not 0", () => {
    expect(sumByMonth(days("2026-08", 31, null), "2026-10-06")[0].value).toBeNull();
  });

  it("doesn't flag days without a figure — a direction absent from a report mostly had nothing", () => {
    const out = sumByMonth([...days("2026-08", 20), ...days("2026-08", 31, null).slice(20)], "2026-10-06");
    expect(out[0].value).toBe(20);
    expect(out[0].note).toBeUndefined();
  });

  it("marks the month still running, counted against the days so far", () => {
    const out = sumByMonth(days("2026-10", 6), "2026-10-06");
    expect(out[0]).toMatchObject({ date: "2026-10", value: 6, is_today: true });
    expect(out[0].note).toBe("Month so far — 6 days in.");
  });
});
