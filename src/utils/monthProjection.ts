// End-of-month projection from a month-to-date snapshot, extrapolated from the
// days that are complete. Today's running total is subtracted rather than
// counted as a full day: counting it made the projection drop by ~1/d every
// midnight and climb back as the day filled in.
//
// Completeness is judged at the snapshot's own time, not the wall clock — the
// month total is re-fetched only every ~6 hours, so after midnight the latest
// snapshot can still be yesterday's, with no part of today in it.

// One intraday reading of a day's running total, as stored in daily_stats.
export interface IntradayReading<K extends string> {
  collectedAt: string; // ISO timestamp the source stamped the figure with
  values: Partial<Record<K, number | null>>;
}

export interface MonthEndProjection<K extends string> {
  completedDays: number;
  daysInMonth: number;
  projected: Partial<Record<K, number>>;
}

const kyivDate = (iso: string) =>
  new Date(iso).toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });

// `month` is "YYYY-MM"; `snapshotAt` / `totals` are the month-to-date row.
// `readingsFor(date)` returns that Kyiv date's intraday readings. The snapshot
// day's partial is its latest reading at or before the snapshot; none yet
// (the first minutes after midnight) counts as zero. Returns null when no day
// of the month is complete yet — day 1 has nothing to extrapolate from.
export function projectMonthEnd<K extends string>(
  month: string,
  snapshotAt: string,
  totals: Partial<Record<K, number | null>>,
  readingsFor: (date: string) => IntradayReading<K>[],
  keys: readonly K[],
): MonthEndProjection<K> | null {
  const [y, m] = month.split("-").map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const snapDate = kyivDate(snapshotAt);
  if (snapDate.slice(0, 7) !== month) return null;
  const completedDays = Number(snapDate.slice(8, 10)) - 1;
  if (completedDays < 1) return null;

  const snapMs = Date.parse(snapshotAt);
  let partial: IntradayReading<K> | undefined;
  for (const r of readingsFor(snapDate)) {
    const t = Date.parse(r.collectedAt);
    if (t <= snapMs && (!partial || t > Date.parse(partial.collectedAt))) partial = r;
  }

  const projected: Partial<Record<K, number>> = {};
  for (const k of keys) {
    const total = totals[k];
    if (typeof total !== "number") continue;
    const today = partial?.values[k];
    const complete = Math.max(0, total - (typeof today === "number" ? today : 0));
    projected[k] = Math.round((complete / completedDays) * daysInMonth);
  }
  return { completedDays, daysInMonth, projected };
}
