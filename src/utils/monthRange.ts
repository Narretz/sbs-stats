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
// to `fallback` (DEFAULT_MONTHS unless the caller has its own default) for
// missing or invalid input.
export function parseMonthsParam(
  raw: string | null,
  fallback: MonthOption = DEFAULT_MONTHS,
): MonthOption {
  if (raw === "all") return "all";
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
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

// Parse an `end-month=YYYY-MM` URL value; anything else is "" (live).
export function parseEndMonthParam(raw: string | null): string {
  return raw && /^\d{4}-(0[1-9]|1[0-2])$/.test(raw) ? raw : "";
}

// A monthly page's window: the last `months` rows up to and including
// `endMonth` ("" = no end, i.e. live). Counts rows rather than calendar months,
// as the window always has — `key` reads a row's YYYY-MM, which is `date` for
// a data row and the value itself for a bare period list.
export function sliceMonthWindow<T>(
  rows: T[],
  months: MonthOption,
  endMonth: string,
  key: (row: T) => string = (r) => (typeof r === "string" ? r : (r as { date: string }).date),
): T[] {
  const upTo = endMonth ? rows.filter((r) => key(r).slice(0, 7) <= endMonth) : rows;
  if (months === "all" || upTo.length <= months) return upTo;
  return upTo.slice(upTo.length - months);
}

// The two halves of the end-month picker (MonthNav), within [min, max] — both
// YYYY-MM. Years newest first; a year's months in calendar order, only those
// inside the range.
export function yearsBetween(min: string, max: string): string[] {
  const out: string[] = [];
  for (let y = Number(max.slice(0, 4)); y >= Number(min.slice(0, 4)); y--) out.push(String(y));
  return out;
}

export function monthsOfYear(year: string, min: string, max: string): string[] {
  const out: string[] = [];
  for (let m = 1; m <= 12; m++) {
    const ym = `${year}-${String(m).padStart(2, "0")}`;
    if (ym >= min && ym <= max) out.push(ym);
  }
  return out;
}

// Picking another year keeps the month where that year has it, and otherwise
// takes the nearest one it does: a year cut short by the range's start or end
// clamps to its first or last month.
export function switchYear(current: string, year: string, min: string, max: string): string {
  const ym = `${year}${current.slice(4)}`;
  if (ym < min) return min;
  if (ym > max) return max;
  return ym;
}
