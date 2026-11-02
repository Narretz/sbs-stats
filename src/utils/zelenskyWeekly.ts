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
import { monthDays } from "@/utils/monthProjection";
import { Temporal } from "temporal-polyfill";

// The generic week helpers live in weekRange.ts (the combined charts' weekly
// grain uses them too); re-exported so the page has one import.
import { formatWeekRange, quarterTicks } from "@/utils/weekRange";
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
  return new Map(rows.map((r) => [r.period_start, [sourceOf(r)]]));
}

const sourceOf = (r: ZelenskyWeekRow, label = ""): SheetSource =>
  ({ href: r.url, linkText: formatPostedAt(r.posted_at, "Europe/Kyiv", "Kyiv"), label });

// ── Monthly view ────────────────────────────────────────────────────────────
// The tally is weekly, so a month is built from the weeks: each week's figure
// spread evenly over its seven days (its daily average), and a month the sum
// of its days. A week spanning two months gives each its days' share. Days
// with no tally — no post that week, or a post that didn't name this weapon —
// add nothing and are counted out of `days_available`, which the tooltip
// reports as "X of Y days" (monthCoverage): such a month is undercounted, not
// quiet.

// The seven "YYYY-MM-DD" days of the week starting `monday`.
function weekDays(monday: string): string[] {
  const d = Temporal.PlainDate.from(monday);
  return Array.from({ length: 7 }, (_, i) => d.add({ days: i }).toString());
}

// "YYYY-MM" for every month from `first` to `last` (either may be a full date).
export function monthsBetween(first: string, last: string): string[] {
  const out: string[] = [];
  let m = Temporal.PlainYearMonth.from(first.slice(0, 7));
  const stop = Temporal.PlainYearMonth.from(last.slice(0, 7));
  while (Temporal.PlainYearMonth.compare(m, stop) <= 0) {
    out.push(m.toString());
    m = m.add({ months: 1 });
  }
  return out;
}

// One bar per month in `months`: the weeks' daily averages summed over the
// month's days, rounded (the source rounds everything; a fraction would be
// false precision). Null when no day of the month has a figure. A past month
// short of days carries a note, so its bar is flagged as undercounted rather
// than read as a quiet month; the month in progress (`liveMonth`) is short by
// definition, and its "X of Y days" says so.
export const UNDERCOUNT_NOTE = "Undercounted: some weeks of this month have no weekly tally";

export function toMonthlyDataset(
  rows: ZelenskyWeekRow[],
  category: ZelenskyCategory,
  months: string[],
  liveMonth: string,
): MonthlyDataPoint[] {
  const sum = new Map<string, number>();
  const days = new Map<string, number>();
  for (const r of rows) {
    const v = r[category];
    if (v == null) continue;
    for (const day of weekDays(r.period_start)) {
      const m = day.slice(0, 7);
      sum.set(m, (sum.get(m) ?? 0) + v / 7);
      days.set(m, (days.get(m) ?? 0) + 1);
    }
  }
  return months.map((date) => {
    const n = days.get(date) ?? 0;
    const point: MonthlyDataPoint = { date, value: n ? Math.round(sum.get(date)!) : null, days_available: n };
    if (n && date < liveMonth && n < (monthDays(date) ?? 0)) point.note = UNDERCOUNT_NOTE;
    return point;
  });
}

// The posts behind each month, for the pinned sheet: every week with a day in
// it, so a week spanning two months is listed under both.
export function monthlySources(rows: ZelenskyWeekRow[]): Map<string, SheetSource[]> {
  const out = new Map<string, SheetSource[]>();
  for (const r of rows) {
    for (const m of new Set([r.period_start.slice(0, 7), r.period_end.slice(0, 7)])) {
      out.set(m, [...(out.get(m) ?? []), sourceOf(r, `week ${formatWeekRange(r.period_start)}`)]);
    }
  }
  return out;
}

// The x-axis labels for a window: a quarter's first Monday, as for the whole
// series — but a short window (≤ ~7 months) would get one or two of those, so
// it labels every month's first Monday instead.
export function windowTicks(mondays: string[]): string[] {
  if (mondays.length > 30) return quarterTicks(mondays);
  const seen = new Set<string>();
  return mondays.filter((m) => !seen.has(m.slice(0, 7)) && !!seen.add(m.slice(0, 7)));
}
