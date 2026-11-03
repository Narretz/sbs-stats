import { test, expect, type Page } from "@playwright/test";
import {
  FIXED_TODAY, IMPACT_NONE_DAY_OFFSET, IMPACT_TWO_REPORTS_DAY_OFFSET, ROWED_SEPARATELY_DAY_OFFSET,
} from "./build-fixtures.mjs";

// The RU air-attacks "locations hit / debris" charts. The figure is one per
// Air Force REPORT, and piterfm sometimes copies it onto a second row of the
// same report — so what has to reach the screen is: a repeated figure counted
// once, two reports of a day added up, and a day with no figure a gap rather
// than a 0. The fixture's days are build-fixtures.mjs's IMPACT_* offsets.
const dayISO = (offset: number) => {
  const d = new Date(`${FIXED_TODAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};
const HIT = "Locations Hit";
const DEBRIS = "Locations Hit by Falling Debris";

function chartCard(page: Page, title: string) {
  return page
    .locator("div")
    .filter({ has: page.getByText(title, { exact: true }) })
    .filter({ has: page.locator("svg.recharts-surface") })
    .last();
}

// Sweep the plot area until the tooltip header names `date`.
async function tooltipAt(page: Page, title: string, date: string): Promise<string> {
  const card = chartCard(page, title);
  await card.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  const box = (await card.locator("svg.recharts-surface").first().boundingBox())!;
  const wrapper = card.locator(".recharts-tooltip-wrapper");
  for (let i = 0; i <= 60; i++) {
    await page.mouse.move(box.x + (box.width * i) / 60, box.y + box.height * 0.55);
    await page.waitForTimeout(60);
    const tip = (await wrapper.innerText()).trim();
    if (tip.startsWith(date)) return tip;
  }
  throw new Error(`no tooltip for ${date} on "${title}"`);
}

test.describe("RU air attacks — locations hit", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`/?site=ru-air-attacks-gsua&page=daily&days=8&date=${FIXED_TODAY}`);
    await expect(page.getByText(HIT, { exact: true })).toBeVisible();
    await page.waitForTimeout(1200);
  });

  test("a figure repeated on two rows of one report counts once", async ({ page }) => {
    const d = ROWED_SEPARATELY_DAY_OFFSET;
    expect(await tooltipAt(page, HIT, dayISO(-d))).toMatch(new RegExp(`${HIT}\\s+${3 * d}\\b`));
    expect(await tooltipAt(page, DEBRIS, dayISO(-d))).toMatch(new RegExp(`${DEBRIS}\\s+${d}\\b`));
  });

  test("two reports of a day add up", async ({ page }) => {
    const d = IMPACT_TWO_REPORTS_DAY_OFFSET;
    expect(await tooltipAt(page, HIT, dayISO(-d))).toMatch(new RegExp(`${HIT}\\s+${3 * d + 4}\\b`));
    expect(await tooltipAt(page, DEBRIS, dayISO(-d))).toMatch(new RegExp(`${DEBRIS}\\s+${d + 1}\\b`));
  });

  test("a day without a figure is a gap, not 0", async ({ page }) => {
    // A gap has no tooltip to read, so the stats tell: the days with a figure
    // are 3, 10, 12, 15, 18, 21 → MED 15. Read as a 0, the empty day −3 would
    // pull it to 12.
    expect(IMPACT_NONE_DAY_OFFSET).toBe(3);
    const text = await chartCard(page, HIT).innerText();
    expect(text).toMatch(/MED\s+15\b/);
    expect(text).toMatch(/MAX\s+21\b/);
  });

  test("the monthly page charts them too", async ({ page }) => {
    await page.goto("/?site=ru-air-attacks-gsua&page=monthly");
    await expect(page.getByText(HIT, { exact: true })).toBeVisible();
    await expect(page.getByText(DEBRIS, { exact: true })).toBeVisible();
  });
});
