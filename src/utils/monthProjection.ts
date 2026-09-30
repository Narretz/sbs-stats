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
  // The month's actual also holds a day still filling in (today's, as a rule),
  // which the projection sets aside rather than averages.
  partialDay: boolean;
  projected: Partial<Record<K, number>>;
}

// The tooltip / compare caption for a projection's basis.
export const projectionBasis = (completedDays: number, daysInMonth: number, partialDay?: boolean) =>
  `${completedDays} of ${daysInMonth} days complete${partialDay ? ", one day partial" : ""}`;

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
    // Late on the last day, a busy partial can outrun the average it replaces;
    // the month can't end below what it already holds.
    projected[k] = Math.max(total, Math.round((complete / completedDays) * daysInMonth));
  }
  return { completedDays, daysInMonth, partialDay: partial !== undefined, projected };
}

// One day of a source whose month is the sum of its days.
export interface DayTotals<K extends string> {
  date: string; // YYYY-MM-DD, in the source's own time zone
  values: Partial<Record<K, number | null>>;
}

// End-of-month projection for the sources whose month is a sum of dated days.
// Only the days before `incompleteFrom` count as complete — normally today,
// whose row, where there is one, is still filling in — and of those only up to
// the latest that has data, since a source can lag by days (the Kaggle
// republish runs ~a week behind). Days in between with no row are read as
// zero, as the month total reads them. `days` is the month's rows, today's
// included: the projection never falls below what the month already holds,
// and a row from `incompleteFrom` on is the partial day. Null when no day
// before `incompleteFrom` has data.
export function projectFromDays<K extends string>(
  month: string,
  incompleteFrom: string,
  days: readonly DayTotals<K>[],
  keys: readonly K[],
): MonthEndProjection<K> | null {
  const inMonth = days.filter((d) => d.date.slice(0, 7) === month);
  const complete = inMonth.filter((d) => d.date < incompleteFrom);
  if (complete.length === 0) return null;
  const basis = complete.reduce((a, d) => (d.date > a ? d.date : a), complete[0].date);
  const [y, m] = month.split("-").map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const completedDays = Number(basis.slice(8, 10));

  const sum = (rows: readonly DayTotals<K>[], k: K) => {
    let s = 0, any = false;
    for (const r of rows) {
      const v = r.values[k];
      if (typeof v === "number") { s += v; any = true; }
    }
    return any ? s : null;
  };
  const projected: Partial<Record<K, number>> = {};
  for (const k of keys) {
    const actual = sum(inMonth, k);
    if (actual == null) continue;
    const done = sum(complete, k) ?? 0;
    projected[k] = Math.max(actual, Math.round((done / completedDays) * daysInMonth));
  }
  return { completedDays, daysInMonth, partialDay: inMonth.some((d) => d.date >= incompleteFrom), projected };
}

// One report date of RU MoD's air-defense claims, split by window.
export interface NightDayTotals {
  date: string; // report_date, MSK
  night: number; // 20:00 the evening before → 07:00/08:00
  day: number; // everything else, the daytime windows
  nightDone: boolean; // a night report ending on `date` is in
}

// RU MoD's projection, per window, since the two halves of a day settle apart:
// the night is complete once its morning report is in, so today's night counts
// in full and only the daytime is set aside — much as SBS subtracts just the
// part of today still filling in. A night split into 20–23 / 23–07 reports is
// complete only with the part ending on the day itself. The daytime is the
// series that lags, so it names the days complete.
export function projectNightDay(
  month: string,
  today: string,
  days: readonly NightDayTotals[],
): (Omit<MonthEndProjection<never>, "projected"> & { night: number; day: number }) | null {
  const tonightDone = days.some((d) => d.date === today && d.nightDone);
  const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const series = (key: "night" | "day", incompleteFrom: string) =>
    projectFromDays(month, incompleteFrom, days.map((d) => ({ date: d.date, values: { [key]: d[key] } })), [key]);
  const night = series("night", tonightDone ? tomorrow : today);
  const day = series("day", today);
  if (!night || !day) return null;
  return {
    completedDays: day.completedDays,
    daysInMonth: day.daysInMonth,
    partialDay: day.partialDay,
    night: night.projected.night ?? 0,
    day: day.projected.day ?? 0,
  };
}
