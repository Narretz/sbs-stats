// The numbers in the hourly chart's tooltip / pinned sheet, for one hovered
// hour: how the highlighted day compares with the other days in the window at
// that hour, and what the end-of-day estimate was at that hour.
import type { DailyDaySeries, EodEstimate } from "@/types";

export interface HourBaseline {
  // Over the OTHER days in the window that have a value at this hour — the day
  // being compared is left out of its own baseline, or it would pull the median
  // toward itself and could be the max it is compared against.
  days: number;
  median: number | null;
  max: number | null;
  maxDate: string | null; // the most recent day that reached `max`
  // The highlighted day against the median, in percent; null without a value
  // or a non-zero median to compare.
  deltaPct: number | null;
}

// One hour's readings across a set of days, sorted ascending by value (ties by
// date), so a baseline that leaves one day out is an index walk rather than a
// re-sort — the whole-dataset version is built once and read on every hover.
export interface HourHistory {
  values: number[];
  dates: string[];
}

export function toHourHistory(entries: { date: string; value: number }[]): HourHistory {
  const sorted = [...entries].sort((a, b) => a.value - b.value || a.date.localeCompare(b.date));
  return { values: sorted.map((e) => e.value), dates: sorted.map((e) => e.date) };
}

// Every reading per hour (0–23), from rows of the whole dataset.
export function hourHistories(points: { date: string; hour: number; value: number | null }[]): Map<number, HourHistory> {
  const byHour = new Map<number, { date: string; value: number }[]>();
  for (const p of points) {
    if (typeof p.value !== "number") continue;
    let list = byHour.get(p.hour);
    if (!list) byHour.set(p.hour, (list = []));
    list.push({ date: p.date, value: p.value });
  }
  return new Map([...byHour].map(([h, list]) => [h, toHourHistory(list)]));
}

// The baseline from a history, leaving `currentDate` out; `currentValue` is the
// highlighted day's own reading, compared against the median.
export function baselineOf(
  history: HourHistory | undefined,
  currentDate: string | undefined,
  currentValue: number | undefined,
): HourBaseline {
  const { values = [], dates = [] } = history ?? {};
  const skip = currentDate ? dates.indexOf(currentDate) : -1;
  const n = values.length - (skip >= 0 ? 1 : 0);
  if (n <= 0) return { days: 0, median: null, max: null, maxDate: null, deltaPct: null };
  // The i-th of the other days, in sorted order.
  const nth = (i: number) => (skip >= 0 && i >= skip ? i + 1 : i);
  // Upper-middle for an even count, like every other median on the site
  // (utils/windowStats.ts).
  const median = values[nth(Math.floor(n / 2))];
  // Last in sort order is the max, and among equal maxima the most recent day.
  const top = nth(n - 1);
  const deltaPct = currentValue != null && median !== 0 ? ((currentValue - median) / median) * 100 : null;
  return { days: n, median, max: values[top], maxDate: dates[top], deltaPct };
}

export function hourBaseline(
  entries: { date: string; value: number }[],
  currentDate: string | undefined,
): HourBaseline {
  const current = entries.find((e) => e.date === currentDate);
  return baselineOf(toHourHistory(entries), currentDate, current?.value);
}

// The end-of-day estimate to show at a hovered hour of today's series. `hour`
// is the reading's hour (0–23), `steps` today's estimates in time order.
//
// - An hour today has a reading for: the estimate made at that reading, so
//   walking the cursor back replays how the estimate moved through the day.
//   None when that hour had no usable profile (too few past days had a reading
//   then) or the day was already settled.
// - An hour after today's latest reading: the current estimate, the one the
//   day stands at now — as long as it was made at that latest reading.
// - An hour before the latest one that today has no reading for: none; the
//   current estimate would read as though it had been known then.
export function eodAtHour(
  steps: EodEstimate[] | null | undefined,
  today: DailyDaySeries | undefined,
  hour: number,
): EodEstimate | null {
  if (!steps?.length || !today) return null;
  const read = today.points.filter((p) => typeof p.value === "number").map((p) => p.hour);
  if (!read.length) return null;
  const latest = Math.max(...read);
  const at = hour > latest ? latest : hour;
  if (!read.includes(at)) return null;
  return steps.find((s) => Number(s.bucket) === at) ?? null;
}
