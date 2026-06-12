// Max + median + total over a set of values, used for the chart MAX/MED reference
// lines and TOTAL legend when the user scopes them to the visible window. Mirrors
// the convention the per-hook queryGlobalStats use: median is the upper-middle of
// the sorted values (no averaging for even counts), nulls are ignored. `total` is
// always window-scoped (sum of the values passed in).
export function maxMedian(values: Array<number | null | undefined>): { max: number; median: number; total: number } {
  const v = values.filter((x): x is number => typeof x === "number").sort((a, b) => a - b);
  if (!v.length) return { max: 0, median: 0, total: 0 };
  const total = v.reduce((s, n) => s + n, 0);
  return { max: v[v.length - 1], median: v[Math.floor(v.length / 2)], total };
}
