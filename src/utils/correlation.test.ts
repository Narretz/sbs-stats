import { describe, expect, it } from "vitest";
import type { DailyDataPoint } from "@/types";
import { CORRELATION_PAIRS, MIN_CHANGES, correlationText, pairCorrelation, pairsOnChart, pearson } from "@/utils/correlation";

const PAIR = CORRELATION_PAIRS[0];

// `n` consecutive days from a Monday, valued by f(i).
const MONDAY = "2026-01-05";
function series(n: number, f: (i: number) => number | null, start = MONDAY): DailyDataPoint[] {
  const t0 = Date.parse(`${start}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) => ({
    date: new Date(t0 + i * 86_400_000).toISOString().slice(0, 10),
    value: f(i),
    is_today: false,
  }));
}
// A deterministic wobble with no trend of its own, so tests don't hang on Math.random.
const wobble = (i: number) => Math.sin(i * 1.7) * 10 + Math.cos(i * 0.9) * 6;

describe("pairsOnChart", () => {
  it("finds a listed pair only when both of its metrics are on the chart", () => {
    expect(pairsOnChart(["sbs.total_personnel_casualties", "ru-losses.personnel"])).toEqual([PAIR]);
    expect(pairsOnChart(["sbs.total_personnel_casualties", "gsua.attacks"])).toEqual([]);
    // Not a listed pair: SBS killed isn't GSUA's killed + wounded.
    expect(pairsOnChart(["sbs.personnel_killed", "ru-losses.personnel"])).toEqual([]);
    expect(pairsOnChart(["ru-losses.vehicles", "x", "sbs.hit_7", "ru-losses.personnel", "sbs.total_personnel_casualties"]))
      .toEqual(CORRELATION_PAIRS);
  });
});

describe("pearson", () => {
  it("is ±1 on a line, and has no value without variance", () => {
    expect(pearson([1, 2, 3], [2, 4, 6])).toBeCloseTo(1);
    expect(pearson([1, 2, 3], [3, 2, 1])).toBeCloseTo(-1);
    expect(pearson([1, 2, 3], [5, 5, 5])).toBeNull();
  });
});

describe("pairCorrelation", () => {
  const weeks = 14;
  const sbs = series(weeks * 7, (i) => 100 + wobble(i));

  it("correlates SBS with the REST of GSUA, not with the whole", () => {
    // GSUA = SBS + a flat rest: against the whole that is r = 1, against the
    // rest there is nothing to correlate.
    const flatRest = series(weeks * 7, (i) => 100 + wobble(i) + 500);
    expect(pairCorrelation(PAIR, sbs, flatRest).r).toBeNull();
    // GSUA = 3 × SBS: the rest is 2 × SBS, moving exactly with it.
    const scaled = series(weeks * 7, (i) => 3 * (100 + wobble(i)));
    const c = pairCorrelation(PAIR, sbs, scaled);
    expect(c.r).toBeCloseTo(1);
    expect(c.n).toBe(weeks - 1);
  });

  it("uses week-over-week changes, so a trend both share isn't counted", () => {
    // Both rise every week, but the rest's wobble is SBS's turned upside down.
    const up = series(weeks * 7, (i) => 100 + i + wobble(i));
    const rest = (i: number) => 300 + 3 * i - wobble(i);
    const gsua = series(weeks * 7, (i) => 100 + i + wobble(i) + rest(i));
    expect(pairCorrelation(PAIR, up, gsua).r!).toBeLessThan(-0.9);
  });

  it("drops a week holding an SBS 0, a gap, or today, and a partial week at an edge", () => {
    const gsua = series(weeks * 7, (i) => 3 * (100 + wobble(i)));
    const full = pairCorrelation(PAIR, sbs, gsua).n;
    // A 0 in week 5 loses the changes into and out of it.
    const zero = sbs.map((p, i) => (i === 5 * 7 + 2 ? { ...p, value: 0 } : p));
    expect(pairCorrelation(PAIR, zero, gsua).n).toBe(full - 2);
    const gap = gsua.map((p, i) => (i === 5 * 7 + 2 ? { ...p, value: null } : p));
    expect(pairCorrelation(PAIR, sbs, gap).n).toBe(full - 2);
    // Today is the last day's running total: the last week is in progress.
    const today = sbs.map((p, i) => (i === sbs.length - 1 ? { ...p, is_today: true } : p));
    expect(pairCorrelation(PAIR, today, gsua).n).toBe(full - 1);
    // A window opening on a Wednesday has no full first week.
    expect(pairCorrelation(PAIR, sbs.slice(2), gsua.slice(2)).n).toBe(full - 1);
  });

  it("has no r below the minimum, and says what it has", () => {
    const short = MIN_CHANGES; // weeks → one change fewer
    const c = pairCorrelation(PAIR, sbs.slice(0, short * 7), series(short * 7, (i) => 3 * (100 + wobble(i))));
    expect(c).toMatchObject({ r: null, n: short - 1, need: MIN_CHANGES });
  });
});

describe("correlationText", () => {
  const base = { pair: PAIR, need: 10 };
  it("names the pair, the method and n, with a real minus sign", () => {
    expect(correlationText({ ...base, r: 0.6812, n: 46 }))
      .toBe("SBS vs rest of GSUA · Personnel: r 0.68 · weekly changes · n 46");
    expect(correlationText({ ...base, r: -0.184, n: 30 }))
      .toBe("SBS vs rest of GSUA · Personnel: r −0.18 · weekly changes · n 30");
  });
  it("says why there is no r", () => {
    expect(correlationText({ ...base, r: null, n: 3 })).toBe("SBS vs rest of GSUA · Personnel: too little data for r (n 3, needs 10)");
    expect(correlationText({ ...base, r: null, n: 12 })).toMatch(/doesn't vary/);
  });
});
