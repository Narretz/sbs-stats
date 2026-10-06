import { describe, expect, it } from "vitest";
import { axesOf, axisSeries, directionOptions, parseDirectionsParam } from "@/utils/gsuaDirections";
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
