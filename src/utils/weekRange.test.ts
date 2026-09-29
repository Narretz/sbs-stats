import { describe, expect, it } from "vitest";
import type { DailyDataPoint } from "@/types";
import {
  aggregateWeekly, formatWeekMonth, formatWeekRange, mondaysBetween, quarterTicks,
  weekStart, weeklyWindow,
} from "./weekRange";

const day = (date: string, value: number | null, note?: string): DailyDataPoint =>
  ({ date, value, is_today: false, ...(note ? { note } : {}) });

describe("weekStart", () => {
  it("is the Monday of the week, Sunday belonging to the week before it", () => {
    expect(weekStart("2026-09-21")).toBe("2026-09-21"); // Monday
    expect(weekStart("2026-09-27")).toBe("2026-09-21"); // Sunday
    expect(weekStart("2026-09-29")).toBe("2026-09-28"); // Tuesday
  });
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

describe("weeklyWindow", () => {
  it("counts whole weeks back from the one containing the end date", () => {
    // Tuesday 29 Sep: its own week (28 Sep–) plus three before it.
    expect(weeklyWindow("2026-09-29", 4)).toEqual({
      firstMonday: "2026-09-07", lastMonday: "2026-09-28", days: 23,
    });
  });
  it("never starts before the invasion's week, however wide", () => {
    const w = weeklyWindow("2022-03-10", 52);
    expect(w.firstMonday).toBe("2022-02-21");
    expect(weeklyWindow("2026-09-29", "all").firstMonday).toBe("2022-02-21");
  });
});

describe("aggregateWeekly", () => {
  const MON = "2026-09-14";

  it("sums the seven days of a finished week", () => {
    const daily = mondaysBetween(MON, MON).flatMap(() =>
      [14, 15, 16, 17, 18, 19, 20].map((d) => day(`2026-09-${d}`, 10)));
    expect(aggregateWeekly(daily, MON, "2026-09-20")).toEqual([
      { date: MON, value: 70, is_today: false },
    ]);
  });

  it("is a gap, not zero, when no day of the week has a figure", () => {
    expect(aggregateWeekly([day("2026-09-15", null)], MON, "2026-09-20")).toEqual([
      { date: MON, value: null, is_today: false },
    ]);
  });

  it("says so when the sum is missing days", () => {
    // A withheld day comes back null — summing past it would read as a quiet week.
    const [w] = aggregateWeekly(
      [day("2026-09-14", 5), day("2026-09-15", null), day("2026-09-16", 5)],
      MON, "2026-09-20",
    );
    expect(w.value).toBe(10);
    expect(w.note).toMatch(/^Sum of 2 of 7 days — the other 5 have no figure/);
  });

  it("flags the week still in progress, counting only the days so far", () => {
    // Ends Wednesday: three days elapsed, all reported → no undercount note.
    const [w] = aggregateWeekly(
      [day("2026-09-14", 1), day("2026-09-15", 2), day("2026-09-16", 3)],
      MON, "2026-09-16",
    );
    expect(w).toEqual({ date: MON, value: 6, is_today: true });
  });

  it("carries day-level caveats up, once each", () => {
    const flag = "possible double-count";
    const [w] = aggregateWeekly(
      [14, 15, 16, 17, 18, 19, 20].map((d) => day(`2026-09-${d}`, 1, d < 16 ? flag : undefined)),
      MON, "2026-09-20",
    );
    expect(w.note).toBe(flag);
  });
});

describe("formatting", () => {
  it("names the month once inside a month", () => {
    expect(formatWeekRange("2026-09-21")).toBe("21–27 Sep 2026");
  });
  it("names both months across a month boundary", () => {
    expect(formatWeekRange("2026-09-28")).toBe("28 Sep – 4 Oct 2026");
  });
  it("names both years across New Year", () => {
    expect(formatWeekRange("2025-12-29")).toBe("29 Dec 2025 – 4 Jan 2026");
  });
  it("labels quarter starts only", () => {
    expect(quarterTicks(mondaysBetween("2025-12-22", "2026-04-13"))).toEqual([
      "2026-01-05", "2026-04-06",
    ]);
    expect(formatWeekMonth("2026-04-06")).toBe("Apr 2026");
  });
});
