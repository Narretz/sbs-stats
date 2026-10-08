import { describe, expect, it } from "vitest";
import { entryOfDay, formatEntry, formatSpan } from "@/components/spanBarShape";

describe("formatSpan", () => {
  it("names a span inside one month once", () => {
    expect(formatSpan("2026-01-10", "2026-01-11")).toBe("10–11 Jan 2026");
  });
  it("names both months across a month boundary", () => {
    expect(formatSpan("2026-01-31", "2026-02-01")).toBe("31 Jan – 1 Feb 2026");
  });
  it("names both years across a year boundary", () => {
    expect(formatSpan("2025-12-31", "2026-01-01")).toBe("31 Dec 2025 – 1 Jan 2026");
  });
  it("is a plain day for a one-day span", () => {
    expect(formatSpan("2026-01-09", "2026-01-09")).toBe("9 Jan 2026");
  });
});

describe("a weekend report's days are one entry", () => {
  const sat = { date: "2026-01-10", report_date: "2026-01-11", window_days: 2 };
  const sun = { date: "2026-01-11", report_date: "2026-01-11", window_days: 2 };
  const gap = { date: "2026-01-07", report_date: null, window_days: 1 };

  it("shares one entry key and one header", () => {
    expect(entryOfDay(sat)).toBe(entryOfDay(sun));
    expect(formatEntry(sat)).toBe("10–11 Jan 2026");
    expect(formatEntry(sun)).toBe(formatEntry(sat));
  });
  it("leaves a day no report covers as its own entry", () => {
    expect(entryOfDay(gap)).toBe("2026-01-07");
    expect(formatEntry(gap)).toBe("7 Jan 2026");
  });
});
