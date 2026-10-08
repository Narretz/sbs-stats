import { describe, expect, it } from "vitest";
import { linearTrend } from "@/utils/trend";
import type { DailyDataPoint, EodEstimate } from "@/types";

// Ten days climbing by 10 a day, the last one today.
const rising = (todayValue: number): DailyDataPoint[] =>
  Array.from({ length: 10 }, (_, i) => ({
    date: `2026-09-${String(i + 1).padStart(2, "0")}`,
    value: i === 9 ? todayValue : 100 + i * 10,
    is_today: i === 9,
  }));
const est = (projected: number): EodEstimate => ({ projected, fraction: 0.3, asOf: "09:00", bucket: "9" });

describe("linearTrend", () => {
  it("fits a clean series exactly", () => {
    expect(linearTrend(rising(190))).toEqual(rising(190).map((d) => d.value));
  });

  it("a partial today bends the line down — the problem", () => {
    const t = linearTrend(rising(60));
    expect(t[9]!).toBeLessThan(t[0]! + 50);
  });

  it("fits through today's end-of-day estimate instead of its partial", () => {
    expect(linearTrend(rising(60), est(190))).toEqual(rising(190).map((d) => d.value));
  });

  it("leaves a partial today out of the fit when there is no estimate", () => {
    // 01:00: nothing in yet, and no estimate (the typical share by now is 0).
    expect(linearTrend(rising(0), null, true)).toEqual(rising(190).map((d) => d.value));
  });

  it("still prefers the estimate over leaving today out", () => {
    expect(linearTrend(rising(0), est(250), true)[9]).toBeGreaterThan(190);
  });

  it("fits today as it stands on a source whose today is a whole report", () => {
    const t = linearTrend(rising(0));
    expect(t[9]!).toBeLessThan(190);
  });

  it("uses the estimate for today only", () => {
    // An estimate handed to a series with no today has nothing to replace.
    const past = rising(190).map((d) => ({ ...d, is_today: false }));
    expect(linearTrend(past, est(9999))).toEqual(linearTrend(past));
  });

  it("breaks where the series does", () => {
    const gappy = rising(190);
    gappy[4] = { ...gappy[4], value: null };
    expect(linearTrend(gappy)[4]).toBeNull();
    expect(linearTrend(gappy)[5]).toBe(150);
  });
});
