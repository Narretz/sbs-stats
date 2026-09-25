import { describe, expect, it } from "vitest";
import { projectMonthEnd, type IntradayReading } from "@/utils/monthProjection";

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
    // The 16:51 reading postdates the snapshot, so it isn't what was subtracted.
    expect(p.projected.hits).toBe(3000);
  });

  it("counts the snapshot's day, not today's, as the incomplete one", () => {
    // Taken 23:31 Kyiv on the 23rd and still the latest after midnight: the
    // 23rd is the partial day, so there are 22 complete days, not 23.
    const p = project("2026-09-23T20:31:00Z", 2200 + 900, {
      "2026-09-23": [["2026-09-23T19:51:00Z", 900]],
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
