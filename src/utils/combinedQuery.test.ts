import { describe, expect, it } from "vitest";
import type { GsuaMonthlyRow, RuAirAttacksDailyRow, ZelenskyWeekRow } from "@/types";
import { findMetric, type CombinedMetric } from "@/utils/combinedMetrics";
import { fetchCombinedMonthly, fetchCombinedWeekly } from "@/utils/combinedQuery";

const metric = (id: string) => findMetric(id) as CombinedMetric;

// Two finished weeks (7–13 and 14–20 Sep 2026) and the Monday of a third.
const END = "2026-09-21";

// RU air attacks, 10 drones a day — except 15 Sep, withheld (null), and
// nothing at all on the 21st, the day the window ends.
function ruAir(days: number, endDate?: string): RuAirAttacksDailyRow[] {
  expect(endDate).toBe(END);
  const rows: RuAirAttacksDailyRow[] = [];
  for (let d = 7; d <= 20; d++) {
    rows.push({ date: `2026-09-${String(d).padStart(2, "0")}`, is_today: false, drone_launched: d === 15 ? null : 10 } as unknown as RuAirAttacksDailyRow);
  }
  // Asked for the window's whole weeks through the end date: 7 Sep → 21 Sep.
  expect(days).toBe(15);
  return rows;
}

const tally = (period_start: string, drones: number | null): ZelenskyWeekRow => ({
  period: "x", period_start, period_end: "x", post_id: 1, posted_at: "x", url: "x",
  drones, drones_bound: "at_least", bombs: null, bombs_bound: null, missiles: null, missiles_bound: null,
});

describe("fetchCombinedWeekly", () => {
  it("puts a summed daily source and the weekly tally on the same Mondays", async () => {
    const out = await fetchCombinedWeekly(
      [metric("ru-air-attacks.drone_launched"), metric("zelensky.drones")],
      3, END,
      { ruAir, zelensky: () => [tally("2026-09-07", 75)] },
    );

    const air = out["ru-air-attacks.drone_launched"];
    expect(air.map((p) => [p.date, p.value, p.is_today])).toEqual([
      ["2026-09-07", 70, false],
      ["2026-09-14", 60, false],   // six days — the withheld 15th isn't a zero
      ["2026-09-21", null, true],  // in progress, nothing yet
    ]);
    expect(air[1].note).toMatch(/Sum of 6 of 7 days/);

    expect(out["zelensky.drones"].map((p) => [p.date, p.value])).toEqual([
      ["2026-09-07", 75],
      ["2026-09-14", null],  // no tally that week: a gap, not 0
      ["2026-09-21", null],
    ]);
  });
});

describe("fetchCombinedMonthly", () => {
  it("leaves a month with no day of the metric a gap, and notes one summed from some", async () => {
    // As the GSUA hook hands them over: May 2023 drones on one day, June on
    // none (attachDayCounts has nulled it), the current month in progress.
    const row = (date: string, kamikaze_drones: number | null, days: number, current = false) =>
      ({ date, is_current_month: current, kamikaze_drones, kamikaze_drones_days: days }) as unknown as GsuaMonthlyRow;
    const out = await fetchCombinedMonthly([metric("gsua.kamikaze_drones")], "all", "2023-07-10", {
      gsua: async () => [row("2023-05", 54, 1), row("2023-06", null, 0), row("2023-07", 40, 9, true)],
    });
    const drones = out["gsua.kamikaze_drones"];
    expect(drones.map((p) => [p.date, p.value])).toEqual([["2023-05", 54], ["2023-06", null], ["2023-07", 40]]);
    expect(drones[0].note).toMatch(/Sum of 1 of 31 days .* may be undercounted/);
    expect(drones[1].note).toBeUndefined();
    // The month in progress is marked partial already.
    expect(drones[2].note).toBeUndefined();
  });
});

describe("fetchCombinedMonthly — the President's weekly tally", () => {
  const week = (period_start: string, drones: number | null): ZelenskyWeekRow => ({ ...tally(period_start, drones) });

  it("builds months from the weeks' daily averages and notes a finished month left short", async () => {
    // Every week of Dec 2025 – Jan 2026 at 70 (10 a day), except the week of
    // 12 Jan, with no tally; then 26 Jan – 1 Feb splits 6 days / 1 day.
    const weeks = ["2025-12-01", "2025-12-08", "2025-12-15", "2025-12-22", "2025-12-29",
      "2026-01-05", "2026-01-19", "2026-01-26"].map((m) => week(m, 70));
    const out = await fetchCombinedMonthly([metric("zelensky.drones")], "all", "2026-02-10", { zelensky: () => weeks });
    const s = out["zelensky.drones"];
    expect(s.map((p) => [p.date, p.value])).toEqual([
      ["2025-12", 310],  // all 31 days
      ["2026-01", 240],  // 24 of 31 days: 29 Dec – 4 Jan's four, 5–11, 19–25, 26–31
      ["2026-02", 10],   // 1 Feb, from the week spanning the turn of the month
    ]);
    expect(s[0].note).toBeUndefined();
    expect(s[1].note).toMatch(/Weekly tallies cover 24 of 31 days — the other 7 have none/);
  });

  it("starts at the later of the window's start and the first tally", async () => {
    const out = await fetchCombinedMonthly([metric("zelensky.drones")], 3, "2026-03-15", {
      zelensky: () => [week("2025-12-01", 70), week("2026-02-02", 70)],
    });
    expect(out["zelensky.drones"].map((p) => p.date)).toEqual(["2026-01", "2026-02", "2026-03"]);
    const late = await fetchCombinedMonthly([metric("zelensky.drones")], "all", "2026-03-15", {
      zelensky: () => [week("2026-02-02", 70)],
    });
    expect(late["zelensky.drones"].map((p) => p.date)).toEqual(["2026-02", "2026-03"]);
  });
});
