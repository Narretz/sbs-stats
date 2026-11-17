import { describe, expect, it } from "vitest";
import { mergeMentions, monthRegionList, regionName, regionList } from "@/utils/ruModRegions";

describe("RU MoD regions", () => {
  it("names a region in English, or as stored when it isn't listed", () => {
    expect(regionName("Белгородской области")).toBe("Belgorod");
    expect(regionName("Республики Крым")).toBe("Crimea");
    expect(regionName("Новой области")).toBe("Новой области");
  });

  it("lists counted regions by count, then the rest by name", () => {
    expect(regionList([
      { region: "Брянской области", drones: 1 },
      { region: "Белгородской области", drones: 73 },
      { region: "Курской области", drones: 14 },
    ])).toEqual({
      heading: "3 Regions",
      items: [{ name: "Belgorod", value: "73" }, { name: "Kursk", value: "14" }, { name: "Bryansk", value: "1" }],
    });
  });

  it("adds up a region two reports counted, and makes it a floor when another only named it", () => {
    const mentions = [
      { region: "Курской области", drones: 5 },
      { region: "Брянской области", drones: 2 },
      { region: "Курской области", drones: 3 },
      { region: "Брянской области", drones: null },
      { region: "Черного моря", drones: null },
    ];
    expect(mergeMentions(mentions)).toEqual([
      { region: "Курской области", drones: 8, lowerBound: false },
      { region: "Брянской области", drones: 2, lowerBound: true },
      { region: "Черного моря", drones: null, lowerBound: false },
    ]);
    expect(regionList(mentions)?.items).toEqual([
      { name: "Kursk", value: "8" }, { name: "Bryansk", value: "≥ 2" }, { name: "Black Sea", value: null },
    ]);
  });

  it("is null for a day that named none", () => {
    expect(regionList([])).toBeNull();
  });

  it("lists a month's regions by the days they were named, then by count", () => {
    expect(monthRegionList([
      { region: "Черного моря", drones: null, uncounted: 9, days: 9 },
      { region: "Курской области", drones: 120, uncounted: 0, days: 20 },
      { region: "Брянской области", drones: 300, uncounted: 4, days: 25 },
      { region: "Белгородской области", drones: null, uncounted: 28, days: 28 },
    ])).toEqual({
      heading: "4 Regions",
      items: [
        { name: "Belgorod", value: null, days: "28d" },
        { name: "Bryansk", value: "≥ 300", days: "25d" },
        { name: "Kursk", value: "120", days: "20d" },
        { name: "Black Sea", value: null, days: "9d" },
      ],
    });
    expect(monthRegionList([])).toBeNull();
  });
});
