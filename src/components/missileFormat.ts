import type { MissilePoint } from "@/data/missiles";

const MONTHS = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// as_of read at its stated precision — a mid-month estimate shouldn't masquerade
// as a specific day.
export function fmtAsOf(p: MissilePoint): string {
  const [y, m, d] = p.as_of.split("-");
  if (p.as_of_precision === "day") return `${d}.${m}.${y}`;
  if (p.as_of_precision === "mid_month") return `mid-${MONTHS[+m]} ${y}`;
  return `${MONTHS[+m]} ${y}`;
}

// The bound qualifier, made legible. A bar/point alone can't say "≤"; this can.
export function fmtValue(p: MissilePoint): string {
  switch (p.bound) {
    case "range":    return `${p.low}–${p.high}`;
    case "up_to":    return `≤ ${p.high}`;
    case "at_least": return `≥ ${p.low}`;
    case "approx":   return `~ ${p.mid}`;
    case "planned":  return `${p.mid} (planned)`;
    default:         return `${p.mid}`;
  }
}
