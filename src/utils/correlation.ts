// How closely SBS's figures move with the rest of the General Staff's, for the
// homepage's combined charts — the number behind "when one goes up, does the
// other follow?".
//
// SBS passes its own (strictly verified) figures on to the General Staff, so
// GSUA's national total is SBS + everyone else: about 30% of personnel and
// 28% of vehicles are SBS's. Correlating SBS with the whole total therefore
// partly correlates it with itself — with no link at all between the two
// fronts it would still come out ≈0.4. Subtracting SBS leaves the rest of the
// AFU, whose baseline is 0. That only holds where SBS's figure is known to be
// a part of GSUA's, so the pairs are listed here rather than matched by name:
// SBS "killed" is not GSUA's "personnel" (killed + wounded), SBS vehicles
// "destroyed" is 6% of GSUA's against "hit" at 28%, and armour doesn't pass
// the subtraction at all (r < 0 against the rest).
//
// Only weekly charts get one: r of the week-over-week changes of full
// Monday–Sunday weeks. Levels would mostly measure the trend both share. A
// month is too coarse (a year is twelve points), and a daily r needs
// detrending to say anything, which made it a number nobody could read.
//
// SBS reports a day it has no figure for as 0 (a scrape gap, not a quiet day
// — the source never has a real zero for these), so a 0 is a gap here, and a
// week containing one is not a full week.

import type { DailyDataPoint } from "@/types";

export interface CorrelationPair {
  /** Metric id of SBS's figure — a part of `whole`. */
  part: string;
  /** Metric id of the General Staff's national figure. */
  whole: string;
  label: string;
}

export const CORRELATION_PAIRS: CorrelationPair[] = [
  { part: "sbs.total_personnel_casualties", whole: "ru-losses.personnel", label: "Personnel" },
  { part: "sbs.hit_7", whole: "ru-losses.vehicles", label: "Vehicles" },
];

export interface Correlation {
  pair: CorrelationPair;
  /** Pearson r, or null when there are fewer than `need` points. */
  r: number | null;
  /** Week-to-week changes the r is computed from. */
  n: number;
  need: number;
}

export const MIN_CHANGES = 10;

/** The listed pairs both of whose metrics are on a chart, in list order. */
export function pairsOnChart(metricIds: readonly string[]): CorrelationPair[] {
  const ids = new Set(metricIds);
  return CORRELATION_PAIRS.filter((p) => ids.has(p.part) && ids.has(p.whole));
}

export function pearson(x: readonly number[], y: readonly number[]): number | null {
  const n = x.length;
  if (n < 2 || y.length !== n) return null;
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
    syy += (y[i] - my) ** 2;
  }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}

const dayNumber = (date: string) => Date.parse(`${date}T00:00:00Z`) / 86_400_000;

/** SBS and the rest of GSUA on each day both have a usable figure, keyed by
 *  day number. Today is a running total, not a day, so it never counts. */
function usableDays(part: DailyDataPoint[], whole: DailyDataPoint[]): Map<number, { sbs: number; rest: number }> {
  const wholeBy = new Map(whole.map((p) => [p.date, p]));
  const out = new Map<number, { sbs: number; rest: number }>();
  for (const p of part) {
    const w = wholeBy.get(p.date);
    if (p.is_today || w?.is_today) continue;
    if (typeof p.value !== "number" || p.value === 0 || typeof w?.value !== "number") continue;
    out.set(dayNumber(p.date), { sbs: p.value, rest: w.value - p.value });
  }
  return out;
}

function weeklyPoints(days: Map<number, { sbs: number; rest: number }>) {
  // Day 0 (1970-01-01) was a Thursday, so +3 puts Monday at 0 mod 7.
  const weeks = new Map<number, { sbs: number; rest: number; k: number }>();
  for (const [d, v] of days) {
    const w = Math.floor((d + 3) / 7);
    const acc = weeks.get(w) ?? { sbs: 0, rest: 0, k: 0 };
    acc.sbs += v.sbs; acc.rest += v.rest; acc.k++;
    weeks.set(w, acc);
  }
  const x: number[] = [], y: number[] = [];
  for (const [w, cur] of weeks) {
    const prev = weeks.get(w - 1);
    if (cur.k < 7 || !prev || prev.k < 7) continue;
    x.push(cur.sbs - prev.sbs);
    y.push(cur.rest - prev.rest);
  }
  return { x, y };
}

/** r between SBS and the rest of GSUA, from the two DAILY series over the
 *  chart's window: a summed week can no longer show which of its days were
 *  gaps. */
export function pairCorrelation(pair: CorrelationPair, part: DailyDataPoint[], whole: DailyDataPoint[]): Correlation {
  const { x, y } = weeklyPoints(usableDays(part, whole));
  const need = MIN_CHANGES;
  return { pair, n: x.length, need, r: x.length >= need ? pearson(x, y) : null };
}

/** The chart's one-line note for a pair. */
export function correlationText(c: Correlation): string {
  const head = `SBS vs rest of GSUA · ${c.pair.label}`;
  if (c.n < c.need) return `${head}: too little data for r (n ${c.n}, needs ${c.need})`;
  if (c.r == null) return `${head}: no r — one of them doesn't vary (n ${c.n})`;
  return `${head}: r ${c.r.toFixed(2).replace("-", "−")} · weekly changes · n ${c.n}`;
}

export const CORRELATION_HELP =
  "Pearson r between SBS's figure and the General Staff's total minus SBS's. " +
  "Against the whole total, r would be inflated by SBS correlating with itself. " +
  "Computed from week-over-week changes of full weeks, so a trend both share doesn't count. " +
  "Days SBS reports as 0 are gaps. Computed over the chart's window.";
