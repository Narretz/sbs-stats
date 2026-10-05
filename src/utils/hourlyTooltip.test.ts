import { describe, expect, it } from "vitest";
import { eodAtHour, hourBaseline } from "@/utils/hourlyTooltip";
import type { DailyDaySeries, EodEstimate } from "@/types";

describe("hourBaseline", () => {
  const entries = [
    { date: "2026-09-01", value: 10 },
    { date: "2026-09-02", value: 40 },
    { date: "2026-09-03", value: 20 },
    { date: "2026-09-04", value: 40 },
    { date: "2026-09-05", value: 100 }, // the highlighted day
  ];

  it("leaves the highlighted day out of its own median and max", () => {
    const b = hourBaseline(entries, "2026-09-05");
    expect(b.days).toBe(4);
    // Upper-middle of 10, 20, 40, 40 — the site's median convention.
    expect(b.median).toBe(40);
    expect(b.max).toBe(40);
    expect(b.deltaPct).toBeCloseTo(150);
  });

  it("names the most recent day that reached the max", () => {
    expect(hourBaseline(entries, "2026-09-05").maxDate).toBe("2026-09-04");
  });

  it("uses every day when no day is highlighted, with nothing to compare", () => {
    const b = hourBaseline(entries, undefined);
    expect(b.days).toBe(5);
    expect(b.max).toBe(100);
    expect(b.deltaPct).toBeNull();
  });

  it("has no baseline when the highlighted day is the only one", () => {
    const b = hourBaseline([{ date: "2026-09-05", value: 3 }], "2026-09-05");
    expect(b).toMatchObject({ days: 0, median: null, max: null, deltaPct: null });
  });

  it("does not divide by a zero median", () => {
    const b = hourBaseline([{ date: "2026-09-01", value: 0 }, { date: "2026-09-05", value: 3 }], "2026-09-05");
    expect(b.median).toBe(0);
    expect(b.deltaPct).toBeNull();
  });
});

describe("eodAtHour", () => {
  const step = (bucket: string, projected: number): EodEstimate =>
    ({ bucket, projected, fraction: 0.5, asOf: `${bucket.padStart(2, "0")}:00` });
  const steps = [step("9", 900), step("11", 1100), step("12", 1200)];
  // Readings at 9, 10, 11, 12; 10 had no usable profile.
  const today: DailyDaySeries = {
    date: "2026-09-01", is_today: true,
    points: [9, 10, 11, 12].map((hour) => ({ hour, value: hour })),
  };

  it("shows the estimate made at a passed hour", () => {
    expect(eodAtHour(steps, today, 9)?.projected).toBe(900);
    expect(eodAtHour(steps, today, 11)?.projected).toBe(1100);
  });

  it("shows nothing at a passed hour that had no usable profile", () => {
    expect(eodAtHour(steps, today, 10)).toBeNull();
  });

  it("shows the current estimate past the latest reading", () => {
    expect(eodAtHour(steps, today, 18)?.projected).toBe(1200);
  });

  it("shows nothing past the latest reading when it has no estimate of its own", () => {
    // A day settled at 12:00 must not keep showing 11:00's guess as current.
    expect(eodAtHour(steps.slice(0, 2), today, 18)).toBeNull();
  });

  it("does not fill an hour before the latest reading that today missed", () => {
    const gappy: DailyDaySeries = { ...today, points: [9, 12].map((hour) => ({ hour, value: hour })) };
    expect(eodAtHour(steps, gappy, 11)).toBeNull();
  });

  it("needs today's series", () => {
    expect(eodAtHour(steps, undefined, 9)).toBeNull();
  });
});
