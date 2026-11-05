import { describe, expect, it } from "vitest";
import { formatPeriodChange, partialMonth, periodChange, previousOf } from "@/utils/periodChange";

describe("periodChange", () => {
  it("is the percentage change on the previous period", () => {
    expect(periodChange({ value: 120 }, { value: 100 })).toEqual({ pct: 20, projected: false });
    expect(periodChange({ value: 75 }, { value: 100 })).toEqual({ pct: -25, projected: false });
  });

  it("compares the month in progress by its projection", () => {
    expect(periodChange({ value: 40, projected: 110, partial: true }, { value: 100 }))
      .toEqual({ pct: 10, projected: true });
  });

  it("has nothing for a partial period without a projection", () => {
    expect(periodChange({ value: 40, partial: true }, { value: 100 })).toBeNull();
  });

  it("has nothing against a partial, missing, empty or zero previous period", () => {
    expect(periodChange({ value: 100 }, { value: 3, partial: true })).toBeNull();
    expect(periodChange({ value: 100 }, undefined)).toBeNull();
    expect(periodChange({ value: 100 }, { value: null })).toBeNull();
    expect(periodChange({ value: 100 }, { value: 0 })).toBeNull();
  });

  it("has nothing for a gap", () => {
    expect(periodChange({ value: null }, { value: 100 })).toBeNull();
  });
});

describe("partialMonth", () => {
  it("is the month in progress", () => {
    expect(partialMonth("2026-11", "2026-11-05")).toBe(true);
  });
  it("is a past month short of days, when the count is known", () => {
    expect(partialMonth("2026-09", "2026-11-05", 12)).toBe(true);
    expect(partialMonth("2026-09", "2026-11-05", 30)).toBe(false);
    expect(partialMonth("2026-09", "2026-11-05")).toBe(false);
  });
  it("never is a weekly key", () => {
    expect(partialMonth("2026-11-02", "2026-11-05")).toBe(false);
  });
});

describe("previousOf", () => {
  it("is the entry before", () => {
    const xs = [{ a: 1 }, { a: 2 }];
    expect(previousOf(xs, xs[1])).toBe(xs[0]);
    expect(previousOf(xs, xs[0])).toBeUndefined();
  });
});

describe("formatPeriodChange", () => {
  it("signs the change with a real minus and marks a projection", () => {
    expect(formatPeriodChange({ pct: 12.34, projected: false })).toBe("+12.3%");
    expect(formatPeriodChange({ pct: -4, projected: false })).toBe("−4.0%");
    expect(formatPeriodChange({ pct: 0.01, projected: false })).toBe("0.0%");
    expect(formatPeriodChange({ pct: 5.06, projected: true })).toBe("≈+5.1%");
  });
});
