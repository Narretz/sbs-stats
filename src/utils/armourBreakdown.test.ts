import { describe, expect, it } from "vitest";
import { armourBreakdown } from "@/utils/armourBreakdown";

describe("armourBreakdown", () => {
  it("lists the itemised subgroups and what the itemisation left out", () => {
    expect(armourBreakdown(15, { armour_tanks: 1, armour_acv: 10, armour_ifv: 0 })).toEqual([
      { model: "Tanks", launched: 1 },
      { model: "ACVs (MRAPs, armoured cars)", launched: 10 },
      { model: "Not itemised", launched: 4 },
    ]);
  });

  it("shows an overshoot as a negative remainder rather than hiding it", () => {
    // 07/03/2025: the MoD's total rose by 78, the items add up to 80.
    const entries = armourBreakdown(78, { armour_tanks: 5, armour_ifv: 6, armour_apc: 9, armour_acv: 60 });
    expect(entries.at(-1)).toEqual({ model: "Not itemised", launched: -2 });
  });

  it("drops the remainder row when the items account for the total exactly", () => {
    expect(armourBreakdown(3, { armour_tanks: 3 })).toEqual([{ model: "Tanks", launched: 3 }]);
  });

  it("offers no breakdown for a day with nothing itemised", () => {
    // 2022 is mostly like this — a lone "Not itemised: 100%" row says nothing.
    expect(armourBreakdown(40, {})).toEqual([]);
    expect(armourBreakdown(null, { armour_tanks: 1 })).toEqual([]);
  });
});
