// Week-window helpers for the homepage's combined charts in "weekly" grain, and
// the daily → weekly roll-up that grain is built on. Sibling of dayRange.ts /
// monthRange.ts.
//
// A week is Monday–Sunday and is keyed by its Monday (YYYY-MM-DD). Every source
// already reconciles its days to local time (Kyiv, or MSK for RU MoD), so a
// week is simply seven of those days — nothing here touches a timezone.
//
// Why weekly at all: it is the one grain every source can meet on. The
// President's strike tally exists ONLY per week, and summing the daily sources
// into the same Monday–Sunday buckets is what lets the two be compared on one
// chart.
import { Temporal } from "temporal-polyfill";
import type { DailyDataPoint } from "@/types";
import { WINDOW_FLOOR } from "@/utils/dayRange";

export const WEEK_OPTIONS = [4, 8, 13, 26, 52, 104, "all"] as const;
export type WeekOption = number | "all";
export const DEFAULT_WEEKS = 26;

const plain = (d: string) => Temporal.PlainDate.from(d);

// The Monday of the week containing `date`.
export function weekStart(date: string): string {
  const d = plain(date);
  return d.subtract({ days: d.dayOfWeek - 1 }).toString();
}

// Every Monday from `firstMonday` to `lastMonday`, inclusive.
export function mondaysBetween(firstMonday: string, lastMonday: string): string[] {
  const out: string[] = [];
  let d = plain(firstMonday);
  const stop = plain(lastMonday);
  while (Temporal.PlainDate.compare(d, stop) <= 0) {
    out.push(d.toString());
    d = d.add({ days: 7 });
  }
  return out;
}

// The window an N-week chart ending at `endDate` covers: whole weeks back from
// the one containing `endDate` (which is itself partial unless endDate is a
// Sunday), never starting before the invasion. `days` is the span to ask a
// daily query for — from the first Monday through endDate, inclusive.
export function weeklyWindow(
  endDate: string,
  weeks: WeekOption,
): { firstMonday: string; lastMonday: string; days: number } {
  const lastMonday = weekStart(endDate);
  const floor = weekStart(WINDOW_FLOOR);
  let firstMonday = weeks === "all"
    ? floor
    : plain(lastMonday).subtract({ days: 7 * (Math.max(1, weeks) - 1) }).toString();
  if (firstMonday < floor) firstMonday = floor;
  const days = plain(firstMonday).until(plain(endDate)).days + 1;
  return { firstMonday, lastMonday, days };
}

// Sum a daily series into weeks, one point per Monday in the window.
//
// A week's value is the sum of the days that carry a number; a week with none
// is null (a gap), never 0. A week summed from fewer days than it has had
// gets a note saying so — a source outage, a day with no record at all (the
// Air Force data has a handful a year), or a day the source withheld (RU air
// attacks' ballistic counts come back null, not 0) — because a partial sum
// otherwise reads as a quiet week. "May be": a day with no record can also
// be a day nothing happened, and the sources don't tell the two apart. The week containing `endDate`, unless
// endDate is its Sunday, is still in progress and is flagged `is_today`, the
// same "partial last period" marker the daily and monthly grains use.
//
// Day-level caveat notes are carried up (deduplicated), so a flag the daily
// view shows isn't lost by summing over it.
export function aggregateWeekly(
  daily: DailyDataPoint[],
  firstMonday: string,
  endDate: string,
): DailyDataPoint[] {
  const byDate = new Map(daily.map((p) => [p.date, p]));
  const end = plain(endDate);
  return mondaysBetween(firstMonday, weekStart(endDate)).map((monday) => {
    const start = plain(monday);
    const sunday = start.add({ days: 6 });
    const inProgress = Temporal.PlainDate.compare(end, sunday) < 0;
    const elapsed = inProgress ? start.until(end).days + 1 : 7;

    let sum = 0;
    let reported = 0;
    const notes = new Set<string>();
    for (let i = 0; i < elapsed; i++) {
      const p = byDate.get(start.add({ days: i }).toString());
      if (!p) continue;
      if (typeof p.value === "number") {
        sum += p.value;
        reported++;
      }
      if (p.note) notes.add(p.note);
    }

    if (reported > 0 && reported < elapsed) {
      notes.add(
        `Sum of ${reported} of ${elapsed} days${inProgress ? " so far" : ""} — ` +
        `the other ${elapsed - reported} ${elapsed - reported === 1 ? "has" : "have"} no figure, so this week may be undercounted.`,
      );
    }
    const point: DailyDataPoint = {
      date: monday,
      value: reported > 0 ? sum : null,
      is_today: inProgress,
    };
    if (notes.size) point.note = [...notes].join("\n");
    return point;
  });
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const mon = (d: Temporal.PlainDate) => MONTHS[d.month - 1];

// "2026-09-21" → "21–27 Sep 2026"; a week straddling a month or year names
// both. A fixed month table, not toLocaleString: ICU versions disagree on the
// short form ("Sep" vs "Sept").
export function formatWeekRange(monday: string): string {
  const start = plain(monday);
  const end = start.add({ days: 6 });
  if (start.year !== end.year) {
    return `${start.day} ${mon(start)} ${start.year} – ${end.day} ${mon(end)} ${end.year}`;
  }
  if (start.month !== end.month) {
    return `${start.day} ${mon(start)} – ${end.day} ${mon(end)} ${end.year}`;
  }
  return `${start.day}–${end.day} ${mon(end)} ${end.year}`;
}

// A quarter-start axis label for a week: "2025-04-07" → "Apr 2025".
export function formatWeekMonth(monday: string): string {
  const d = plain(monday);
  return `${mon(d)} ${d.year}`;
}

// The x-axis labels: the first Monday of each quarter. Weekly slots are too
// dense to label one by one (~130 across the Zelensky series), and recharts' own
// thinning still collides at this width.
export function quarterTicks(mondays: string[]): string[] {
  const seen = new Set<string>();
  return mondays.filter((m) => {
    const d = plain(m);
    const key = `${d.year}-${d.month}`;
    if ((d.month - 1) % 3 !== 0 || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
