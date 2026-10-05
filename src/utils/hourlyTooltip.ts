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

export function hourBaseline(
  entries: { date: string; value: number }[],
  currentDate: string | undefined,
): HourBaseline {
  const current = entries.find((e) => e.date === currentDate);
  const others = entries.filter((e) => e.date !== currentDate);
  if (!others.length) return { days: 0, median: null, max: null, maxDate: null, deltaPct: null };

  // Upper-middle for an even count, like every other median on the site
  // (utils/windowStats.ts).
  const sorted = others.map((e) => e.value).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  let top = others[0];
  for (const e of others) {
    if (e.value > top.value || (e.value === top.value && e.date > top.date)) top = e;
  }
  const deltaPct = current && median !== 0 ? ((current.value - median) / median) * 100 : null;
  return { days: others.length, median, max: top.value, maxDate: top.date, deltaPct };
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
