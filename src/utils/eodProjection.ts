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

export interface EodOptions {
  // Weight each past day by 0.5^(age in days / halfLifeDays), so the profile
  // follows a drifting intraday curve instead of averaging over the whole
  // window. Unset: every day counts the same.
  halfLifeDays?: number;
}

interface Sample {
  ratio: number;
  weight: number;
}

// The first value, in ascending order, past which more than half the weight
// lies. With equal weights it is the upper median, arr[floor(n / 2)].
function weightedMedian(samples: Sample[]): number {
  const sorted = [...samples].sort((a, b) => a.ratio - b.ratio);
  const half = sorted.reduce((sum, s) => sum + s.weight, 0) / 2;
  let acc = 0;
  for (const s of sorted) {
    acc += s.weight;
    if (acc > half) return s.ratio;
  }
  return sorted[sorted.length - 1].ratio;
}

const daysBetween = (from: string, to: string) =>
  (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;

// Every estimate today's readings support, one per reading, ascending in time:
// what the projection said at 09:00, at 10:00, … up to the latest reading. Each
// divides that reading's partial by the median share of the day's total that is
// typically in by the same checkpoint across complete past days (weighted
// towards recent days with `halfLifeDays`). `byDate` maps
// each date to its readings ordered ascending in time, so the last reading of
// each day is that day's settled total.
//
// A reading is left out when its checkpoint has too few samples or the day is
// essentially settled by then, so the series can have holes and can end before
// the latest reading — which is why the latest estimate is its own function.
export function computeEodSteps<K extends string>(
  byDate: Map<string, EodReading<K>[]>,
  todayStr: string,
  keys: readonly K[],
  { halfLifeDays }: EodOptions = {},
): Partial<Record<K, EodEstimate[]>> {
  const todayReadings = byDate.get(todayStr);
  if (!todayReadings?.length) return {};

  // ratios: `${bucket}|${key}` → value/day-final samples across complete days.
  const ratios = new Map<string, Sample[]>();
  for (const [d, readings] of byDate) {
    if (d === todayStr || !readings.length) continue;
    const weight = halfLifeDays ? 0.5 ** (daysBetween(d, todayStr) / halfLifeDays) : 1;
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
        bucket.push({ ratio: v / fin, weight });
      }
    }
  }

  const out: Partial<Record<K, EodEstimate[]>> = {};
  for (const k of keys) {
    const steps: EodEstimate[] = [];
    for (const r of todayReadings) {
      const partial = r.values[k];
      if (typeof partial !== "number") continue;
      const samples = ratios.get(`${r.bucket}|${k}`);
      if (!samples || samples.length < MIN_SAMPLES) continue;
      const fraction = weightedMedian(samples);
      if (!(fraction > 0) || fraction >= DONE_THRESHOLD) continue;
      steps.push({ projected: Math.round(partial / fraction), fraction, asOf: r.asOf, bucket: r.bucket });
    }
    if (steps.length) out[k] = steps;
  }
  return out;
}

// Today's estimate as of its latest reading — the last step, but only when that
// step IS the latest reading: an older one would present a stale figure as
// current, and a day already settled at its latest reading has nothing left to
// estimate.
export function computeEodProjection<K extends string>(
  byDate: Map<string, EodReading<K>[]>,
  todayStr: string,
  keys: readonly K[],
  opts: EodOptions = {},
): Partial<Record<K, EodEstimate>> {
  const todayReadings = byDate.get(todayStr);
  if (!todayReadings?.length) return {};
  return latestEod(computeEodSteps(byDate, todayStr, keys, opts), todayReadings[todayReadings.length - 1].bucket);
}

function latestEod<K extends string>(
  steps: Partial<Record<K, EodEstimate[]>>,
  latestBucket: string,
): Partial<Record<K, EodEstimate>> {
  const out: Partial<Record<K, EodEstimate>> = {};
  for (const [k, s] of Object.entries(steps) as [K, EodEstimate[]][]) {
    const last = s[s.length - 1];
    if (last.bucket === latestBucket) out[k] = last;
  }
  return out;
}
