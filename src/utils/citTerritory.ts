import { Temporal } from "temporal-polyfill";
import {
  CIT_TERRITORY_PARTS,
  type CitOutcomes,
  type CitTerritoryDailyRow,
  type CitTerritoryRow,
} from "@/types";

// One report's breakdown by controlling side, as summed from its casualty rows.
export interface CitTerritoryReport {
  report_date: string;       // the window's END date
  window_days: number;
  outcomes: CitOutcomes;
}

// Reads the `<part>_killed` / `<part>_injured` columns of the territory query
// (useDatabaseCitCivilians territorySql). A missing or NULL cell is 0: the
// query's SUM(CASE … ELSE 0) only yields NULL for an empty group.
export function outcomesFromSql(row: Record<string, unknown>): CitOutcomes {
  const num = (k: string) => (typeof row[k] === "number" ? (row[k] as number) : 0);
  const out = {} as CitOutcomes;
  for (const p of CIT_TERRITORY_PARTS) {
    out[p] = { killed: num(`${p}_killed`), injured: num(`${p}_injured`) };
  }
  return out;
}

// What the bars draw: killed + injured per part, and the Russian-controlled
// band as occupied Ukraine + Russia.
export function territoryTotals(o: CitOutcomes): Omit<CitTerritoryRow, "date" | "outcomes"> {
  const sum = (k: keyof CitOutcomes) => o[k].killed + o[k].injured;
  const occupiedUkraine = sum("occupiedUkraine");
  const russia = sum("russia");
  return {
    uaControlled: sum("uaControlled"),
    ruControlled: occupiedUkraine + russia,
    occupiedUkraine,
    russia,
    unattributed: sum("unattributed"),
  };
}

// Every figure multiplied by `k` — a weekend report's per-day share (1/span)
// for the bars, or back to its whole for the tooltip (×span).
export function scaleOutcomes(o: CitOutcomes, k: number): CitOutcomes {
  const out = {} as CitOutcomes;
  for (const p of CIT_TERRITORY_PARTS) out[p] = { killed: o[p].killed * k, injured: o[p].injured * k };
  return out;
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
    const outcomes = scaleOutcomes(r.outcomes, 1 / span);
    for (let back = span - 1; back >= 0; back--) {
      const date = end.subtract({ days: back }).toString();
      byDay.set(date, {
        date,
        report_date: r.report_date,
        window_days: span,
        ...territoryTotals(outcomes),
        outcomes,
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
      unattributed: null, outcomes: null,
    });
    cursor = cursor.add({ days: 1 });
  }
  return out;
}
