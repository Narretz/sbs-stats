import { test, expect } from "@playwright/test";

// Charts render when they are nearly in view, not all at once.
//
// The SBS hourly page mounts 89 charts (7 headline metrics + 46 target classes
// x hit/destroyed), each with one <Line> per day in the window. Rendering them
// up front blocked the main thread for ~5.6s at a 120-day window before the
// page would answer a click — almost all of it for charts nobody had scrolled
// to. See LazyChartArea, whose own behaviour (only nearby areas render, the
// placeholders hold the height, nothing is unrendered) is
// src/components/LazyChartArea.browser.test.tsx. What stays here is the real
// page: a chart that arrived by scrolling works like any other.

const HOURLY = "/?site=sbs&page=hourly";

test.describe("Charts render on approach", () => {
  test("a chart that arrived by scrolling is fully interactive", async ({ page }) => {
    await page.goto(HOURLY);
    await page.locator(".hourly-card").first().waitFor();
    await page.waitForTimeout(1200);

    // Far enough down to have been a placeholder on load.
    const card = page.locator(".hourly-card").nth(40);
    await card.scrollIntoViewIfNeeded();
    const svg = card.locator("svg.recharts-surface").first();
    await svg.waitFor();
    const box = (await svg.boundingBox())!;
    const rows = page.locator('[data-testid="hourly-tooltip-days"] > div > div');

    // The fixture samples a handful of checkpoint hours and leaves the rest
    // null for every series, where recharts raises an empty tooltip — so sweep
    // for a band that has values instead of trusting one x fraction.
    let x = 0.6;
    for (const f of [0.6, 0.62, 0.58, 0.64, 0.56, 0.5, 0.44, 0.7, 0.76]) {
      await svg.hover({ position: { x: box.width * f, y: box.height * 0.5 } });
      if (await rows.count() > 0) { x = f; break; }
    }
    await expect(page.getByTestId("hourly-tooltip-days")).toBeVisible();

    await svg.click({ position: { x: box.width * x, y: box.height * 0.5 } });
    await expect(page.locator(".chart-sheet[data-open]")).toBeVisible();
  });
});
