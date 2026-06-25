import { test, expect, type Page } from "@playwright/test";

// Regression guard for the MAX/MED scope control on the SBS daily & hourly views.
//
// The bug: the page fed the chart its *window-scoped* stats as the "All data"
// input (a `chartStats` memo over the filtered rows), so both scopes — and the
// day-range — produced the same reference lines. Toggling did nothing.
//
// The fix passes whole-dataset `globalStats` for "All data". To assert this
// deterministically, build-fixtures.mjs seeds a far-past sentinel
// (total_personnel_casualties = 999,999 on 2020-01-01) that lies OUTSIDE every
// day-range window but INSIDE the full dataset. So "All data" must surface it and
// "Window data" must not — regardless of how the CI-updated fixture's real
// values fall.
const SENTINEL = "999,999";

// MAX numbers from every chart's "▲ MAX <n>" summary span. The bare "MAX" axis
// label (no number) and the "MAX/MED Base" control don't match.
async function maxLabels(page: Page): Promise<string[]> {
  const body = await page.locator("body").innerText();
  return [...body.matchAll(/MAX\s+([\d,]+)/g)].map((m) => m[1]);
}

async function setDays(page: Page, days: string) {
  await page.getByTestId("day-range").selectOption(days);
  await page.waitForTimeout(700); // let rows refetch + charts re-render
}

for (const view of ["daily", "hourly"] as const) {
  test.describe(`SBS ${view} — MAX/MED scope`, () => {
    test("'All data' spans the whole dataset; 'Window data' only the window", async ({ page }) => {
      // "/" lands on the Custom-charts homepage; site pages are reached via the
      // ?site=…&page=… URL params (or the in-app site-picker once you're inside
      // a site). Tests deep-link to bypass the home → site click.
      await page.goto(`/?site=sbs&page=${view}`);
      await page.waitForSelector(".recharts-surface");

      await page.getByTestId("stat-scope-select").selectOption("all");
      await page.waitForTimeout(400);
      expect(await maxLabels(page)).toContain(SENTINEL); // sees the far-past peak

      await page.getByTestId("stat-scope-select").selectOption("window");
      await page.waitForTimeout(400);
      expect(await maxLabels(page)).not.toContain(SENTINEL); // window excludes it
    });

    test("'All data' MAX/MED is independent of the day-range window", async ({ page }) => {
      // "/" lands on the Custom-charts homepage; site pages are reached via the
      // ?site=…&page=… URL params (or the in-app site-picker once you're inside
      // a site). Tests deep-link to bypass the home → site click.
      await page.goto(`/?site=sbs&page=${view}`);
      await page.waitForSelector(".recharts-surface");
      await page.getByTestId("stat-scope-select").selectOption("all");

      await setDays(page, "7");
      const at7 = await maxLabels(page);
      await setDays(page, "180");
      const at180 = await maxLabels(page);

      expect(at7.length).toBeGreaterThan(0);
      // Whole-dataset MAX/MED cannot depend on how many days are shown.
      // (Pre-fix this failed: "All data" actually tracked the visible window.)
      expect(at180).toEqual(at7);
    });
  });
}
