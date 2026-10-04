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

// Pooled share of `subset` in `primary` (destroyed of hit, killed of hit), in
// percent: Σsubset / Σprimary over the positions where both are reported. This
// is the volume-weighted average — a quiet day with 2/2 destroyed doesn't pull
// it as hard as a 300-hit day — and it is what Σ TOTAL₂ / Σ TOTAL reads as.
// A position with only one side reported is dropped from both sums, so a gap
// in one series can't skew the ratio. Null when nothing was hit.
export function pooledRate(
  primary: Array<number | null | undefined>,
  subset: Array<number | null | undefined>,
): number | null {
  let num = 0, den = 0;
  for (let i = 0; i < primary.length; i++) {
    const p = primary[i], s = subset[i];
    if (typeof p !== "number" || typeof s !== "number") continue;
    num += s;
    den += p;
  }
  return den > 0 ? (num / den) * 100 : null;
}
