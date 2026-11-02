// Pure helpers for the President's weekly strike tally (site `zelensky-weekly`,
// scripts/zelensky_weekly). The DB's `weekly` view already resolves one tally
// per ISO week; what is left for the page is laying those weeks on an axis
// that shows the weeks WITHOUT a tally, and saying how hedged each figure is.
//
// Weeks with no tally still get a slot: the series has long stretches (Apr–Sep
// 2025) where the President switched to month-to-date totals, and bridging
// them would read as "no change" rather than "not reported".
import type { MonthlyDataPoint, ZelenskyBound, ZelenskyCategory, ZelenskyWeekRow } from "@/types";
import type { SheetSource } from "@/components/TooltipTable";
import { windowStartMonth, type MonthOption } from "@/utils/monthRange";
import { formatPostedAt } from "@/utils/sources";

// The generic week helpers live in weekRange.ts (the combined charts' weekly
// grain uses them too); re-exported so the page has one import.
import { quarterTicks } from "@/utils/weekRange";
export { formatWeekRange, formatWeekMonth as formatWeekTick, mondaysBetween, quarterTicks } from "@/utils/weekRange";

// One bar per Monday in `mondays`; `date` is the week's Monday. A week the
// chosen post didn't name this weapon in is null, never 0.
export function toWeeklyDataset(
  rows: ZelenskyWeekRow[],
  category: ZelenskyCategory,
  mondays: string[],
): MonthlyDataPoint[] {
  const byMonday = new Map(rows.map((r) => [r.period_start, r]));
  return mondays.map((date) => ({ date, value: byMonday.get(date)?.[category] ?? null }));
}

// The source's hedge, as a prefix on the number: "понад 3170" → "> 3,170".
const BOUND_PREFIX: Record<ZelenskyBound, string> = {
  exact: "",
  at_least: "> ",
  at_most: "< ",
  approx: "≈ ",
};

export function formatHedged(value: number | null, bound: ZelenskyBound | null): string {
  if (value == null) return "not reported";
  return `${BOUND_PREFIX[bound ?? "exact"]}${value.toLocaleString("en-US")}`;
}

// The page's time window is the monthly pages' one (months + end month), laid
// over weeks: a week is in it when its Monday falls in one of the window's
// calendar months. Calendar months rather than a count of rows — the monthly
// window counts rows because a monthly row IS a month; here ~4 rows are.
export function weeksInMonthWindow(mondays: string[], months: MonthOption, endMonth: string): string[] {
  const from = windowStartMonth(endMonth, months);
  return mondays.filter((m) => m.slice(0, 7) >= from && m.slice(0, 7) <= endMonth);
}

// Calendar months from `first` to `last` (YYYY-MM or longer), inclusive —
// the series' length as the window picker counts it.
export function monthsSpanned(first: string, last: string): number {
  const [y0, m0] = first.split("-").map(Number);
  const [y1, m1] = last.split("-").map(Number);
  return (y1 - y0) * 12 + (m1 - m0) + 1;
}

// The post each week's figures were read from, for the pinned sheet's
// Sources list, keyed by the week's Monday. Linked as when it went up, Kyiv.
export function weeklySources(rows: ZelenskyWeekRow[]): Map<string, SheetSource[]> {
  return new Map(rows.map((r) => [
    r.period_start,
    [{ href: r.url, linkText: formatPostedAt(r.posted_at, "Europe/Kyiv", "Kyiv"), label: "" }],
  ]));
}

// The x-axis labels for a window: a quarter's first Monday, as for the whole
// series — but a short window (≤ ~7 months) would get one or two of those, so
// it labels every month's first Monday instead.
export function windowTicks(mondays: string[]): string[] {
  if (mondays.length > 30) return quarterTicks(mondays);
  const seen = new Set<string>();
  return mondays.filter((m) => !seen.has(m.slice(0, 7)) && !!seen.add(m.slice(0, 7)));
}
