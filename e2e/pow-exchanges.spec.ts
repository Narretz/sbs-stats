import { test, expect } from "@playwright/test";

// The page reads the bundled scripts/pow_exchanges/exchanges.json, so there is
// no fixture DB: this is the real data. The arithmetic is in
// src/data/exchanges.test.ts; here, only that the page reaches the screen and
// a pinned exchange links its sources.
test("pow exchanges — the charts render and a pinned exchange lists its sources", async ({ page }) => {
  await page.goto("/?site=pow-exchanges");
  await expect(page.getByRole("heading", { name: "Prisoner Exchanges between Russia and Ukraine" })).toBeVisible();
  await expect(page.locator(".chart-card")).toHaveCount(3);
  await expect(page.locator(".chart-card").first()).toContainText(/Σ TO UKRAINE [\d,]+/);

  const svg = page.locator(".chart-card svg.recharts-surface").first();
  await svg.scrollIntoViewIfNeeded();
  const box = (await svg.boundingBox())!;
  await svg.click({ position: { x: box.width * 0.5, y: box.height * 0.5 } });
  const sheet = page.locator(".chart-sheet[data-open]");
  await expect(sheet).toContainText("To Ukraine");
  await expect(sheet.getByRole("button", { name: /Sources \(\d+\)/ })).toBeVisible();
});

test("pow exchanges — the month window narrows the charts and their totals", async ({ page }) => {
  // A year ending December 2024: every exchange of 2024, and only those.
  await page.goto("/?site=pow-exchanges&months=12&end-month=2024-12");
  await expect(page.locator(".chart-card").first().getByText("12 EXCHANGES", { exact: true })).toBeVisible();
});
