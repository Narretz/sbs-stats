import type { DayTotals } from "@/utils/monthProjection";
import { maxMedian } from "@/utils/windowStats";

// Each month's median DAY, per metric — the "Daily med" column of the monthly
// tooltips: what a typical day of that month looked like, which a month's sum
// can't say once months differ in length or in how many days were reported.
//
// Over the days that have a figure: a day with no row, or a null for the
// metric, is a gap rather than a zero. Days from `incompleteFrom` on (today,
// still filling in) are left out, as projectFromDays leaves them out — a
// half-reported day would drag the median down. The median is the upper
// middle, the convention of every MED on the site (windowStats.maxMedian).
export function dailyMediansByMonth<K extends string>(
  days: readonly DayTotals<K>[],
  keys: readonly K[],
  incompleteFrom: string,
): Map<string, Partial<Record<K, number>>> {
  const byMonth = new Map<string, DayTotals<K>[]>();
  for (const d of days) {
    if (d.date >= incompleteFrom) continue;
    const month = d.date.slice(0, 7);
    const list = byMonth.get(month);
    if (list) list.push(d);
    else byMonth.set(month, [d]);
  }
  const out = new Map<string, Partial<Record<K, number>>>();
  for (const [month, list] of byMonth) {
    const medians: Partial<Record<K, number>> = {};
    for (const k of keys) {
      const values = list.map((d) => d.values[k]).filter((v): v is number => typeof v === "number");
      if (values.length) medians[k] = maxMedian(values).median;
    }
    out.set(month, medians);
  }
  return out;
}

// Copies each month's medians onto its row as `<key>_daily_median`, beside the
// `<key>_projected` the hooks already write.
export function attachDailyMedians<K extends string>(
  row: { date: string } & Record<string, unknown>,
  medians: Map<string, Partial<Record<K, number>>>,
): void {
  for (const [k, v] of Object.entries(medians.get(row.date.slice(0, 7)) ?? {})) {
    row[`${k}_daily_median`] = v;
  }
}

// A day's figure for a synthetic total (the losses pages' "all targets"): the
// sum of the parts it has, or null — a gap — when it has none. A median of
// sums has to be taken over each day's sum; it isn't the sum of the medians.
export function sumPresent<K extends string>(values: Partial<Record<K, number | null>>, keys: readonly K[]): number | null {
  let sum = 0, any = false;
  for (const k of keys) {
    const v = values[k];
    if (typeof v === "number") { sum += v; any = true; }
  }
  return any ? sum : null;
}

// Each month's days with a figure, per metric — what "X of Y days"
// counts. A date is counted once however many rows carry it (a day reported
// by two sources), and, as for the medians, only before `incompleteFrom`.
export function dayCountsByMonth<K extends string>(
  days: readonly DayTotals<K>[],
  keys: readonly K[],
  incompleteFrom: string,
): Map<string, Record<K, number>> {
  const dated = new Map<string, Map<K, Set<string>>>();
  for (const d of days) {
    if (d.date >= incompleteFrom) continue;
    const month = d.date.slice(0, 7);
    let perKey = dated.get(month);
    if (!perKey) dated.set(month, perKey = new Map(keys.map((k) => [k, new Set<string>()])));
    for (const k of keys) if (typeof d.values[k] === "number") perKey.get(k)!.add(d.date);
  }
  const out = new Map<string, Record<K, number>>();
  for (const [month, perKey] of dated) {
    out.set(month, Object.fromEntries(keys.map((k) => [k, perKey.get(k)!.size])) as Record<K, number>);
  }
  return out;
}

// Copies each month's counts onto its row as `<key>_days`, and nulls a metric
// no day of the month has a figure for: its sum reads 0 (SQL's SUM over
// nothing, or a COALESCE), and a month the source never reported it — GSUA's
// shellings before May 2024 — is a gap, not a quiet month. On the row, so
// every reader of it (the page, its all-data MAX/MED, the combined charts)
// gets the gap.
export function attachDayCounts<K extends string>(
  row: { date: string } & Record<string, unknown>,
  counts: Map<string, Partial<Record<K, number>>>,
): void {
  for (const [k, v] of Object.entries(counts.get(row.date.slice(0, 7)) ?? {})) {
    row[`${k}_days`] = v;
    if (v === 0 && k in row) row[k] = null;
  }
}
