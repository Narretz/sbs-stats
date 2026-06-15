// Month-window helpers for the custom-charts homepage. Mirrors dayRange.ts
// but counts inclusive calendar months instead of days. Used per-chart when
// the chart's granularity is "monthly"; daily charts continue to use the
// day-based helpers.
//
// The "all" sentinel means "no upper bound on months" — the chart shows every
// month available from the source.

export const MONTH_OPTIONS = [3, 6, 12, 24, 36, 48, "all"] as const;
export type MonthOption = number | "all";
export const DEFAULT_MONTHS = 12;

// Parse a `m<...>` URL spec value into a positive integer or "all"; falls back
// to DEFAULT_MONTHS for invalid input.
export function parseMonthsParam(raw: string | null): MonthOption {
  if (raw === "all") return "all";
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MONTHS;
}

// Inclusive month window: a "12 month" window covers 12 calendar months
// ending at `endMonth` (so the offset back is months - 1).

// Returns the YYYY-MM of `endDate` (YYYY-MM-DD). When endDate is empty, uses
// "now" in Kyiv local time (same convention as the rest of the dashboard).
export function monthOf(endDate: string): string {
  if (endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate)) return endDate.slice(0, 7);
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" }).slice(0, 7);
}

// YYYY-MM start month for the inclusive N-month window ending at endMonth
// (a YYYY-MM string). "all" returns "0000-00" — a string that sorts before any
// real month, so callers can use a single >= comparison.
export function windowStartMonth(endMonth: string, months: MonthOption): string {
  if (months === "all") return "0000-00";
  const [y, m] = endMonth.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1, 1));
  d.setUTCMonth(d.getUTCMonth() - (months - 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
