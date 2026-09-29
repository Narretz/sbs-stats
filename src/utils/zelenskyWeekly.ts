// Pure helpers for the President's weekly strike tally (site `zelensky-weekly`,
// scripts/zelensky_weekly). The DB's `weekly` view already resolves one tally
// per ISO week; what is left for the page is laying those weeks on an axis
// that shows the weeks WITHOUT a tally, and saying how hedged each figure is.
import { Temporal } from "temporal-polyfill";
import type { MonthlyDataPoint, ZelenskyBound, ZelenskyCategory, ZelenskyWeekRow } from "@/types";

// Every Monday from `firstMonday` to `lastMonday`, inclusive. Weeks with no
// tally still get a slot: the series has long stretches (Apr–Sep 2025) where
// the President switched to month-to-date totals, and bridging them would
// read as "no change" rather than "not reported".
export function mondaysBetween(firstMonday: string, lastMonday: string): string[] {
  const out: string[] = [];
  let d = Temporal.PlainDate.from(firstMonday);
  const stop = Temporal.PlainDate.from(lastMonday);
  while (Temporal.PlainDate.compare(d, stop) <= 0) {
    out.push(d.toString());
    d = d.add({ days: 7 });
  }
  return out;
}

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

// A fixed table, not toLocaleString: ICU versions disagree on the short form
// ("Sep" vs "Sept"), and the same week should read the same in every browser.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const mon = (d: Temporal.PlainDate) => MONTHS[d.month - 1];

// The x-axis labels: the first Monday of each quarter. Weekly slots are too
// dense to label one by one (~130 across the series), and recharts' own
// thinning still collides at this width.
export function quarterTicks(mondays: string[]): string[] {
  const seen = new Set<string>();
  return mondays.filter((m) => {
    const d = Temporal.PlainDate.from(m);
    const key = `${d.year}-${d.month}`;
    if ((d.month - 1) % 3 !== 0 || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// A quarter tick's label: "2025-04-07" → "Apr 2025".
export function formatWeekTick(monday: string): string {
  const d = Temporal.PlainDate.from(monday);
  return `${mon(d)} ${d.year}`;
}

// "2026-09-21" → "21–27 Sep 2026"; a week straddling a month or year names both.
export function formatWeekRange(monday: string): string {
  const start = Temporal.PlainDate.from(monday);
  const end = start.add({ days: 6 });
  if (start.year !== end.year) {
    return `${start.day} ${mon(start)} ${start.year} – ${end.day} ${mon(end)} ${end.year}`;
  }
  if (start.month !== end.month) {
    return `${start.day} ${mon(start)} – ${end.day} ${mon(end)} ${end.year}`;
  }
  return `${start.day}–${end.day} ${mon(end)} ${end.year}`;
}
