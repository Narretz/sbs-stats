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

// A CIT month's end-of-month projection. Scaled by the days a report actually
// covered, not by today's date: CIT can be a day or two behind, and a weekend
// post covers two days at once, so "day 9 of 30" is the wrong denominator.
// Null for a month that is complete, or has no report yet.
export function projectCitMonth(
  month: string, value: number | null, coveredDays: number,
): { projected: number; coveredDays: number; daysInMonth: number } | null {
  const [y, m] = month.split("-").map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  if (value == null || coveredDays <= 0 || coveredDays >= daysInMonth) return null;
  return { projected: Math.round((value * daysInMonth) / coveredDays), coveredDays, daysInMonth };
}

// A stacked bar's height: the sum of its series, or null when it has none —
// a day no report covers, which is a gap rather than a zero.
export function stackTotal<K extends string>(row: Partial<Record<K, number | null>>, keys: readonly K[]): number | null {
  const parts = keys.map((k) => row[k]).filter((v): v is number => typeof v === "number");
  return parts.length ? parts.reduce((a, b) => a + b, 0) : null;
}

// Reports laid out one figure per day for each month's median day: a weekend
// report is two days at half its figures each, as on the daily page. Each day
// stays in its REPORT's month, the key the monthly sums use — so a Saturday
// whose report ends on the 1st counts toward the 1st's month, not its own.
export function reportDays<K extends string>(
  reports: readonly { report_date: string; window_days: number; values: Partial<Record<K, number | null>> }[],
): { date: string; values: Partial<Record<K, number | null>> }[] {
  const out: { date: string; values: Partial<Record<K, number | null>> }[] = [];
  for (const r of reports) {
    const span = r.window_days > 0 ? r.window_days : 1;
    const values = Object.fromEntries(
      Object.entries(r.values).map(([k, v]) => [k, typeof v === "number" ? v / span : null]),
    ) as Partial<Record<K, number | null>>;
    const end = Temporal.PlainDate.from(r.report_date);
    for (let back = span - 1; back >= 0; back--) {
      const day = end.subtract({ days: back }).toString();
      out.push({ date: day.slice(0, 7) === r.report_date.slice(0, 7) ? day : r.report_date, values });
    }
  }
  return out;
}
