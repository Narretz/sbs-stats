// RU MISSILES — HUR: a prototype view backed by the hand-curated
// scripts/missile_stockpile/reports.json read DIRECTLY (no SQLite/R2 round-trip).
// These are irregular Ukrainian-intelligence disclosures (~2×/yr), so there is
// nothing to filter or refresh — the data is bundled at build time.
//
// This module reshapes the report-keyed JSON into per-missile-type *series* for
// the trend grid. Two rules from the dataset's known_issues drive the shape:
//   • absent ≠ zero  — a type missing from a report is simply not a point in its
//     series (a gap on a time axis), never a 0.
//   • bound matters  — every point keeps its qualifier (up_to / at_least / …) so
//     the chart can render it honestly rather than implying a precise count.
// A measurement that lumps several types ("combined") becomes its OWN series
// (e.g. "Zircon + Oniks"), never silently split across the members.
import rawData from "../../scripts/missile_stockpile/reports.json";
import type { MissileDataset, MissileReport, MissileMeasurement } from "@/types";

const data = rawData as unknown as MissileDataset;

export const MISSILE_TYPES = data.missile_types;
export const MISSILE_REPORTS = data.reports;

// Display order = order types are declared in missile_types.
const TYPE_ORDER = Object.keys(MISSILE_TYPES);

export type MissileKind = "production_monthly" | "stockpile";

export interface MissilePoint {
  t: number; // as_of as epoch ms — x is a real time axis, so irregular cadence shows
  as_of: string;
  as_of_precision: MissileReport["as_of_precision"];
  reported_at: string;
  org: string;
  low: number;
  high: number;
  mid: number;
  range: [number, number]; // [low, high] — band; equal when not a range bound
  bound: MissileMeasurement["bound"];
  raw_label: string;
}

export interface MissileSeries {
  key: string;
  label: string;
  combined: boolean; // reported as one lumped number across >1 type
  members: string[]; // canonical type keys this series covers
  points: MissilePoint[];
}

function membersOf(m: MissileMeasurement): string[] {
  if (m.types && m.types.length) return m.types;
  if (m.type) return [m.type];
  return [];
}

function lowHigh(m: MissileMeasurement): [number, number] {
  if (m.bound === "range" && typeof m.value_max === "number") return [m.value, m.value_max];
  return [m.value, m.value];
}

function firstOrderIndex(members: string[]): number {
  return Math.min(...members.map((k) => {
    const i = TYPE_ORDER.indexOf(k);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  }));
}

/** One series per single type + one per distinct combined bucket, time-sorted. */
export function buildSeries(kind: MissileKind): MissileSeries[] {
  const map = new Map<string, MissileSeries>();
  for (const r of MISSILE_REPORTS) {
    for (const m of r[kind]) {
      const members = membersOf(m);
      if (!members.length) continue;
      const key = [...members].sort().join("+");
      if (!map.has(key)) {
        map.set(key, {
          key,
          label: members.map((k) => MISSILE_TYPES[k]?.name ?? k).join(" + "),
          combined: members.length > 1 || !!m.combined,
          members,
          points: [],
        });
      }
      const [low, high] = lowHigh(m);
      map.get(key)!.points.push({
        t: Date.parse(`${r.as_of}T00:00:00Z`),
        as_of: r.as_of,
        as_of_precision: r.as_of_precision,
        reported_at: r.reported_at,
        org: r.source.org,
        low, high, mid: (low + high) / 2, range: [low, high],
        bound: m.bound,
        raw_label: m.raw_label,
      });
    }
  }
  for (const s of map.values()) s.points.sort((a, b) => a.t - b.t);
  // Group by first declared member; the single type sorts before a combined
  // bucket that shares that first member.
  return [...map.values()].sort((a, b) => {
    const ai = firstOrderIndex(a.members);
    const bi = firstOrderIndex(b.members);
    return ai !== bi ? ai - bi : a.members.length - b.members.length;
  });
}

const ALL_TS = MISSILE_REPORTS.map((r) => Date.parse(`${r.as_of}T00:00:00Z`));
export const TIME_DOMAIN: [number, number] = [Math.min(...ALL_TS), Math.max(...ALL_TS)];

// Shared x ticks: Jan/Jul of each spanned year, so every panel reads on the same
// calendar regardless of which reports it happens to contain.
export const TIME_TICKS: number[] = (() => {
  const ticks: number[] = [];
  const start = new Date(TIME_DOMAIN[0]);
  for (let y = start.getUTCFullYear(); ; y++) {
    for (const mo of [0, 6]) {
      const t = Date.UTC(y, mo, 1);
      if (t >= TIME_DOMAIN[0] - 86_400_000 && t <= TIME_DOMAIN[1] + 86_400_000) ticks.push(t);
    }
    if (Date.UTC(y, 6, 1) > TIME_DOMAIN[1]) break;
  }
  return ticks;
})();

export const DATA_WINDOW = {
  min: MISSILE_REPORTS.reduce((a, r) => (r.as_of < a ? r.as_of : a), MISSILE_REPORTS[0].as_of),
  max: MISSILE_REPORTS.reduce((a, r) => (r.as_of > a ? r.as_of : a), MISSILE_REPORTS[0].as_of),
  reports: MISSILE_REPORTS.length,
};
