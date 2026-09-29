import { describe, expect, it } from "vitest";
import type { ZelenskyWeekRow } from "@/types";
import { formatHedged, formatWeekRange, formatWeekTick, mondaysBetween, quarterTicks, toWeeklyDataset } from "./zelenskyWeekly";

const row = (period_start: string, drones: number | null): ZelenskyWeekRow => ({
  period: "x", period_start, period_end: "x", post_id: 1, posted_at: "x", url: "x",
  drones, drones_bound: drones == null ? null : "at_least",
  bombs: null, bombs_bound: null, missiles: null, missiles_bound: null,
});

describe("mondaysBetween", () => {
  it("steps a week at a time, both ends inclusive", () => {
    expect(mondaysBetween("2025-12-22", "2026-01-05")).toEqual([
      "2025-12-22", "2025-12-29", "2026-01-05",
    ]);
  });
  it("is empty when the range is inverted", () => {
    expect(mondaysBetween("2026-01-05", "2025-12-22")).toEqual([]);
  });
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

describe("formatWeekRange", () => {
  it("names the month once inside a month", () => {
    expect(formatWeekRange("2026-09-21")).toBe("21–27 Sep 2026");
  });
  it("names both months across a month boundary", () => {
    expect(formatWeekRange("2026-09-28")).toBe("28 Sep – 4 Oct 2026");
  });
  it("names both years across New Year", () => {
    expect(formatWeekRange("2025-12-29")).toBe("29 Dec 2025 – 4 Jan 2026");
  });
});

describe("quarterTicks", () => {
  it("labels the first Monday of each quarter, and only that", () => {
    expect(quarterTicks(mondaysBetween("2025-12-22", "2026-04-13"))).toEqual([
      "2026-01-05", "2026-04-06",
    ]);
  });
  it("formats a tick as month and year", () => {
    expect(formatWeekTick("2026-04-06")).toBe("Apr 2026");
  });
});
