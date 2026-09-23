import { describe, expect, it } from "vitest";
import { extendMonthsTo, fillDailyRange, padTrailingMonthly, resolvedEndDate } from "@/utils/padTrailing";
import type { DailyDataPoint } from "@/types";

const day = (date: string, value: number): DailyDataPoint => ({ date, value, is_today: false });
const dates = (points: { date: string }[]) => points.map((p) => p.date);

describe("fillDailyRange", () => {
  it("covers the leading edge, internal gaps and the trailing tail in one pass", () => {
    // The padding exists so recharts draws a break instead of bridging a gap
    // with its category spacing — the axis must span the whole window.
    const out = fillDailyRange([day("2026-09-03", 5)], "2026-09-01", "2026-09-05");
    expect(dates(out)).toEqual([
      "2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05",
    ]);
    expect(out.map((p) => p.value)).toEqual([null, null, 5, null, null]);
  });

  it("marks padded days as not-today", () => {
    // `is_today` drives the chart's highlight; a padded placeholder must never
    // claim it.
    const out = fillDailyRange([], "2026-09-01", "2026-09-02");
    expect(out.every((p) => p.is_today === false)).toBe(true);
  });

  it("keeps real rows a weekday filter would exclude", () => {
    // The filter is the user's choice about which days to PAD, not a licence
    // to drop data they are looking at.
    const keepDate = (d: string) => d === "2026-09-04";
    const out = fillDailyRange([day("2026-09-01", 5)], "2026-09-01", "2026-09-05", { keepDate });
    expect(dates(out)).toEqual(["2026-09-01", "2026-09-04"]);
  });

  it("crosses a month and a year boundary", () => {
    expect(dates(fillDailyRange([], "2026-12-30", "2027-01-02")))
      .toEqual(["2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02"]);
  });

  it("handles a leap day", () => {
    expect(dates(fillDailyRange([], "2028-02-28", "2028-03-01")))
      .toEqual(["2028-02-28", "2028-02-29", "2028-03-01"]);
  });

  it("emits a single day when the range is one day", () => {
    expect(dates(fillDailyRange([], "2026-09-01", "2026-09-01"))).toEqual(["2026-09-01"]);
  });

  it("emits nothing when the range runs backwards", () => {
    expect(fillDailyRange([], "2026-09-05", "2026-09-01")).toEqual([]);
  });
});

describe("padTrailingMonthly", () => {
  const month = (date: string) => ({ date, value: 1 });

  it("extends to the end month", () => {
    expect(dates(padTrailingMonthly([month("2026-07")], "2026-10")))
      .toEqual(["2026-07", "2026-08", "2026-09", "2026-10"]);
  });

  it("leaves data that already reaches the end alone", () => {
    const data = [month("2026-10")];
    expect(padTrailingMonthly(data, "2026-10")).toBe(data);
    // Past the end too: a source ahead of the window is not padded backwards.
    expect(padTrailingMonthly(data, "2026-09")).toBe(data);
  });

  it("does not invent a series out of nothing", () => {
    // With no rows there is no start, so padding would fabricate the axis.
    expect(padTrailingMonthly([], "2026-10")).toEqual([]);
  });

  it("uses the caller's blank row shape", () => {
    const out = padTrailingMonthly([month("2026-11")], "2026-12", (date) => ({ date, value: 0 }));
    expect(out[1]).toEqual({ date: "2026-12", value: 0 });
  });

  it("crosses the year", () => {
    expect(dates(padTrailingMonthly([month("2026-11")], "2027-01")))
      .toEqual(["2026-11", "2026-12", "2027-01"]);
  });
});

describe("extendMonthsTo", () => {
  it("fills the months a period-driven axis is missing", () => {
    expect(extendMonthsTo(["2026-08"], "2026-11"))
      .toEqual(["2026-08", "2026-09", "2026-10", "2026-11"]);
  });

  it("leaves a list that already reaches the end alone", () => {
    expect(extendMonthsTo(["2026-11"], "2026-11")).toEqual(["2026-11"]);
    expect(extendMonthsTo([], "2026-11")).toEqual([]);
  });
});

describe("resolvedEndDate", () => {
  it("prefers an explicitly selected date", () => {
    expect(resolvedEndDate("2026-09-01")).toBe("2026-09-01");
  });

  it("falls back to today in the dashboard's timezone", () => {
    // Every view reconciles to Kyiv, so "today" must not come from the
    // viewer's clock.
    const kyiv = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });
    expect(resolvedEndDate("")).toBe(kyiv);
    expect(resolvedEndDate(undefined)).toBe(kyiv);
    // A malformed date is a fallback case, not something to pass through.
    expect(resolvedEndDate("01/09/2026")).toBe(kyiv);
  });
});
