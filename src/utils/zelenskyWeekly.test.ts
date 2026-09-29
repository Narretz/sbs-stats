import { describe, expect, it } from "vitest";
import type { ZelenskyWeekRow } from "@/types";
import { formatHedged, mondaysBetween, toWeeklyDataset } from "./zelenskyWeekly";

const row = (period_start: string, drones: number | null): ZelenskyWeekRow => ({
  period: "x", period_start, period_end: "x", post_id: 1, posted_at: "x", url: "x",
  drones, drones_bound: drones == null ? null : "at_least",
  bombs: null, bombs_bound: null, missiles: null, missiles_bound: null,
});

describe("toWeeklyDataset", () => {
  it("keeps weeks without a tally as null slots, not zeros", () => {
    const data = toWeeklyDataset(
      [row("2026-01-05", 1100), row("2026-01-19", null)],
      "drones",
      mondaysBetween("2026-01-05", "2026-01-19"),
    );
    expect(data).toEqual([
      { date: "2026-01-05", value: 1100 },
      { date: "2026-01-12", value: null },  // no post that week
      { date: "2026-01-19", value: null },  // post, but it didn't name drones
    ]);
  });
});

describe("formatHedged", () => {
  it("prefixes the source's hedge", () => {
    expect(formatHedged(3170, "at_least")).toBe("> 3,170");
    expect(formatHedged(1300, "at_most")).toBe("< 1,300");
    expect(formatHedged(60, "approx")).toBe("≈ 60");
    expect(formatHedged(74, "exact")).toBe("74");
  });
  it("says a missing figure was not reported", () => {
    expect(formatHedged(null, null)).toBe("not reported");
  });
});
