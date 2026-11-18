import { describe, expect, it } from "vitest";
import { buildMetrics, SECOND_HALVES, targetPairLabel, unpairedLabel, withSecondHalves } from "@/utils/metrics";
import { chartAnchor } from "@/utils/chartAnchor";
import { TARGET_IDS } from "@/types";

// The SBS pages render one chart per metric, so two entries that can't be told
// apart become a React duplicate-key warning and, worse, two charts sharing one
// identity across updates. That is easy to reintroduce because the obvious
// identity — the data column — genuinely isn't unique: the paired view draws
// total_personnel_casualties twice, once alone and once against
// personnel_killed. These cases pin the things that DO have to be unique.

const dupes = (xs: string[]) => xs.filter((x, i) => xs.indexOf(x) !== i);

describe("buildMetrics", () => {
  for (const paired of [false, true]) {
    describe(paired ? "paired" : "unpaired", () => {
      const metrics = buildMetrics({ paired });

      it("gives every chart a unique id", () => {
        expect(dupes(metrics.map((m) => m.id))).toEqual([]);
      });

      it("gives every chart a unique title", () => {
        // Titles are slugified into the card's anchor (chartAnchor), which is
        // both the deep link and the chart-pin id — so a repeat there would
        // silently point two cards at one anchor.
        expect(dupes(metrics.map((m) => m.label))).toEqual([]);
      });

      it("keeps the id readable and tied to what the chart draws", () => {
        for (const m of metrics) {
          expect(m.id, `for ${m.label}`).toBe(m.pairedKey ? `${m.key}~${m.pairedKey}` : m.key);
        }
      });
    });
  }

  it("draws personnel casualties twice in the paired view, under one column", () => {
    // The case that produced the duplicate key. Both charts are wanted; only
    // their identity was wrong.
    const both = buildMetrics({ paired: true }).filter((m) => m.key === "total_personnel_casualties");
    expect(both).toHaveLength(2);
    expect(both.map((m) => m.id)).toEqual([
      "total_personnel_casualties",
      "total_personnel_casualties~personnel_killed",
    ]);
  });

  it("does not repeat a column in the unpaired view", () => {
    expect(dupes(buildMetrics().map((m) => m.key))).toEqual([]);
  });
});

describe("unpairedLabel", () => {
  it("names the primary series' own chart", () => {
    expect(unpairedLabel("total_targets_hit")).toBe("Targets Hit");
    expect(unpairedLabel("hit_1")).toBe("Tanks — Hit");
  });

  it("resolves every paired chart", () => {
    for (const m of buildMetrics({ paired: true })) expect(unpairedLabel(m.key)).toBeDefined();
  });
});

// The SBS monthly page titles a target's chart just "Tanks", while the daily
// page's is "Tanks — Hit / Destroyed"; the monthly chart's "By day →" link
// lands on the daily one through targetPairLabel. The two drifting apart broke
// every per-target link once — this holds the daily titles to the helper.
describe("targetPairLabel", () => {
  it("is the daily page's title for every target's paired chart, so its anchor lands", () => {
    const dailyAnchors = new Set(buildMetrics({ paired: true }).map((m) => chartAnchor(m.label)));
    const missing = TARGET_IDS.filter((id) => !dailyAnchors.has(chartAnchor(targetPairLabel(id))));
    expect(missing).toEqual([]);
  });
});

// Ranked, the daily page keeps each pair and adds its second half's own chart,
// drawn red.
describe("SECOND_HALVES", () => {
  it("is each pair's second series, not its first", () => {
    expect(SECOND_HALVES.has("destroyed_1")).toBe(true);
    expect(SECOND_HALVES.has("total_targets_destroyed")).toBe(true);
    expect(SECOND_HALVES.has("personnel_killed")).toBe(true);
    expect(SECOND_HALVES.has("hit_1")).toBe(false);
    expect(SECOND_HALVES.has("total_personnel_casualties")).toBe(false);
  });

});

describe("withSecondHalves", () => {
  const ranked = withSecondHalves(buildMetrics({ paired: true }));

  it("follows each pair with its second half's own chart", () => {
    const i = ranked.findIndex((m) => m.id === "hit_1~destroyed_1");
    expect(ranked[i + 1]).toMatchObject({ id: "destroyed_1", label: "Tanks — Destroyed" });
    expect(ranked.find((m) => m.id === "total_targets_destroyed")?.label).toBe("Targets Destroyed");
  });

  it("charts every second half once, and nothing twice", () => {
    for (const k of SECOND_HALVES) expect(ranked.filter((m) => m.id === k), k).toHaveLength(1);
    expect(dupes(ranked.map((m) => m.label))).toEqual([]);
  });
});
