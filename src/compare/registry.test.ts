import { describe, expect, it } from "vitest";
import {
  CANONICAL_ROWS,
  fmtPct,
  fmtValue,
  keysFor,
  mapsIn,
  pctChange,
  sumCompareValues,
  sumNatives,
  unitSizeAt,
  visibleRowsFor,
  type CompareValue,
  type EntitySnapshot,
} from "@/compare/registry";

const exact = (value: number): CompareValue => ({ value, bound: "exact", derived: false });

// A snapshot over a plain lookup — the table only ever asks (month, key), so
// this is the whole interface the value helpers see.
function snap(values: Record<string, number>): EntitySnapshot {
  return {
    id: "sbs",
    months: ["2026-08"],
    get: (_month, key) => (key in values ? exact(values[key]) : null),
  };
}

describe("sumCompareValues", () => {
  it("is null for nothing, and the part itself for one", () => {
    expect(sumCompareValues([])).toBeNull();
    // A single part keeps its note: there is no ambiguity about what it
    // describes yet.
    expect(sumCompareValues([{ ...exact(5), note: "понад" }]))
      .toEqual({ value: 5, bound: "exact", derived: false, note: "понад" });
  });

  it("is only as precise as its least precise part", () => {
    // The rule the whole table's honesty rests on: adding a floor to an exact
    // figure gives a floor, not an exact total.
    expect(sumCompareValues([exact(10), { ...exact(5), bound: "at_least" }]))
      .toMatchObject({ value: 15, bound: "at_least" });
    expect(sumCompareValues([{ ...exact(1), bound: "approx" }, { ...exact(2), bound: "range" }]))
      .toMatchObject({ bound: "range" });
    expect(sumCompareValues([exact(1), exact(2)])).toMatchObject({ bound: "exact" });
  });

  it("carries derived if any part was derived", () => {
    expect(sumCompareValues([exact(1), { ...exact(2), derived: true }]))
      .toMatchObject({ value: 3, derived: true });
  });

  it("drops the note once there is more than one part", () => {
    // The note describes one source's phrasing; over a sum it would be
    // attached to a number it no longer explains.
    expect(sumCompareValues([{ ...exact(1), note: "a" }, { ...exact(2), note: "b" }])!.note)
      .toBeUndefined();
  });
});

describe("sumNatives", () => {
  it("is null when the entity carries none of the keys", () => {
    expect(sumNatives(snap({}), "2026-08", ["tanks"])).toBeNull();
    expect(sumNatives(snap({ tanks: 3 }), "2026-08", [])).toBeNull();
    expect(sumNatives(snap({ tanks: 3 }), "2026-08", undefined)).toBeNull();
  });

  it("keeps a present-but-zero counter as a zero", () => {
    // "Reported none" and "does not report this" are different answers, and
    // the table renders them differently (0 vs —).
    expect(sumNatives(snap({ tanks: 0 }), "2026-08", ["tanks"])).toMatchObject({ value: 0 });
  });

  it("sums only the keys the entity has", () => {
    expect(sumNatives(snap({ tanks: 3, apcs_ifvs: 4 }), "2026-08", ["tanks", "apcs_ifvs", "mlrs"]))
      .toMatchObject({ value: 7 });
  });
});

describe("keysFor", () => {
  // The scoped mapping in the wild: «Альфа»'s `radar` counter belongs to the
  // Radars child only through 2026-05; after that the same key means something
  // wider and the parent holds it.
  const radars = CANONICAL_ROWS
    .flatMap((r) => r.children ?? [])
    .find((c) => c.key === "radars")!;

  it("includes a scoped key inside its window and not outside", () => {
    expect(keysFor(radars, "sbu-alfa", "2026-05")).toEqual(["radar"]);
    expect(keysFor(radars, "sbu-alfa", "2026-06")).toEqual([]);
  });

  it("is empty for an entity the row does not map", () => {
    expect(keysFor(radars, "rubikon", "2026-05")).toEqual([]);
  });

  it("unions overlapping ranges rather than concatenating them", () => {
    // Concatenating would list a key twice and the caller SUMS the list, so an
    // open-ended range overlapping a plain entry would double that counter.
    const row = {
      key: "k", label: "K",
      map: { sbs: ["radar_trench", { to: "2026-06", values: ["radar_trench", "radar_vehicles"] }] },
    } as Parameters<typeof keysFor>[0];
    expect(keysFor(row, "sbs", "2026-05").sort()).toEqual(["radar_trench", "radar_vehicles"]);
  });

  it("mapsIn follows it", () => {
    expect(mapsIn(radars, "sbu-alfa", "2026-05")).toBe(true);
    expect(mapsIn(radars, "sbu-alfa", "2026-06")).toBe(false);
  });
});

