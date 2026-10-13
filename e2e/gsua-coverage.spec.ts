import { test, expect } from "@playwright/test";
import { FIXED_TODAY } from "./build-fixtures.mjs";

// Direction-coverage "Unattributed" math. The fixture makes every day's
// canonical GS report a DUPLICATE (the same report under two message ids, both
// carrying Pokrovsk = 60% of the day's combat engagements). The coverage query
// must dedupe those twin directions (MAX per direction); if it SUMs them, each
// direction is counted twice — 120% of the total — which clamps `unattributed`
// to 0 and reports 100% attributed. So a correct build reads 60%, a regressed
// one reads 100%. See fix in useDatabaseGsua.ts (queryDirectionCoverage).
test.describe("GSUA direction coverage", () => {
  test("duplicate reports are not double-counted (attributed stays at 60%)", async ({ page }) => {
    await page.goto("/?site=ru-attacks-gsua&page=daily");

    // Wait for the composition chart to render (its summary line carries the
    // window-wide attribution figure we assert on).
    await page.waitForSelector(".recharts-surface");

    // The header summary reports window-wide attribution.
    await expect(page.getByText(/60% of attacks attributed/)).toBeVisible();
    // Guard the specific regression: double-counting the duplicate would clamp
    // unattributed to 0 and show 100%.
    await expect(page.getByText(/100% of attacks attributed/)).toHaveCount(0);
  });
});

// The monthly stack's end-of-month projection reaching the screen: the legend
// entry, and the month in progress's tooltip carrying the Projected column and
// its basis. The arithmetic is src/utils/gsuaDirections.test.ts.
test("the monthly composition chart projects the month in progress", async ({ page }) => {
  // The fixture is today and the days before it; on the 1st the month has no
  // complete day, so nothing to project from.
  test.skip(FIXED_TODAY.endsWith("-01"), "no complete day in the month yet");
  await page.goto("/?site=ru-attacks-gsua&page=monthly");
  const card = page.locator(".chart-card#combat-engagements-composition-by-direction");
  await expect(card.getByText("Projected (month in progress)")).toBeVisible();

  await card.scrollIntoViewIfNeeded();
  const svg = card.locator("svg.recharts-surface").first();
  const box = (await svg.boundingBox())!;
  await svg.click({ position: { x: box.width - 12, y: box.height * 0.5 } });
  const sheet = page.locator(".chart-sheet[data-open]");
  await expect(sheet).toContainText("Projected");
  await expect(sheet).toContainText(/\d+ of \d+ days complete/);
});
