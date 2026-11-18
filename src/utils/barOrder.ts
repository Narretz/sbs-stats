import { Temporal } from "temporal-polyfill";
import { daysBetweenInclusive, windowStartDate } from "@/utils/dayRange";

// A chart's bars in date order, or ranked by value — the largest first ("max")
// or the smallest ("min").
//
// A ranking leaves out a period with no figure (a gap, not a 0) and the one in
// progress, which the caller names (`isLive`): today, the month with a
// projection or the current one, the week not yet over. A past period summed
// from fewer days than it has stays in, as it is, in both orders — its tooltip
// says how many days it covers.
//
// What a ranking covers: every period from the first up to the window's end —
// the records as they stood then — and as many of them as the window has
// periods. The page decides both, since it owns the window: it queries the
// periods and hands the count to its charts as a `Ranking` (hooks/useRanking).
export type BarOrder = "date" | "max" | "min";

export const BAR_ORDERS: readonly BarOrder[] = ["date", "max", "min"];

export function parseBarOrder(raw: string | null): BarOrder {
  return BAR_ORDERS.includes(raw as BarOrder) ? (raw as BarOrder) : "date";
}

export interface Ranking {
  order: Exclude<BarOrder, "date">;
  /** How many bars: the window's periods. */
  limit: number;
}

/** A page's ranking, or null in date order. */
export function rankingOf(order: BarOrder, limit: number): Ranking | null {
  return order === "date" ? null : { order, limit };
}

export interface Ranked<T> {
  bars: T[];
  /** Periods with a figure left out: the one in progress. */
  excluded: number;
}

/** The `limit` highest (or lowest) periods of `rows` by `valueOf`; ties by
 *  date, the earlier first. */
export function rankBars<T extends { date: string }>(
  rows: readonly T[], { order, limit }: Ranking, isLive: (row: T) => boolean,
  valueOf: (row: T) => number | null | undefined = (r) => (r as { value?: number | null }).value,
): Ranked<T> {
  const valued = rows.filter((r) => typeof valueOf(r) === "number");
  const complete = valued.filter((r) => !isLive(r));
  const sign = order === "max" ? -1 : 1;
  const bars = [...complete]
    .sort((a, b) => sign * ((valueOf(a) as number) - (valueOf(b) as number)) || a.date.localeCompare(b.date))
    .slice(0, Math.max(0, limit));
  return { bars, excluded: valued.length - complete.length };
}

/** A bar chart's period still in progress on `today`: the current month
 *  ("YYYY-MM"), or on a weekly chart, whose bars are keyed by their Monday
 *  ("YYYY-MM-DD"), the week not yet over. A projection marks one too (the
 *  month a lagging source still reports into) — that, the chart checks. */
export const livePeriod = (today: string) => (date: string): boolean =>
  date.length === 7
    ? date >= today.slice(0, 7)
    : Temporal.PlainDate.from(date).add({ days: 6 }).toString() >= today;

/** How many days a daily page queries: its window's, or, ranked, every day
 *  from the dataset's first (`minDate`) to the window's end. */
export function rankQueryDays(order: BarOrder, days: number, endDate: string, minDate: string | null | undefined): number {
  if (order === "date" || !minDate) return days;
  return Math.max(days, daysBetweenInclusive(minDate, endDate) ?? 0);
}

/** The days of a `days`-long window ending `endDate` — of the picked weekdays,
 *  when `keep` is given: a daily ranking's bar count. */
export function windowDayCount(endDate: string, days: number, keep?: ((date: string) => boolean) | null): number {
  let n = 0;
  for (let d = Temporal.PlainDate.from(windowStartDate(endDate, days)); d.toString() <= endDate; d = d.add({ days: 1 }))
    if (!keep || keep(d.toString())) n++;
  return n;
}

/** recharts XAxis props for a ranked axis: slanted, and every bar labelled up
 *  to `everyUpTo` bars — they are out of date order, so a thinned axis leaves
 *  most of them without a date — thinned past that, where they can't all fit. */
export function rankedAxisProps(bars: number, everyUpTo = 60) {
  return { interval: bars <= everyUpTo ? 0 : undefined, angle: -45, textAnchor: "end", height: 56 } as const;
}
