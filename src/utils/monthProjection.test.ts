import { describe, expect, it } from "vitest";
import { projectFromDays, projectionBasis, projectMonthEnd, projectNightDay, type IntradayReading } from "@/utils/monthProjection";

type K = "hits";

// Kyiv is UTC+3 in September: 2026-09-23T21:31Z is 00:31 on the 24th.
const readings = (byDate: Record<string, [string, number][]>) =>
  (date: string): IntradayReading<K>[] =>
    (byDate[date] ?? []).map(([collectedAt, hits]) => ({ collectedAt, values: { hits } }));

const project = (snapshotAt: string, total: number, byDate: Record<string, [string, number][]> = {}) =>
  projectMonthEnd<K>("2026-09", snapshotAt, { hits: total }, readings(byDate), ["hits"]);

describe("projectMonthEnd", () => {
  it("extrapolates the completed days, minus the snapshot day's partial", () => {
    // Snapshot 19:31 Kyiv on the 23rd: 22 complete days + 600 so far today.
    const p = project("2026-09-23T16:31:00Z", 22 * 100 + 600, {
      "2026-09-23": [["2026-09-23T15:51:00Z", 600], ["2026-09-23T16:51:00Z", 650]],
    })!;
    expect(p.completedDays).toBe(22);
    expect(p.daysInMonth).toBe(30);
    expect(p.partialDay).toBe(true);
    // The 16:51 reading postdates the snapshot, so it isn't what was subtracted.
    expect(p.projected.hits).toBe(3000);
  });

  it("counts the snapshot's day, not today's, as the incomplete one", () => {
    // Taken 23:31 Kyiv on the 23rd and still the latest after midnight: the
    // 23rd is the partial day, so there are 22 complete days, not 23.
    const p = project("2026-09-23T20:31:00Z", 2200 + 90, {
      "2026-09-23": [["2026-09-23T19:51:00Z", 90]],
      "2026-09-24": [["2026-09-23T21:51:00Z", 20]],
    })!;
    expect(p.completedDays).toBe(22);
    expect(p.projected.hits).toBe(3000);
  });

  it("treats a snapshot from before the day's first reading as a zero partial", () => {
    const p = project("2026-09-23T21:31:00Z", 2300, {
      "2026-09-24": [["2026-09-23T21:51:00Z", 20]],
    })!;
    expect(p.completedDays).toBe(23);
    expect(p.partialDay).toBe(false);
    expect(p.projected.hits).toBe(3000);
  });

  it("gives no estimate on day 1", () => {
    expect(project("2026-09-01T09:31:00Z", 500)).toBeNull();
  });

  it("gives no estimate from a snapshot taken in the previous month", () => {
    // 23:31 Kyiv on 31 August.
    expect(project("2026-08-31T20:31:00Z", 0)).toBeNull();
  });

  it("skips keys the snapshot doesn't carry", () => {
    const p = projectMonthEnd<K>("2026-09", "2026-09-11T09:31:00Z", { hits: null }, () => [], ["hits"])!;
    expect(p.projected).toEqual({});
  });
});

describe("projectFromDays", () => {
  const day = (date: string, hits: number | null) => ({ date, values: { hits } });

  it("extrapolates the days before today and leaves today's partial out", () => {
    const days = [day("2026-09-01", 100), day("2026-09-02", 100), day("2026-09-03", 40)];
    const p = projectFromDays<K>("2026-09", "2026-09-03", days, ["hits"])!;
    expect(p.completedDays).toBe(2);
    expect(p.daysInMonth).toBe(30);
    expect(p.partialDay).toBe(true);
    expect(p.projected.hits).toBe(3000);
  });

  it("counts up to the latest day with data when the source lags", () => {
    // Data runs to the 25th; it's the 30th. 25 days complete, not 30 or 29.
    const days = Array.from({ length: 25 }, (_, i) => day(`2026-09-${String(i + 1).padStart(2, "0")}`, 10));
    const p = projectFromDays<K>("2026-09", "2026-09-30", days, ["hits"])!;
    expect(p.completedDays).toBe(25);
    // The days after the 25th are missing, not filling in.
    expect(p.partialDay).toBe(false);
    expect(p.projected.hits).toBe(300);
  });

  it("reads a missing day inside the span as zero, as the month total does", () => {
    const days = [day("2026-09-01", 30), day("2026-09-03", 30)];
    const p = projectFromDays<K>("2026-09", "2026-09-10", days, ["hits"])!;
    expect(p.completedDays).toBe(3);
    expect(p.projected.hits).toBe(600);
  });

  it("never projects below what the month already holds", () => {
    // Last day, and today's partial is already far above the average.
    const days = [day("2026-09-01", 10), day("2026-09-02", 500)];
    const p = projectFromDays<K>("2026-09", "2026-09-02", days, ["hits"])!;
    expect(p.projected.hits).toBe(510);
  });

  it("gives no estimate before any day of the month is complete", () => {
    expect(projectFromDays<K>("2026-09", "2026-09-01", [day("2026-09-01", 50)], ["hits"])).toBeNull();
    expect(projectFromDays<K>("2026-09", "2026-09-05", [day("2026-08-31", 50)], ["hits"])).toBeNull();
  });

  it("skips keys no day carries", () => {
    const p = projectFromDays<K>("2026-09", "2026-09-05", [day("2026-09-01", null)], ["hits"])!;
    expect(p.projected).toEqual({});
  });
});

describe("projectionBasis", () => {
  it("says how many days the projection rests on", () => {
    expect(projectionBasis(25, 30)).toBe("25 of 30 days complete");
    expect(projectionBasis(25, 30, false)).toBe("25 of 30 days complete");
  });

  it("owns up to the day still filling in", () => {
    expect(projectionBasis(29, 30, true)).toBe("29 of 30 days complete, one day partial");
  });
});

describe("projectNightDay", () => {
  const d = (date: string, night: number, day: number, nightDone = true) => ({ date, night, day, nightDone });
  const month = [d("2026-09-01", 100, 10), d("2026-09-02", 100, 10)];

  it("counts tonight's finished night in full and sets aside only the daytime", () => {
    const p = projectNightDay("2026-09", "2026-09-03", [...month, d("2026-09-03", 400, 0)])!;
    expect(p.completedDays).toBe(2);
    expect(p.partialDay).toBe(true);
    // Nights: 600 over 3 complete → 6,000. Days: 20 over 2 → 300.
    expect(p.night).toBe(6000);
    expect(p.day).toBe(300);
  });

  it("holds a night back while only its 20–23 part is in", () => {
    const p = projectNightDay("2026-09", "2026-09-03", [...month, d("2026-09-03", 40, 0, false)])!;
    // 200 over 2 complete nights → 3,000; the 40 is kept, not averaged.
    expect(p.night).toBe(3000);
  });

  it("on the last day, a finished night leaves only the daytime to project", () => {
    const p = projectNightDay("2026-09", "2026-09-30", [d("2026-09-29", 30, 3), d("2026-09-30", 30, 0)])!;
    expect(p.completedDays).toBe(29);
    expect(p.night).toBe(60);
    expect(p.day).toBe(3);
  });

  it("gives no estimate before a daytime is complete", () => {
    expect(projectNightDay("2026-09", "2026-09-01", [d("2026-09-01", 100, 0)])).toBeNull();
  });
});
