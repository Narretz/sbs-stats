import { describe, expect, it } from "vitest";
import { filterDailyRows, isoWeekday, weekdayPredicate } from "@/utils/dayRange";

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
