// Pure helpers for the President's weekly strike tally (site `zelensky-weekly`,
// scripts/zelensky_weekly). The DB's `weekly` view already resolves one tally
// per ISO week; what is left for the page is laying those weeks on an axis
// that shows the weeks WITHOUT a tally, and saying how hedged each figure is.
//
// Weeks with no tally still get a slot: the series has long stretches (Apr–Sep
// 2025) where the President switched to month-to-date totals, and bridging
// them would read as "no change" rather than "not reported".
import type { MonthlyDataPoint, ZelenskyBound, ZelenskyCategory, ZelenskyWeekRow } from "@/types";

// The generic week helpers live in weekRange.ts (the combined charts' weekly
// grain uses them too); re-exported so the page has one import.
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
