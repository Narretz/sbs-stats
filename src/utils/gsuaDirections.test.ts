import { describe, expect, it } from "vitest";
import { axesOf, axisSeries, directionOptions, parseDirectionsParam, projectCoverageMonth } from "@/utils/gsuaDirections";
import type { GsuaDirectionCoverageRow } from "@/types";

const row = (date: string, total: number | null, byDirection: Record<string, number>): GsuaDirectionCoverageRow =>
  ({ date, total, attributed: 0, unattributed: 0, byDirection, is_today: false });

describe("the direction picker's axes", () => {
  it("folds a merged direction into its axis, keeping the ranking", () => {
    expect(axesOf(["Pokrovsk", "Kursk", "N-Slobozhanshchyna", "Lyman"])).toEqual(["Pokrovsk", "Kursk", "Lyman"]);
  });

  it("opens an old link naming a folded direction on its axis, once", () => {
    expect(parseDirectionsParam("N-Slobozhanshchyna,Kursk,Lyman")).toEqual(["Kursk", "Lyman"]);
    expect(parseDirectionsParam(null)).toEqual([]);
  });

  it("offers each axis once, alphabetically, under its joint label", () => {
    const opts = directionOptions(["Pokrovsk", "N-Slobozhanshchyna", "Kursk"]);
    expect(opts.map((o) => [o.value, o.label])).toEqual([
      ["Kursk", "Kursk / Pn. Slobozhanshchyna"],
      ["Pokrovsk", "Pokrovsk"],
    ]);
  });
});

describe("axisSeries", () => {
  it("reads the stack's own figure, 0 where the report didn't name it, a gap where there was none", () => {
    const rows = [
      row("2026-09-01", 100, { Pokrovsk: 40.5 }),
      row("2026-09-02", 80, { Lyman: 10 }),
      row("2026-09-03", null, {}),
    ];
    expect(axisSeries(rows, "Pokrovsk").map((p) => p.value)).toEqual([40.5, 0, null]);
  });
});

describe("projectCoverageMonth", () => {
  const day = (date: string, total: number | null, byDirection: Record<string, number>): GsuaDirectionCoverageRow => {
    const attributed = Object.values(byDirection).reduce((a, b) => a + b, 0);
    return { date, total, attributed, unattributed: total == null ? 0 : Math.max(0, total - attributed), byDirection, is_today: false };
  };

  it("extrapolates each stack from the complete days, setting today's partial aside", () => {
    const p = projectCoverageMonth("2026-09", "2026-09-03", [
      day("2026-09-01", 100, { Pokrovsk: 40, Lyman: 10 }),
      day("2026-09-02", 120, { Pokrovsk: 50, Lyman: 20 }),
      day("2026-09-03", 30, { Pokrovsk: 30 }), // today, still filling in
    ])!;
    expect(p).toMatchObject({ completedDays: 2, daysInMonth: 30, partialDay: true });
    expect(p.total).toBe(3300);        // 220 / 2 × 30
    expect(p.unattributed).toBe(1500); // 100 / 2 × 30
    expect(p.byDirection).toEqual({ Pokrovsk: 1350, Lyman: 450 });
  });

  it("never projects a stack below what the month already holds", () => {
    const p = projectCoverageMonth("2026-09", "2026-09-02", [
      day("2026-09-01", 10, { Pokrovsk: 10 }),
      day("2026-09-02", 100, { Kupiansk: 100 }), // named only today
    ])!;
    expect(p.byDirection.Kupiansk).toBe(100);
  });

  it("is null before the month has a complete day", () => {
    expect(projectCoverageMonth("2026-09", "2026-09-01", [day("2026-09-01", 50, {})])).toBeNull();
  });
});
