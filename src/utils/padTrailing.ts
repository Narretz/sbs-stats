// Pad the trailing end of a chart's data array with null-valued rows up to a
// target end (day / month / week). Used so a chart's X-axis extends to the
// user's selected end even when the underlying dataset lags — the gap between
// last available data and the selected end becomes visible (line breaks; bars
// render as empty slots) instead of the chart silently ending early.
//
// All padded rows carry `value: null` (and `is_today: false` for daily) so
// recharts skips them in the line/bar geometry but still shows the X-axis tick.
import { Temporal } from "temporal-polyfill";
import type { DailyDataPoint } from "@/types";

export function padTrailingDaily(
  data: DailyDataPoint[],
  endDate: string, // YYYY-MM-DD
): DailyDataPoint[] {
  if (data.length === 0) return data;
  const last = data[data.length - 1].date;
  if (last >= endDate) return data;
  const out = [...data];
  let cursor = Temporal.PlainDate.from(last).add({ days: 1 });
  const stop = Temporal.PlainDate.from(endDate);
  while (Temporal.PlainDate.compare(cursor, stop) <= 0) {
    out.push({ date: cursor.toString(), value: null, is_today: false });
    cursor = cursor.add({ days: 1 });
  }
  return out;
}

// MonthlyDataPoint.date is YYYY-MM (per MonthlyRow / per-source contract). The
// padded rows are emitted in the same format so the chart's axis and tooltip
// labels stay consistent with the real rows. Generic in the row type so the
// homepage's DailyDataPoint-shaped monthly series can use it too (just pass a
// blank that fills in `is_today: false`).
export function padTrailingMonthly<T extends { date: string }>(
  data: T[],
  endMonth: string, // YYYY-MM
  blank: (date: string) => T = (date) => ({ date, value: null } as unknown as T),
): T[] {
  if (data.length === 0) return data;
  const lastMonth = data[data.length - 1].date.slice(0, 7);
  if (lastMonth >= endMonth) return data;
  const out = [...data];
  let cursor = Temporal.PlainYearMonth.from(lastMonth).add({ months: 1 });
  const stop = Temporal.PlainYearMonth.from(endMonth);
  while (Temporal.PlainYearMonth.compare(cursor, stop) <= 0) {
    out.push(blank(cursor.toString()));
    cursor = cursor.add({ months: 1 });
  }
  return out;
}

// Extend a sorted YYYY-MM list with any missing months up to `endMonth`.
// Used by views (e.g. SbuAlfa) whose chart x-axis is driven by a period array
// rather than a data-point array.
export function extendMonthsTo(months: string[], endMonth: string): string[] {
  if (months.length === 0) return months;
  const last = months[months.length - 1];
  if (last >= endMonth) return months;
  const out = [...months];
  let cursor = Temporal.PlainYearMonth.from(last).add({ months: 1 });
  const stop = Temporal.PlainYearMonth.from(endMonth);
  while (Temporal.PlainYearMonth.compare(cursor, stop) <= 0) {
    out.push(cursor.toString());
    cursor = cursor.add({ months: 1 });
  }
  return out;
}

// Resolved end-of-chart helpers. Pages call these to compute the target end
// before handing it to the pad function; consolidates the "selectedDate or
// today (Kyiv)" fallback so every page expresses the rule the same way.
export function resolvedEndDate(
  selectedDate: string | undefined,
  tz: string = "Europe/Kyiv",
): string {
  return selectedDate && /^\d{4}-\d{2}-\d{2}$/.test(selectedDate)
    ? selectedDate
    : Temporal.Now.plainDateISO(tz).toString();
}

export function resolvedEndMonth(tz: string = "Europe/Kyiv"): string {
  return Temporal.Now.plainDateISO(tz).toString().slice(0, 7);
}
