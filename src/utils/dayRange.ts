// Shared time-window options for every daily & hourly chart view. Single source
// so the picker is identical everywhere. 150d/180d are less meaningful for the
// hourly views (lots of overlaid days), but we keep one list for consistency.
export const DAY_OPTIONS = [7, 14, 30, 60, 90, 120, 150, 180] as const;
// `days` is any positive integer; presets above are just shortcuts in the picker.
export type DayOption = number;
export const DEFAULT_DAYS = 30;

// No window reaches back past the start of the full-scale invasion. Every
// dataset here begins at or after it, so earlier days carry nothing — and
// `days` is a free-text number that a URL or the custom input can make
// arbitrarily large, while each chart materialises one point per day in the
// window (fillDailyRange). Unbounded, that is a page that stops responding;
// bounded, the widest window is a few thousand points per chart.
export const WINDOW_FLOOR = "2022-02-24";

// The widest window ending at endDate that doesn't start before WINDOW_FLOOR.
// An end date before the floor has no room at all, so it gets the minimum of
// one day — itself.
export function maxDaysFor(endDate: string): number {
  return daysBetweenInclusive(WINDOW_FLOOR, endDate) ?? 1;
}

export function clampDays(days: number, endDate: string): number {
  return Math.min(Math.max(1, days), maxDaysFor(endDate));
}

// Parse a `days` URL param into a positive integer; falls back to DEFAULT_DAYS.
// Pass the window's end date to have the result bounded by WINDOW_FLOOR —
// callers that have one always should, so a hand-edited `?days=99999` is capped
// before it ever reaches a query or a chart.
export function parseDaysParam(raw: string | null, endDate?: string): number {
  const n = Number(raw);
  const days = Number.isInteger(n) && n > 0 ? n : DEFAULT_DAYS;
  return endDate ? clampDays(days, endDate) : days;
}

// Window semantics: a "30 day" window covers 30 inclusive calendar dates ending
// at `endDate` (so the offset back is days-1, not days). Both helpers encode
// this so every chart query uses the same convention.

// SQLite expression for the inclusive start of an N-day window ending at
// endDateSql (a date literal expression like a quoted YYYY-MM-DD).
export function windowStartSql(endDateSql: string, days: number): string {
  return `date('${endDateSql}', '-${days - 1} days')`;
}

// YYYY-MM-DD start date for the inclusive N-day window ending at endDate.
export function windowStartDate(endDate: string, days: number): string {
  const d = new Date(`${endDate}T12:00:00`);
  d.setDate(d.getDate() - (days - 1));
  return d.toISOString().slice(0, 10);
}

// Inverse of windowStartDate: how many days the inclusive window
// [startDate, endDate] spans. Both ends count, so a single day is 1 and
// 2026-09-01 → 2026-09-17 is 17 — the same off-by-one the rest of this file
// encodes as `days - 1`. Noon anchor for the same reason windowStartDate uses
// one: a DST shift moves midnight, never midday, so the division is exact.
// Returns null for a start after the end or an unparseable date; callers treat
// that as "not a window" rather than clamping, since the only way to produce
// one is typing into the date field past its own max.
export function daysBetweenInclusive(startDate: string, endDate: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) return null;
  const a = new Date(`${startDate}T12:00:00`);
  const b = new Date(`${endDate}T12:00:00`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  const days = Math.round((b.getTime() - a.getTime()) / 86_400_000) + 1;
  return days > 0 ? days : null;
}

// Day of week (0 = Sunday, as Date#getDay) of a YYYY-MM-DD date. Noon anchor,
// as above, so no timezone offset can move it onto the neighbouring day.
export function isoWeekday(date: string): number {
  return new Date(`${date}T12:00:00`).getDay();
}

// The weekday picker as a date predicate; undefined when nothing is picked,
// which every caller reads as "every day".
export function weekdayPredicate(weekdays: number[]): ((date: string) => boolean) | undefined {
  return weekdays.length === 0 ? undefined : (date) => weekdays.includes(isoWeekday(date));
}

// A daily view's rows narrowed to what its controls select: the window when
// an end date is picked (live mode's query is already bounded by it), AND the
// picked weekdays. Both, always — these used to be an if/else, so picking an
// end date silently switched the weekday filter off.
export function filterDailyRows<T extends { date: string }>(
  rows: T[],
  { selectedDate, days, weekdays }: { selectedDate: string; days: number; weekdays: number[] },
): T[] {
  let r = rows;
  if (selectedDate) {
    const startDate = windowStartDate(selectedDate, days);
    r = r.filter((row) => row.date >= startDate && row.date <= selectedDate);
  }
  const keep = weekdayPredicate(weekdays);
  return keep ? r.filter((row) => keep(row.date)) : r;
}
