import { Temporal } from "temporal-polyfill";
import type { CitTerritoryDailyRow } from "@/types";

// One report's breakdown by controlling side, as summed from its casualty rows.
export interface CitTerritoryReport {
  report_date: string;       // the window's END date
  window_days: number;
  uaControlled: number;
  occupiedUkraine: number;
  russia: number;
  unattributed: number;
}

// Lays reports out one row per calendar day across [startDate, endDate].
//
// A weekend report is one 48-hour figure, so each of its days gets the
// report's figures divided by its span — an average, the same treatment the
// headline charts give it, so a Sunday is not drawn as a spike with a
// Saturday-shaped hole before it. A day no report covers keeps every figure
// null: a gap, not a zero.
export function spreadTerritoryReports(
  reports: CitTerritoryReport[],
  startDate: string,
  endDate: string,
): CitTerritoryDailyRow[] {
  const byDay = new Map<string, CitTerritoryDailyRow>();
  for (const r of reports) {
    const span = r.window_days > 0 ? r.window_days : 1;
    const end = Temporal.PlainDate.from(r.report_date);
    const occupiedUkraine = r.occupiedUkraine / span;
    const russia = r.russia / span;
    for (let back = span - 1; back >= 0; back--) {
      const date = end.subtract({ days: back }).toString();
      byDay.set(date, {
        date,
        report_date: r.report_date,
        window_days: span,
        uaControlled: r.uaControlled / span,
        ruControlled: occupiedUkraine + russia,
        occupiedUkraine,
        russia,
        unattributed: r.unattributed / span,
      });
    }
  }

  const out: CitTerritoryDailyRow[] = [];
  let cursor = Temporal.PlainDate.from(startDate);
  const stop = Temporal.PlainDate.from(endDate);
  while (Temporal.PlainDate.compare(cursor, stop) <= 0) {
    const date = cursor.toString();
    out.push(byDay.get(date) ?? {
      date, report_date: null, window_days: 1,
      uaControlled: null, ruControlled: null, occupiedUkraine: null, russia: null,
      unattributed: null,
    });
    cursor = cursor.add({ days: 1 });
  }
  return out;
}
