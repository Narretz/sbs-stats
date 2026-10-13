import { Rectangle } from "recharts";
import { formatDay, formatSpan } from "@/utils/dateFormat";

// Day bars for a source that reports some days in one multi-day post — CIT's
// 48-hour weekend summary. Drawn by CitStackedChart, for both the headline
// figures and the controlling-side split on the daily page.

export const dayTick = (v: string) => { const [, m, d] = v.split("-"); return `${d}/${m}`; };

// A spread weekend day is half of a whole number, so it can land on .5.
export const fmtCount = (n: number) =>
  (Number.isInteger(n) ? n : Math.round(n * 10) / 10).toLocaleString();

// What every day-bar shape needs to know about the report behind it. A day no
// report covers has `report_date` null.
export interface SpannedDay {
  date: string;
  report_date: string | null;
  window_days: number;
}

// The entry a day belongs to: its report. The days of one weekend report
// share it, so they hover, pin and step as one (usePinnedChart `entryOf`); a
// day no report covers is an entry of its own.
export const entryOfDay = (d: SpannedDay): string => d.report_date ?? d.date;

// The header for a day's entry — the whole weekend for either of its days.
export const formatEntry = (d: SpannedDay): string =>
  d.report_date == null ? formatDay(d.date) : formatSpan(weekendFirstDay(d), d.report_date);

export function weekendFirstDay(d: SpannedDay): string {
  return shiftDay(d.report_date ?? d.date, -(d.window_days - 1));
}

// A recharts `shape` that draws a multi-day report as ONE bar across its days.
// The first day draws nothing and leaves its x behind; the report's own date —
// its last day — draws one bar from there to its own right edge. recharts
// renders a series' bars in data order, so the first day's x is always
// recorded, in the same pass, before the last day reads it. A report whose
// first day falls before the window has no recorded x and draws as an ordinary
// single-day bar. Call it once per <Bar> per render.
export function spanBarShape(fill: string) {
  const firstDayX = new Map<string, number>();
  return (props: unknown) => {
    const { x, y, width, height, payload } =
      props as { x: number; y: number; width: number; height: number; payload: SpannedDay };
    const spans = payload.window_days > 1 && payload.report_date != null;
    if (spans && payload.date !== payload.report_date) {
      firstDayX.set(payload.report_date!, x);
      return <g />;
    }
    const left = spans ? firstDayX.get(payload.date) ?? x : x;
    return (
      <Rectangle x={left} y={y} width={x + width - left} height={height} fill={fill} />
    );
  };
}

function shiftDay(iso: string, deltaDays: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

