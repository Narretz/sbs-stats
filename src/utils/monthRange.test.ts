import { describe, expect, it } from "vitest";
import { parseMonthsParam, windowStartMonth } from "@/utils/monthRange";
import { parseDaysParam, windowStartDate, windowStartSql } from "@/utils/dayRange";

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
