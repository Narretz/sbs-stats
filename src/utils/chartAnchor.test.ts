import { describe, expect, it } from "vitest";
import { chartAnchor } from "@/utils/chartAnchor";

// A chart card's id, and so its URL fragment. That the ids on a real page are
// unique, and that a fragment scrolls to its card, is e2e/chart-anchors.spec.ts.
describe("chartAnchor", () => {
  it("lower-cases a title and joins its words with single hyphens", () => {
    expect(chartAnchor("Mortars")).toBe("mortars");
    expect(chartAnchor("Tanks — Hit / Destroyed")).toBe("tanks-hit-destroyed");
    expect(chartAnchor("All — Drones + Missiles · Launched")).toBe("all-drones-missiles-launched");
  });

  it("drops quote marks rather than splitting on them", () => {
    expect(chartAnchor("RU «Рубикон» drones")).toBe("ru-drones");
    expect(chartAnchor("President's tally")).toBe("presidents-tally");
  });

  it("is always URL-safe, with no hyphen at either end", () => {
    for (const title of ["  Σ severe  ", "(KAB) bombs", "2026 / 10", "Front-line weather — drone conditions"]) {
      expect(chartAnchor(title)).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  it("is empty for a title with nothing it can keep", () => {
    expect(chartAnchor("Рубикон")).toBe("");
  });
});
