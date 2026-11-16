import { test, expect, type Page } from "@playwright/test";
import { FIXED_TODAY, SUBTYPE_DAY_OFFSET } from "./build-fixtures.mjs";

// Regression guard for the weapon sub-type breakdown in the drones tooltip.
//
// piterfm's `destroyed_types` itemizes what was *inside* a weapon row: the Air
// Force reports an overnight raid as one "Shahed-136/131" line and then names
// the few Banderol cruise missiles or jet-powered airframes among them. What
// happens next depends on the weapon: a jet-powered Geran is still a UAV and
// stays nested under that row, where only its position and "of which" label say
// it isn't a sibling adding to the total — hence the ordering assertions below,
// not just "contains" ones. Banderol is a cruise missile, so its counts are
// carved out of the UAV row and charted under cruise instead.
//
// The second thing that has to hold is that an un-itemized intercept count
// stays un-itemized: build-fixtures seeds one sub-type with `destroyed` and one
// without, and the one without must not read as "9 launched, 0 intercepted".
//
// Which entries the queries produce — carved out, nested, not repeated — is
// src/data/ruAirAttacksDb.test.ts; this one hover is the rows reaching the
// screen in order, with the cells a nested row leaves empty.
const dayISO = (offset: number) => {
  const d = new Date(`${FIXED_TODAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};
const SUBTYPE_DAY = dayISO(-SUBTYPE_DAY_OFFSET);

// Tooltip headers are the ISO date itself (utils/dateFormat).
const fmt = (iso: string) => iso;

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

  test("a sub-type of the parent's own kind stays nested, intercepts and all", async ({ page }) => {
    const tip = await tooltipAt(page, "Drones", SUBTYPE_DAY);
    // Banderol, a cruise missile, was carved out of this row; the 104/94 seeded
    // is what is left.
    expect(tip).not.toContain("Banderol");
    expect(cellsAfter(tip, "Shahed-136/131")).toEqual(["100", "100.0%", "90", "90.0%"]);
    // A jet-powered Geran is still a UAV, so it stays inside the row it was
    // itemized from. Launched, then an em dash standing in for the intercept
    // cell — and nothing after it, since a rate over a number nobody published
    // would be fiction and a 0 would invent an outcome.
    expect(tip.indexOf("Shahed-136/131")).toBeLessThan(tip.indexOf("of which jet-powered"));
    expect(cellsAfter(tip, "↳ of which jet-powered")).toEqual(["9", "—"]);
  });
});
