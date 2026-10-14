import { describe, expect, it } from "vitest";
import { buildMetrics, targetPairLabel, unpairedLabel } from "@/utils/metrics";
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
