import { test, expect, type Page } from "@playwright/test";
import { FIXED_TODAY, ROWED_SEPARATELY_DAY_OFFSET, SUBTYPE_DAY_OFFSET } from "./build-fixtures.mjs";

// Regression guard for the weapon sub-type breakdown in the drones tooltip.
//
// piterfm's `destroyed_types` itemizes what was *inside* a weapon row: the Air
// Force reports an overnight raid as one "Shahed-136/131" line and then names
// the few Banderol cruise missiles or jet-powered airframes among them. Those
// counts are a subset of that row, not another model alongside it, and the only
// thing saying so in the tooltip is where they sit and how they read — hence
// the ordering assertion below, not just a "contains" one.
//
// The second thing that has to hold is that an un-itemized intercept count
// stays un-itemized: build-fixtures seeds one sub-type with `destroyed` and one
// without, and the one without must not read as "9 launched, 0 intercepted".
const dayISO = (offset: number) => {
  const d = new Date(`${FIXED_TODAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};
const SUBTYPE_DAY = dayISO(-SUBTYPE_DAY_OFFSET);
const PLAIN_DAY = dayISO(-3); // no itemization → no sub-type rows at all
// Itemized *and* given a row of its own by the same report → already charted
// under its own model, so it must not repeat inside the UAV row.
const ROWED_SEPARATELY_DAY = dayISO(-ROWED_SEPARATELY_DAY_OFFSET);

const fmt = (iso: string) => {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
};

function chartCard(page: Page, title: string) {
  return page
    .locator("div")
    .filter({ has: page.getByText(title, { exact: true }) })
    .filter({ has: page.locator("svg.recharts-surface") })
    .last();
}

// Sweep the plot area and return the tooltip once its header names `date`.
// Same approach as undisclosed-counts.spec.ts: scanning keeps this independent
// of chart margins and category spacing.
async function tooltipAt(page: Page, title: string, date: string): Promise<string> {
  const card = chartCard(page, title);
  await card.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  const svg = card.locator("svg.recharts-surface").first();
  const box = (await svg.boundingBox())!;
  const wrapper = card.locator(".recharts-tooltip-wrapper");
  const header = fmt(date);
  for (let i = 0; i <= 60; i++) {
    await page.mouse.move(box.x + (box.width * i) / 60, box.y + box.height * 0.55);
    await page.waitForTimeout(60);
    const tip = (await wrapper.innerText()).trim();
    if (tip.startsWith(header)) return tip;
  }
  throw new Error(`no tooltip for ${date} on "${title}"`);
}

test.describe("RU air attacks — weapon sub-type breakdown", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`/?site=ru-air-attacks-gsua&page=daily&days=8&date=${FIXED_TODAY}`);
    await expect(page.getByText("Drones", { exact: true })).toBeVisible();
    await page.waitForTimeout(1200);
  });

  // The tooltip is a CSS grid, so innerText yields one line per *cell*: a row
  // is its label followed by however many cells it populated. That makes the
  // cells after a label assertable one by one — which is the only way to see
  // that a column was left empty rather than filled with a zero.
  const cellsAfter = (tip: string, label: string): string[] => {
    const lines = tip.split("\n").map((l) => l.trim());
    const at = lines.indexOf(label);
    expect(at, `row "${label}" missing from tooltip:\n${tip}`).toBeGreaterThan(-1);
    const rest = lines.slice(at + 1);
    const next = rest.findIndex((l) => /^[A-Za-z↳]/.test(l));
    return next < 0 ? rest : rest.slice(0, next);
  };

  test("itemized sub-types read as a subset of the row above them", async ({ page }) => {
    const tip = await tooltipAt(page, "Drones", SUBTYPE_DAY);
    expect(tip).toContain("Shahed-136/131");
    // Under its parent, not floating among the sibling model rows.
    expect(tip.indexOf("Shahed-136/131")).toBeLessThan(tip.indexOf("of which Banderol"));
    // Launched, intercepted, intercept rate — and no share cell between the
    // first two, because a nested row's share of the day would sit in the same
    // column as its siblings' and read as if it added to their 100%.
    expect(cellsAfter(tip, "↳ of which Banderol")).toEqual(["4", "4", "100.0%"]);
  });

  test("a sub-type whose intercepts weren't itemized shows no intercept count", async ({ page }) => {
    const tip = await tooltipAt(page, "Drones", SUBTYPE_DAY);
    // Launched, then an em dash standing in for the intercept cell — and
    // nothing after it, since a rate over a number nobody published would be
    // fiction and a 0 would invent an outcome.
    expect(cellsAfter(tip, "↳ of which jet-powered")).toEqual(["9", "—"]);
  });

  // Whether an itemization sits inside its parent row or alongside it depends on
  // whether the same report also gave that weapon a row of its own, and piterfm
  // has done it both ways (see installSubtypeTable). When it did, the weapon is
  // already charted as its own model — repeating it under the UAV row would
  // double-show it and misstate the parent's count.
  test("a sub-type the same report also rowed separately is not repeated", async ({ page }) => {
    const tip = await tooltipAt(page, "Drones", ROWED_SEPARATELY_DAY);
    expect(tip).toContain("Shahed-136/131");
    expect(tip).not.toContain("of which");
  });

  test("a day with no itemization carries no sub-type rows", async ({ page }) => {
    const tip = await tooltipAt(page, "Drones", PLAIN_DAY);
    expect(tip).toContain("Shahed-136/131");
    expect(tip).not.toContain("of which");
  });
});
