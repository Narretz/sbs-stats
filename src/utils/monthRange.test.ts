import { describe, expect, it } from "vitest";
import { parseMonthsParam, windowStartMonth } from "@/utils/monthRange";
import {
  WINDOW_FLOOR, clampDays, daysBetweenInclusive, maxDaysFor, parseDaysParam,
  windowStartDate, windowStartSql,
} from "@/utils/dayRange";

describe("parseDaysParam", () => {
  it("takes any positive integer, not just the picker's presets", () => {
    expect(parseDaysParam("45")).toBe(45);
    expect(parseDaysParam("1")).toBe(1);
  });

  it("falls back for anything else", () => {
    // A hand-edited URL must land on the default rather than an empty chart.
    for (const raw of [null, "", "0", "-5", "7.5", "abc"]) {
      expect(parseDaysParam(raw), `for ${JSON.stringify(raw)}`).toBe(30);
    }
  });
});

describe("parseMonthsParam", () => {
  it("keeps the 'all' sentinel", () => {
    expect(parseMonthsParam("all")).toBe("all");
  });

  it("takes a positive integer and falls back otherwise", () => {
    expect(parseMonthsParam("24")).toBe(24);
    expect(parseMonthsParam("0")).toBe(12);
    expect(parseMonthsParam(null)).toBe(12);
    // A caller with its own default gets that one, not the global.
    expect(parseMonthsParam("nonsense", 6)).toBe(6);
    expect(parseMonthsParam(null, "all")).toBe("all");
  });
});

describe("window starts are inclusive of both ends", () => {
  // The convention every chart query shares: an N-day window covers N
  // calendar dates ending at the end date, so the offset back is N-1. Getting
  // this wrong shifts every chart by a day.
  it("counts days inclusively", () => {
    expect(windowStartDate("2026-09-30", 30)).toBe("2026-09-01");
    expect(windowStartDate("2026-09-01", 1)).toBe("2026-09-01");
  });

  it("counts months inclusively", () => {
    expect(windowStartMonth("2026-09", 12)).toBe("2025-10");
    expect(windowStartMonth("2026-09", 1)).toBe("2026-09");
  });

  it("crosses month and year boundaries", () => {
    expect(windowStartDate("2027-01-02", 5)).toBe("2026-12-29");
    expect(windowStartMonth("2027-01", 3)).toBe("2026-11");
  });

  it("counts through a leap day", () => {
    expect(windowStartDate("2028-03-01", 3)).toBe("2028-02-28");
  });

  it("gives 'all' a start that sorts before any real month", () => {
    // Lets callers keep one `>=` comparison instead of branching.
    const start = windowStartMonth("2026-09", "all");
    expect(start < "0001-01").toBe(true);
  });

  it("expresses the same offset in SQL as in JS", () => {
    expect(windowStartSql("2026-09-30", 30)).toBe("date('2026-09-30', '-29 days')");
  });
});

describe("daysBetweenInclusive", () => {
  // The start-date field on the daily/hourly pages is not state of its own —
  // it displays windowStartDate(end, days) and commits the day count a picked
  // date implies. That only holds while the two are exact inverses, which is
  // what these cases pin.
  it("round-trips windowStartDate", () => {
    for (const days of [1, 2, 7, 30, 60, 180, 365]) {
      const start = windowStartDate("2026-09-17", days);
      expect(daysBetweenInclusive(start, "2026-09-17"), `for ${days}d`).toBe(days);
    }
  });

  it("counts both ends, so one day is 1", () => {
    expect(daysBetweenInclusive("2026-09-17", "2026-09-17")).toBe(1);
    expect(daysBetweenInclusive("2026-09-01", "2026-09-17")).toBe(17);
  });

  it("spans a calendar month exactly", () => {
    // The case the field exists for: type the 1st, get the month.
    expect(daysBetweenInclusive("2026-03-01", "2026-03-31")).toBe(31);
    expect(daysBetweenInclusive("2026-02-01", "2026-02-28")).toBe(28);
    expect(daysBetweenInclusive("2028-02-01", "2028-02-29")).toBe(29);
  });

  it("is unmoved by a DST transition", () => {
    // EU clocks go forward 2026-03-29 and back 2026-10-25. Both helpers anchor
    // at noon precisely so those days are still one day wide.
    expect(daysBetweenInclusive("2026-03-28", "2026-03-30")).toBe(3);
    expect(daysBetweenInclusive("2026-10-24", "2026-10-26")).toBe(3);
  });

  it("crosses a year boundary", () => {
    expect(daysBetweenInclusive("2026-12-29", "2027-01-02")).toBe(5);
  });

  it("rejects a start after the end, rather than clamping", () => {
    // Reachable by typing past the field's own max; the caller ignores null and
    // the control snaps back to the real window.
    expect(daysBetweenInclusive("2026-09-18", "2026-09-17")).toBeNull();
  });

  it("rejects anything that isn't a date", () => {
    for (const raw of ["", "2026-09", "17/09/2026", "abc", "2026-13-01"]) {
      expect(daysBetweenInclusive(raw, "2026-09-17"), `for ${JSON.stringify(raw)}`).toBeNull();
      expect(daysBetweenInclusive("2026-09-01", raw), `for ${JSON.stringify(raw)}`).toBeNull();
    }
  });
});

describe("the window floor", () => {
  // Nothing here predates the full-scale invasion, and every chart materialises
  // one point per day of its window, so an unbounded `days` is a page that
  // stops responding rather than a chart that says nothing.
  it("is the day the full-scale invasion began", () => {
    expect(WINDOW_FLOOR).toBe("2022-02-24");
  });

  it("measures the widest window back to it, inclusively", () => {
    expect(maxDaysFor("2022-02-24")).toBe(1);
    expect(maxDaysFor("2022-03-01")).toBe(6);
    expect(windowStartDate("2022-03-01", maxDaysFor("2022-03-01"))).toBe(WINDOW_FLOOR);
  });

  it("gives an end date before the floor the one day it is", () => {
    // Nothing to show, but a window still has to be at least a day wide, and
    // the start can't be asked to sit after the end it is measured from.
    expect(maxDaysFor("2020-01-01")).toBe(1);
    expect(windowStartDate("2020-01-01", maxDaysFor("2020-01-01"))).toBe("2020-01-01");
  });

  it("caps a window, and leaves a shorter one alone", () => {
    expect(clampDays(99_999, "2022-03-01")).toBe(6);
    expect(clampDays(3, "2022-03-01")).toBe(3);
    expect(clampDays(0, "2022-03-01")).toBe(1);
  });

  it("caps what the URL asks for, when the caller knows the end", () => {
    expect(parseDaysParam("99999", "2022-03-01")).toBe(6);
    expect(parseDaysParam("3", "2022-03-01")).toBe(3);
    // The default is a real value too, and gets capped like any other.
    expect(parseDaysParam(null, "2022-02-26")).toBe(3);
    // Without an end date there is no floor to measure against.
    expect(parseDaysParam("99999")).toBe(99_999);
  });
});
