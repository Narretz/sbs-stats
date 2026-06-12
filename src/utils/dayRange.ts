// Shared time-window options for every daily & hourly chart view. Single source
// so the picker is identical everywhere. 150d/180d are less meaningful for the
// hourly views (lots of overlaid days), but we keep one list for consistency.
export const DAY_OPTIONS = [7, 14, 30, 60, 90, 120, 150, 180] as const;
// `days` is any positive integer; presets above are just shortcuts in the picker.
export type DayOption = number;
export const DEFAULT_DAYS = 30;

// Parse a `days` URL param into a positive integer; falls back to DEFAULT_DAYS.
export function parseDaysParam(raw: string | null): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_DAYS;
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
