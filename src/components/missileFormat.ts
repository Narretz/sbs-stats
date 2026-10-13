import type { MissilePoint } from "@/data/missiles";
import { formatDay, formatMonth } from "@/utils/dateFormat";

// as_of read at its stated precision — a mid-month estimate shouldn't masquerade
// as a specific day. "2026-10-14", "mid 2026-10", "2026-10".
export function fmtAsOfDate(asOf: string, precision: MissilePoint["as_of_precision"]): string {
  if (precision === "day") return formatDay(asOf);
  if (precision === "mid_month") return `mid ${formatMonth(asOf)}`;
  return formatMonth(asOf);
}

export const fmtAsOf = (p: MissilePoint): string => fmtAsOfDate(p.as_of, p.as_of_precision);

// The bound qualifier, made legible. A bar/point alone can't say "≤"; this can.
export function fmtValue(p: MissilePoint): string {
  switch (p.bound) {
    case "range":    return `${p.low}–${p.high}`;
    case "up_to":    return `≤ ${p.high}`;
    case "at_least": return `≥ ${p.low}`;
    case "approx":   return `~ ${p.mid}`;
    case "planned":  return `${p.mid} (planned)`;
    case "derived":  return `≈ ${p.mid} (derived)`;
    case "suspended": return `0 (suspended)`;
    default:         return `${p.mid}`;
  }
}
