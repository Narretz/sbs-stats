import { test, expect } from "@playwright/test";

// The page reads the bundled scripts/body_exchanges/exchanges.json, so there is
// no fixture DB: this is the real data. The arithmetic (totals, the ratio over
// exchanges both sides reported) is in src/data/bodyExchanges.test.ts; here,
// only that the page reaches the screen and a pinned exchange links its sources.
test("body exchanges — the charts render and a pinned exchange lists its sources", async ({ page }) => {
  await page.goto("/?site=body-exchanges");
  await expect(page.getByRole("heading", { name: "Body Exchanges between Russia and Ukraine" })).toBeVisible();
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

test("body exchanges — the month window narrows the charts and their totals", async ({ page }) => {
  // A year ending December 2024: every exchange of 2024, and only those.
  await page.goto("/?site=body-exchanges&months=12&end-month=2024-12");
  const card = page.locator(".chart-card").first();
  await expect(card.getByText("13 EXCHANGES", { exact: true })).toBeVisible();
  await expect(page.getByTestId("month-end-year")).toHaveValue("2024");
});
