import { describe, expect, it } from "vitest";
import { computeEodProjection, computeEodSteps, type EodReading } from "@/utils/eodProjection";

type K = "hits";

// A complete past day: readings at 14:00 and 22:00, the last one being that
// day's settled total.
function settled(final: number, atFourteen: number): EodReading<K>[] {
  return [
    { bucket: "14", asOf: "14:00", values: { hits: atFourteen } },
    { bucket: "22", asOf: "22:00", values: { hits: final } },
  ];
}

// N complete days where 14:00 holds `share` of the day's total, plus a
// still-open today stopped at 14:00.
function history(days: number, share: number, todayPartial: number | null) {
  const byDate = new Map<string, EodReading<K>[]>();
  // A flat 100 per day so `share` survives the division exactly — the point
  // under test is the arithmetic, not rounding.
  for (let d = 1; d <= days; d++) {
    byDate.set(`2026-08-${String(d).padStart(2, "0")}`, settled(100, 100 * share));
  }
  byDate.set("2026-09-01", [{ bucket: "14", asOf: "14:00", values: { hits: todayPartial } }]);
  return byDate;
}

const project = (byDate: Map<string, EodReading<K>[]>) =>
  computeEodProjection(byDate, "2026-09-01", ["hits"]).hits;

describe("computeEodProjection", () => {
  it("divides today's partial by the median share in by the same checkpoint", () => {
    const est = project(history(6, 0.5, 50))!;
    expect(est.fraction).toBeCloseTo(0.5, 2);
    expect(est.projected).toBe(100);
    // The label is today's own checkpoint, not the profile's.
    expect(est.asOf).toBe("14:00");
  });

  it("needs five complete days at that checkpoint before it will guess", () => {
    // Below the floor an outlier day IS the median.
    expect(project(history(4, 0.5, 50))).toBeUndefined();
    expect(project(history(5, 0.5, 50))).toBeDefined();
  });

  it("matches the checkpoint, so a different one has no profile of its own", () => {
    const byDate = history(6, 0.5, 50);
    // Today is at 16:00; every complete day only ever reported 14:00 and 22:00.
    byDate.set("2026-09-01", [{ bucket: "16", asOf: "16:00", values: { hits: 50 } }]);
    expect(project(byDate)).toBeUndefined();
  });

  it("says nothing once the day is essentially settled", () => {
    // 98% in by the checkpoint: the remaining tail is noise, and dividing by it
    // would dress up the actual figure as an estimate.
    expect(project(history(6, 0.99, 99))).toBeUndefined();
  });

  it("ignores days that ended at zero", () => {
    // Their ratio is undefined, not 0 — a channel outage must not drag the
    // median down and inflate every projection after it.
    const byDate = history(6, 0.5, 50);
    byDate.set("2026-08-20", settled(0, 0));
    expect(project(byDate)!.fraction).toBeCloseTo(0.5, 2);
  });

  it("is empty when today has no reading at all", () => {
    const byDate = history(6, 0.5, 50);
    byDate.delete("2026-09-01");
    expect(computeEodProjection(byDate, "2026-09-01", ["hits"])).toEqual({});
  });

  it("skips a key today has not reported", () => {
    expect(project(history(6, 0.5, null))).toBeUndefined();
  });

  it("takes the median, not the mean, of the daily shares", () => {
    // One freak day where everything landed before the checkpoint must not
    // move the estimate.
    const byDate = history(6, 0.5, 50);
    byDate.set("2026-08-03", settled(100, 100));
    expect(project(byDate)!.fraction).toBeCloseTo(0.5, 2);
  });
});

describe("computeEodSteps", () => {
  // Complete days reading 25% by 10:00, 50% by 14:00, 99% by 20:00, 100 at 22:00.
  function day(): EodReading<K>[] {
    return [
      { bucket: "10", asOf: "10:00", values: { hits: 25 } },
      { bucket: "14", asOf: "14:00", values: { hits: 50 } },
      { bucket: "20", asOf: "20:00", values: { hits: 99 } },
      { bucket: "22", asOf: "22:00", values: { hits: 100 } },
    ];
  }
  function withToday(today: EodReading<K>[]) {
    const byDate = new Map<string, EodReading<K>[]>();
    for (let d = 1; d <= 6; d++) byDate.set(`2026-08-0${d}`, day());
    byDate.set("2026-09-01", today);
    return byDate;
  }

  it("re-runs the estimate at each of today's readings, each against its own checkpoint", () => {
    const steps = computeEodSteps(withToday([
      { bucket: "10", asOf: "10:00", values: { hits: 30 } },
      { bucket: "14", asOf: "14:00", values: { hits: 70 } },
    ]), "2026-09-01", ["hits"]).hits!;
    expect(steps.map((s) => [s.bucket, s.projected])).toEqual([["10", 120], ["14", 140]]);
    // The latest step is exactly what the single estimate reports.
    expect(computeEodProjection(withToday([
      { bucket: "10", asOf: "10:00", values: { hits: 30 } },
      { bucket: "14", asOf: "14:00", values: { hits: 70 } },
    ]), "2026-09-01", ["hits"]).hits).toEqual(steps[1]);
  });

  it("keeps the earlier hours once the day has settled at the latest one", () => {
    const byDate = withToday([
      { bucket: "10", asOf: "10:00", values: { hits: 30 } },
      { bucket: "20", asOf: "20:00", values: { hits: 110 } },
    ]);
    // 99% in by 20:00: no current estimate, but 10:00's is still history.
    expect(computeEodSteps(byDate, "2026-09-01", ["hits"]).hits!.map((s) => s.bucket)).toEqual(["10"]);
    expect(computeEodProjection(byDate, "2026-09-01", ["hits"]).hits).toBeUndefined();
  });

  it("skips a checkpoint without a profile instead of borrowing a neighbour's", () => {
    const steps = computeEodSteps(withToday([
      { bucket: "12", asOf: "12:00", values: { hits: 40 } },
      { bucket: "14", asOf: "14:00", values: { hits: 50 } },
    ]), "2026-09-01", ["hits"]).hits!;
    expect(steps.map((s) => s.bucket)).toEqual(["14"]);
  });
});
