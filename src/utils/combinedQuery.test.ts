import { describe, expect, it } from "vitest";
import type { RuAirAttacksDailyRow, ZelenskyWeekRow } from "@/types";
import { findMetric, type CombinedMetric } from "@/utils/combinedMetrics";
import { fetchCombinedWeekly } from "@/utils/combinedQuery";

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
