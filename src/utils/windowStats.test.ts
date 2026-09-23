import { describe, expect, it } from "vitest";
import { maxMedian } from "@/utils/windowStats";

describe("maxMedian", () => {
  it("is zeroed for an empty window", () => {
    // A window with nothing in it draws no reference lines rather than NaN ones.
    expect(maxMedian([])).toEqual({ max: 0, median: 0, total: 0 });
    expect(maxMedian([null, undefined])).toEqual({ max: 0, median: 0, total: 0 });
  });

  it("skips nulls rather than counting them as zero", () => {
    // A day the source never reported is not a day with no activity — counting
    // it would halve the median of a series with gaps.
    expect(maxMedian([10, null, 20, undefined])).toEqual({ max: 20, median: 20, total: 30 });
  });

  it("takes the upper-middle value on an even count, without averaging", () => {
    // Mirrors the SQL the per-source hooks use, so window-scoped and all-data
    // stats can't disagree about what "median" means.
    expect(maxMedian([1, 2, 3, 4]).median).toBe(3);
    expect(maxMedian([1, 2, 3]).median).toBe(2);
  });

  it("does not care what order the values arrive in", () => {
    expect(maxMedian([5, 1, 4, 2, 3])).toEqual(maxMedian([1, 2, 3, 4, 5]));
  });
});
