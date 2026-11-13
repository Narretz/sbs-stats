import { describe, expect, it } from "vitest";
import cases from "@/data/weatherRatingCases.json";
import {
  coverWindows, DEGRADED, droneDay, droneHour, OK, SEVERE, type HourRating, type Level, type WeatherHour,
} from "@/utils/weatherRating";

// The same file scripts/weather/test_report.py runs against assess.py: the
// app and the CLI must rate every one of these hours identically.
describe("droneHour — shared cases", () => {
  for (const c of cases.cases) {
    it(c.name, () => {
      const hour = { ...cases.base, ...c.hour } as WeatherHour;
      expect(droneHour(hour)).toEqual({ level: c.level, reasons: c.reasons });
    });
  }
});

describe("droneDay", () => {
  const day = (severe: number, degraded: number): Level[] =>
    [...Array(severe).fill(SEVERE), ...Array(degraded).fill(DEGRADED), ...Array(24 - severe - degraded).fill(OK)];

  it("is severe from six severe hours", () => {
    expect(droneDay(day(6, 0))).toBe("severe");
    expect(droneDay(day(5, 0))).toBe("ok");
  });
  it("is limited from six limited hours, severe counting too", () => {
    expect(droneDay(day(5, 1))).toBe("limited");
    expect(droneDay(day(0, 6))).toBe("limited");
    expect(droneDay(day(0, 5))).toBe("ok");
  });
});

describe("coverWindows", () => {
  const severe = (reason: "fog" | "wind"): HourRating => ({ level: SEVERE, reasons: [[SEVERE, reason]] });
  const ok: HourRating = { level: OK, reasons: [] };
  const hours = (spec: Record<number, HourRating>) =>
    Array.from({ length: 24 }, (_, hour) => ({ hour, rating: spec[hour] ?? ok }));

  it("needs two hours; a single severe hour is not a window", () => {
    expect(coverWindows(hours({ 3: severe("wind"), 9: severe("wind"), 10: severe("wind") })))
      .toEqual([{ start: 9, end: 11, reasons: ["wind"] }]);
  });
  it("bridges a one-hour lull", () => {
    expect(coverWindows(hours({ 2: severe("fog"), 3: severe("fog"), 5: severe("wind"), 6: severe("fog") })))
      .toEqual([{ start: 2, end: 7, reasons: ["fog", "wind"] }]);
  });
  it("splits on a two-hour lull", () => {
    expect(coverWindows(hours({ 2: severe("fog"), 3: severe("fog"), 6: severe("fog"), 7: severe("fog") })))
      .toEqual([{ start: 2, end: 4, reasons: ["fog"] }, { start: 6, end: 8, reasons: ["fog"] }]);
  });
});
