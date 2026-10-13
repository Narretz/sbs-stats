import { describe, expect, it } from "vitest";
import { entryOfDay, formatEntry } from "@/components/spanBarShape";

describe("a weekend report's days are one entry", () => {
  const sat = { date: "2026-01-10", report_date: "2026-01-11", window_days: 2 };
  const sun = { date: "2026-01-11", report_date: "2026-01-11", window_days: 2 };
  const gap = { date: "2026-01-07", report_date: null, window_days: 1 };

  it("shares one entry key and one header", () => {
    expect(entryOfDay(sat)).toBe(entryOfDay(sun));
    expect(formatEntry(sat)).toBe("2026-01-10/11");
    expect(formatEntry(sun)).toBe(formatEntry(sat));
  });
  it("leaves a day no report covers as its own entry", () => {
    expect(entryOfDay(gap)).toBe("2026-01-07");
    expect(formatEntry(gap)).toBe("2026-01-07");
  });
});
