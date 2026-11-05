import { monthCoverage } from "@/utils/monthProjection";

// The tooltip's "vs prev" column: a period's change on the one before it, in
// percent. Monthly charts mostly; a weekly chart drawn by the same component
// gets it per week.
//
// Only like is compared with like. The month in progress compares its
// projection, not its running total — which would read as a collapse every
// first of the month — and says so (`projected`); without a projection it has
// nothing comparable to offer. Either side summed from fewer days than it has
// (a source's first month, a scrape gap) is no basis either, and neither is a
// previous figure of 0, whose percentage is undefined.

export interface PeriodFigure {
  value: number | null | undefined;
  /** End-of-period projection, on the period in progress. */
  projected?: number | null;
  /** Covers fewer days than the period has (see `partialMonth`). */
  partial?: boolean;
}

export interface PeriodChange {
  /** (current − previous) / previous × 100. */
  pct: number;
  /** Measured from the current period's projection. */
  projected: boolean;
}

export function periodChange(cur: PeriodFigure, prev: PeriodFigure | undefined): PeriodChange | null {
  if (!prev || prev.partial || typeof prev.value !== "number" || prev.value <= 0) return null;
  const projected = cur.projected != null;
  const v = projected ? cur.projected : cur.partial ? null : cur.value;
  if (typeof v !== "number") return null;
  return { pct: ((v - prev.value) / prev.value) * 100, projected };
}

// Whether a "YYYY-MM" period is short of days: the month in progress always;
// a past month when its day count says so (monthCoverage). Other keys — a
// weekly chart's Monday dates — are never partial here.
export function partialMonth(date: string, today: string, daysAvailable?: number | null): boolean {
  if (!/^\d{4}-\d{2}$/.test(date)) return false;
  if (date >= today.slice(0, 7)) return true;
  return monthCoverage(date, today, daysAvailable) !== undefined;
}

// The entry before `d` in `data`, for a chart's describe(d), which is handed
// the row and not its index.
export function previousOf<T>(data: readonly T[], d: T): T | undefined {
  const i = data.indexOf(d);
  return i > 0 ? data[i - 1] : undefined;
}

/** "+12.3%", "−4.0%" (a real minus), "≈+5.1%" for a projected change. */
export function formatPeriodChange(c: PeriodChange): string {
  const r = Math.round(c.pct * 10) / 10;
  const sign = r > 0 ? "+" : r < 0 ? "−" : "";
  return `${c.projected ? "≈" : ""}${sign}${Math.abs(r).toFixed(1)}%`;
}
