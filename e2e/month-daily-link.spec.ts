import { test, expect, type Page, type Locator } from "@playwright/test";

// A pinned month links to its day-by-day breakdown on the same site's daily
// view. The window arithmetic is unit-tested (monthDailyWindow); this covers
// what only the app can show: the link is there, a plain click navigates in
// place, and the daily page opens on that window and chart.

const sheet = (p: Page) => p.locator(".chart-sheet[data-open]");
const link = (p: Page) => sheet(p).getByRole("link", { name: "By day →" });

async function pin(page: Page, card: Locator, frac = 0.3) {
  await card.scrollIntoViewIfNeeded();
  const svg = card.locator("svg.recharts-surface").first();
  const box = (await svg.boundingBox())!;
  await svg.click({ position: { x: box.width * frac, y: box.height * 0.5 } });
  await expect(sheet(page)).toBeVisible();
}

test("a pinned month opens the daily view windowed to that month", async ({ page }) => {
  await page.goto("/?site=ru-attacks-gsua&page=monthly");
  await page.waitForSelector(".chart-card");
  await pin(page, page.locator(".chart-card#combat-engagements"));
  const month = (await page.locator(".chart-sheet-label").textContent())!.slice(0, 7);

  await link(page).click();

  await expect(page).toHaveURL(/[?&]page=daily\b/);
  const url = new URL(page.url());
  expect(url.hash).toBe("#combat-engagements");
  const days = Number(url.searchParams.get("days"));
  const date = url.searchParams.get("date");
  // Past month: ends on its last day and spans all of it. The month in
  // progress: live (no date), from its first day.
  if (date) {
    expect(date.slice(0, 7)).toBe(month);
    expect(days).toBe(Number(date.slice(8, 10)));
  } else {
    expect(days).toBeGreaterThanOrEqual(1);
    expect(days).toBeLessThanOrEqual(31);
  }
  await expect(page.locator(".chart-card#combat-engagements")).toBeVisible();
  // The pin belonged to the monthly chart; it must not follow us.
  await expect(sheet(page)).toHaveCount(0);

  // One history entry: Back returns to the monthly page.
  await page.goBack();
  await expect(page).toHaveURL(/[?&]page=monthly\b/);
});

test("a monthly-only source has no daily link", async ({ page }) => {
  await page.goto("/?site=rubikon&page=monthly");
  await page.waitForSelector(".chart-card");
  await pin(page, page.locator(".chart-card").first(), 0.5);
  await expect(link(page)).toHaveCount(0);
});
