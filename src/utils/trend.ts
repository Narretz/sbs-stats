// The least-squares trend line the daily charts draw under each series.
import type { DailyDataPoint, EodEstimate } from "@/types";

// Fitted value per point (rounded, floored at 0); null where the point has no
// value, so the trend line breaks where the series does.
//
// `eod` is today's end-of-day estimate. Today's value is a running total —
// at 09:00 it is perhaps a third of a day — and fitting through it bends the
// whole line down at its newest end, which is exactly where a reader looks for
// the direction of travel. With an estimate, the fit uses it in today's place;
// the plotted point itself stays the actual partial.
//
// Without an estimate, `todayPartial` says what today's value is. Set, it is a
// running total, and today is left out of the fit: the projection is skipped
// for more than a settled day — early in the day the typical share already in
// is 0, and a rare counter has too few days to profile — and a 0 at 01:00 fit
// as a whole day drags the line down. Leaving a settled day out costs one point
// of the fit; the line is still drawn through today. Unset (a source whose
// today is a whole report), the value is used as it stands.
export function linearTrend(
  data: DailyDataPoint[],
  eod?: EodEstimate | null,
  todayPartial = false,
): Array<number | null> {
  const points = data
    .map((d, i) => ({
      x: i,
      y: !d.is_today ? d.value : eod ? eod.projected : todayPartial ? null : d.value,
    }))
    .filter((p): p is { x: number; y: number } => typeof p.y === "number");
  const n = points.length;
  if (n < 2) return data.map((d) => d.value);
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (const p of points) {
    sumX += p.x;
    sumY += p.y;
    sumXY += p.x * p.y;
    sumXX += p.x * p.x;
  }
  const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;
  return data.map((d, i) =>
    d.value == null ? null : Math.max(0, Math.round(slope * i + intercept)),
  );
}
