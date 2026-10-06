// Sum a daily series into calendar months — for a source that has no monthly
// query of its own (a GSUA direction's attacks and ongoing engagements).
//
// A month's value is the sum of the days that carry a number; a month with
// none is null (a gap), never 0. The month containing `today` is still running
// and is flagged `is_today`, like the partial last point of every other grain.
//
// Days without a figure are not flagged, unlike the weekly roll-up's sources:
// the GS report lists the directions that saw fighting, so a direction absent
// from a day's report is mostly a day with nothing there to report — a note on
// every month a quiet direction skipped a day would be all noise.
import type { DailyDataPoint } from "@/types";

export function sumByMonth(
  daily: { date: string; value: number | null }[],
  today: string,
): DailyDataPoint[] {
  const byMonth = new Map<string, { sum: number; reported: number }>();
  for (const d of daily) {
    const month = d.date.slice(0, 7);
    let m = byMonth.get(month);
    if (!m) byMonth.set(month, (m = { sum: 0, reported: 0 }));
    if (typeof d.value === "number") {
      m.sum += d.value;
      m.reported++;
    }
  }
  const thisMonth = today.slice(0, 7);
  return [...byMonth.keys()].sort().map((month) => {
    const { sum, reported } = byMonth.get(month)!;
    const point: DailyDataPoint = { date: month, value: reported ? sum : null, is_today: month === thisMonth };
    if (month === thisMonth && reported) point.note = `Month so far — ${Number(today.slice(8, 10))} days in.`;
    return point;
  });
}
