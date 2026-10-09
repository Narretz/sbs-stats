import { Temporal } from "temporal-polyfill";
import { windowStartMonth, type MonthOption } from "@/utils/monthRange";
import type { MediazonaEstimateRow, MediazonaRolesRow } from "@/types";

// The Mediazona monthly page's window. Its two series don't cover the same
// months — the probate estimate is released less often than the names, so it
// ends months earlier — so the window is measured on their union: the picker
// offers every month either has, and both charts show the same months of it.
// A calendar window rather than the usual last-N rows for the same reason: N
// rows of each would end in different months.

export interface MonthSpan {
  first: string; // YYYY-MM, "" when there's no data
  last: string;
  count: number; // months first..last inclusive
}

export function unionSpan(...series: { week: string }[][]): MonthSpan {
  const months = series.flat().map((r) => r.week.slice(0, 7)).sort();
  if (!months.length) return { first: "", last: "", count: 0 };
  const first = months[0], last = months[months.length - 1];
  const count = Temporal.PlainYearMonth.from(first).until(Temporal.PlainYearMonth.from(last), { largestUnit: "months" }).months + 1;
  return { first, last, count };
}

export function mediazonaWindow(
  roles: MediazonaRolesRow[],
  estimate: MediazonaEstimateRow[],
  months: MonthOption,
  end: string, // YYYY-MM, "" = live (the union's last month)
): { roles: MediazonaRolesRow[]; estimate: MediazonaEstimateRow[] } {
  const span = unionSpan(roles, estimate);
  if (!span.count) return { roles: [], estimate: [] };
  const last = end || span.last;
  const start = windowStartMonth(last, months);
  const first = start > span.first ? start : span.first;
  const inWindow = <T extends { week: string }>(rows: T[]) =>
    rows.filter((r) => r.week.slice(0, 7) >= first && r.week.slice(0, 7) <= last);

  // Every month of the window gets an estimate row, an empty one where there's
  // no figure, so the two charts share an axis and the estimate's missing
  // months read as "not published yet" rather than as the chart ending early.
  const have = new Map(inWindow(estimate).map((r) => [r.week.slice(0, 7), r]));
  const padded: MediazonaEstimateRow[] = [];
  for (let m = Temporal.PlainYearMonth.from(first); m.toString() <= last; m = m.add({ months: 1 })) {
    const key = m.toString();
    padded.push(have.get(key) ?? { week: `${key}-01`, documented: null, estimate: null });
  }
  return { roles: inWindow(roles), estimate: padded };
}