describe("visibleRowsFor", () => {
  const rows = (cols: { entity: "sbs" | "sbu-alfa" | "rubikon"; month: string }[]) =>
    visibleRowsFor(cols).map((r) => r.id);

  it("drops rows no selected column can fill", () => {
    // Aircraft is SBS's and «Альфа»'s; «Рубикон» has no counter for it, so a
    // Rubikon-only table would otherwise carry a line of permanent dashes.
    const onlyRubikon = rows([{ entity: "rubikon", month: "2026-08" }]);
    expect(onlyRubikon).not.toContain("aircraft");
    expect(rows([{ entity: "sbs", month: "2026-08" }])).toContain("aircraft");
  });

  it("keeps a parent whose children still have data", () => {
    // Dropping it would take the children with it — they are rendered as its
    // subtree, not independently.
    const ids = rows([{ entity: "sbs", month: "2026-08" }]);
    for (const id of ids.filter((i) => i.includes("/"))) {
      expect(ids).toContain(id.split("/")[0]);
    }
  });

  it("flattens children directly beneath their parent", () => {
    const ids = rows([{ entity: "sbs", month: "2026-08" }]);
    const parent = ids.findIndex((i) => i === "radar");
    expect(ids[parent + 1]).toBe("radar/radars");
  });

  it("is month-aware, not just entity-aware", () => {
    // Same column entity, different month: the scoped Radars child applies to
    // one and not the other.
    const may = rows([{ entity: "sbu-alfa", month: "2026-05" }]);
    const june = rows([{ entity: "sbu-alfa", month: "2026-06" }]);
    expect(may).toContain("radar/radars");
    expect(june).not.toContain("radar/radars");
  });
});

describe("unitSizeAt", () => {
  it("resolves the newest estimate at or before the column's month", () => {
    const now = unitSizeAt({ entity: "rubikon" }, "2026-08");
    const then = unitSizeAt({ entity: "rubikon" }, "2025-06");
    expect(now).not.toBeNull();
    expect(then).not.toBeNull();
    // «Рубикон» grew across the war; a 2025 column must not show its 2026 size.
    expect(now!.value.value).toBeGreaterThan(then!.value.value);
  });

  it("marks a figure that predates the column", () => {
    expect(unitSizeAt({ entity: "rubikon" }, "2026-08")!.scope).toContain("as of");
  });

  it("is null before the first estimate", () => {
    // Better an empty cell than a headcount from after the month it sits in.
    expect(unitSizeAt({ entity: "rubikon" }, "2020-01")).toBeNull();
  });

  it("is null for a sub-unit", () => {
    // The grouping's figure describes the whole branch. Inheriting it would
    // invite a per-capita reading against the wrong denominator.
    expect(unitSizeAt({ entity: "sbs", unit: "alpha-unit" }, "2026-08")).toBeNull();
    expect(unitSizeAt({ entity: "sbs" }, "2026-08")).not.toBeNull();
  });
});

describe("value formatting", () => {
  it("carries the bound into the text", () => {
    expect(fmtValue(exact(1234))).toBe("1,234");
    expect(fmtValue({ ...exact(1234), bound: "at_least" })).toBe("≥ 1,234");
    expect(fmtValue({ ...exact(1234), bound: "approx" })).toBe("~1,234");
    expect(fmtValue({ ...exact(1234), bound: "up_to" })).toBe("≤ 1,234");
  });

  it("has no percentage against a zero or absent baseline", () => {
    // Not 0 and not infinity: undefined, so the cell shows the bare value.
    expect(pctChange(exact(0), exact(5))).toBeNull();
    expect(pctChange(null, exact(5))).toBeNull();
    expect(pctChange(exact(5), null)).toBeNull();
  });

  it("signs the percentage, including no change", () => {
    expect(fmtPct(pctChange(exact(100), exact(150))!)).toBe("+50.0%");
    expect(fmtPct(pctChange(exact(100), exact(50))!)).toBe("−50.0%");
    expect(fmtPct(pctChange(exact(100), exact(100))!)).toBe("±0.0%");
  });
});
