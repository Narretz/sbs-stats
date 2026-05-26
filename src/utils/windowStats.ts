// Max + median over a set of values, used for the chart MAX/MED reference lines
// when the user scopes them to the visible window. Mirrors the convention the
// per-hook queryGlobalStats use: median is the upper-middle of the sorted values
// (no averaging for even counts), nulls are ignored.
export function maxMedian(values: Array<number | null | undefined>): { max: number; median: number } {
  const v = values.filter((x): x is number => typeof x === "number").sort((a, b) => a - b);
  if (!v.length) return { max: 0, median: 0 };
  return { max: v[v.length - 1], median: v[Math.floor(v.length / 2)] };
}
