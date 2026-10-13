// How a date reads wherever it labels a data point — a tooltip's header, a
// pinned sheet's stepper: ISO 8601, at every grain. Axis ticks are terser on
// purpose and keep their own formats.
//
// The data is already ISO ("YYYY-MM-DD"), so a day is itself and a month is
// its first seven characters; what this module adds is the interval.

// "2026-01-09".
export const formatDay = (date: string): string => date.slice(0, 10);

// "2026-10", from a month or any day in it.
export const formatMonth = (date: string): string => date.slice(0, 7);

// An ISO 8601 interval, its end leaving off what it shares with the start:
// "2026-01-10/11", "2026-01-31/02-01", "2025-12-31/2026-01-01" — so it reads
// the same way across a month or a year. One day is formatDay.
export function formatSpan(first: string, last: string): string {
  if (first === last) return formatDay(last);
  const [y1, m1] = first.split("-");
  const [y2, m2, d2] = last.split("-");
  if (y1 !== y2) return `${first}/${last}`;
  if (m1 !== m2) return `${first}/${m2}-${d2}`;
  return `${first}/${d2}`;
}
