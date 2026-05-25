import type { EodEstimate } from "@/types";

// One intraday reading of a day: the cumulative values seen at a checkpoint.
// `bucket` is the profile key (intraday checkpoint, e.g. hour "14" or "16");
// `asOf` is the label shown for today (e.g. "14:00", "16:00").
export interface EodReading<K extends string> {
  bucket: string;
  asOf: string;
  values: Partial<Record<K, number | null>>;
}

// A key needs this many complete-day samples at the current checkpoint before we
// trust its projection, and once the day is essentially settled there's nothing
// left to estimate.
const MIN_SAMPLES = 5;
const DONE_THRESHOLD = 0.98;

const median = (arr: number[]) => [...arr].sort((a, b) => a - b)[Math.floor(arr.length / 2)];

// Estimate today's settled end-of-day value per key from the historical intraday
// completion curve. `byDate` maps each date to its readings ordered ascending in
// time, so the last reading of each day is that day's settled total. Today's
// partial (latest reading) is divided by the median share of the day's total that
// is typically in by the same checkpoint across complete past days.
export function computeEodProjection<K extends string>(
  byDate: Map<string, EodReading<K>[]>,
  todayStr: string,
  keys: readonly K[],
): Partial<Record<K, EodEstimate>> {
  const todayReadings = byDate.get(todayStr);
  if (!todayReadings?.length) return {};
  const todayLatest = todayReadings[todayReadings.length - 1];

  // ratios: `${bucket}|${key}` → value/day-final samples across complete days.
  const ratios = new Map<string, number[]>();
  for (const [d, readings] of byDate) {
    if (d === todayStr || !readings.length) continue;
    const final = readings[readings.length - 1];
    for (const k of keys) {
      const fin = final.values[k];
      if (typeof fin !== "number" || !(fin > 0)) continue;
      for (const r of readings) {
        const v = r.values[k];
        if (typeof v !== "number") continue;
        const mapKey = `${r.bucket}|${k}`;
        let bucket = ratios.get(mapKey);
        if (!bucket) ratios.set(mapKey, (bucket = []));
        bucket.push(v / fin);
      }
    }
  }

  const out: Partial<Record<K, EodEstimate>> = {};
  for (const k of keys) {
    const partial = todayLatest.values[k];
    if (typeof partial !== "number") continue;
    const samples = ratios.get(`${todayLatest.bucket}|${k}`);
    if (!samples || samples.length < MIN_SAMPLES) continue;
    const fraction = median(samples);
    if (!(fraction > 0) || fraction >= DONE_THRESHOLD) continue;
    out[k] = { projected: Math.round(partial / fraction), fraction, asOf: todayLatest.asOf };
  }
  return out;
}
