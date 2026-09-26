import { describe, expect, it } from "vitest";
import { filterDailyRows, isoWeekday, monthDailyWindow, weekdayPredicate } from "@/utils/dayRange";

// 2026-09-07 is a Monday; the fixture is two full weeks, Mon → Sun.
const rows = Array.from({ length: 14 }, (_, i) => ({
  date: `2026-09-${String(7 + i).padStart(2, "0")}`,
}));
const dates = (r: { date: string }[]) => r.map((x) => x.date);

describe("isoWeekday", () => {
  it("follows Date#getDay numbering", () => {
    expect(isoWeekday("2026-09-07")).toBe(1);
    expect(isoWeekday("2026-09-13")).toBe(0);
  });
});

describe("weekdayPredicate", () => {
  it("is undefined when no weekday is picked", () => {
    expect(weekdayPredicate([])).toBeUndefined();
  });
});

describe("filterDailyRows", () => {
  it("keeps everything in live mode with no weekday picked", () => {
    expect(filterDailyRows(rows, { selectedDate: "", days: 7, weekdays: [] })).toEqual(rows);
  });

  it("filters weekdays in live mode", () => {
    expect(dates(filterDailyRows(rows, { selectedDate: "", days: 7, weekdays: [1] })))
      .toEqual(["2026-09-07", "2026-09-14"]);
  });

  it("filters weekdays with an end date picked, too", () => {
    // The regression: picking an end date used to switch this filter off.
    expect(dates(filterDailyRows(rows, { selectedDate: "2026-09-20", days: 14, weekdays: [0, 6] })))
      .toEqual(["2026-09-12", "2026-09-13", "2026-09-19", "2026-09-20"]);
  });

  it("applies the window and the weekdays together", () => {
    expect(dates(filterDailyRows(rows, { selectedDate: "2026-09-16", days: 3, weekdays: [1, 2] })))
      .toEqual(["2026-09-14", "2026-09-15"]);
  });
});

describe("monthDailyWindow", () => {
  const today = "2026-09-26";

  it("ends a past month on its last day and spans all of it", () => {
    expect(monthDailyWindow("2026-08", today)).toEqual({ date: "2026-08-31", days: 31 });
    expect(monthDailyWindow("2026-06", today)).toEqual({ date: "2026-06-30", days: 30 });
  });

  it("knows February, leap or not", () => {
    expect(monthDailyWindow("2026-02", today)).toEqual({ date: "2026-02-28", days: 28 });
    expect(monthDailyWindow("2024-02", today)).toEqual({ date: "2024-02-29", days: 29 });
  });

  it("crosses the year end", () => {
    expect(monthDailyWindow("2025-12", today)).toEqual({ date: "2025-12-31", days: 31 });
  });

  it("follows the month in progress live, from its first day", () => {
    expect(monthDailyWindow("2026-09", today)).toEqual({ date: "", days: 26 });
  });

  it("accepts a first-of-month date as the month", () => {
    expect(monthDailyWindow("2026-08-01", today)).toEqual({ date: "2026-08-31", days: 31 });
  });

  it("has nothing for a month that hasn't started, or for garbage", () => {
    expect(monthDailyWindow("2026-10", today)).toBeNull();
    expect(monthDailyWindow("Aug 2026", today)).toBeNull();
  });
});
