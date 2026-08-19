import { test, expect } from "@playwright/test";

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
