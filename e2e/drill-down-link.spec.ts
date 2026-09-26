import { test, expect, type Page, type Locator } from "@playwright/test";

// A pinned point links to its breakdown on the same site's next finer view: a
// month on the daily page, a day on the hourly one. The window arithmetic is
// unit-tested (monthDailyWindow, dayHourlyDate); this covers what only the app
// can show: the link is there, a plain click navigates in place, and the finer
// page opens on that window.

const sheet = (p: Page) => p.locator(".chart-sheet[data-open]");
const byDay = (p: Page) => sheet(p).getByRole("link", { name: "By day →" });
const byHour = (p: Page) => sheet(p).getByRole("link", { name: "By hour →" });

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

  await byDay(page).click();

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
  await expect(byDay(page)).toHaveCount(0);
});

for (const site of ["sbs", "ru-attacks-gsua"]) {
  test(`a pinned ${site} day opens the hourly view ending on that day`, async ({ page }) => {
    await page.goto(`/?site=${site}&page=daily&days=7`);
    await page.waitForSelector(".chart-card");
    const card = page.locator(".chart-card").first();
    const anchor = await card.getAttribute("id");
    await pin(page, card, 0.5);

    const href = await byHour(page).getAttribute("href");
    const target = new URL(href!, page.url());
    const date = target.searchParams.get("date");
    await byHour(page).click();

    await expect(page).toHaveURL(/[?&]page=hourly\b/);
    const url = new URL(page.url());
    expect(url.hash).toBe(`#${anchor}`);
    await expect(page.locator(`.hourly-card${url.hash}`)).toBeVisible();
    // The day, or live when it is today; the daily page's span is kept.
    expect(url.searchParams.get("date")).toBe(date);
    if (date) expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(url.searchParams.get("days")).toBe("7");
    await expect(page.locator(".hourly-card").first()).toBeVisible();
    await expect(sheet(page)).toHaveCount(0);
  });
}

test("a paired SBS day lands on the hourly chart of its primary series", async ({ page }) => {
  // Daily draws hit / destroyed as one chart; hourly splits them.
  await page.goto("/?site=sbs&page=daily&days=7");
  await page.waitForSelector(".chart-card");
  await pin(page, page.locator(".chart-card#tanks-hit-destroyed"), 0.5);
  await byHour(page).click();
  await expect(page).toHaveURL(/#tanks-hit$/);
  await expect(page.locator(".hourly-card#tanks-hit")).toBeInViewport();
});

test("a daily page without an hourly one has no hourly link", async ({ page }) => {
  await page.goto("/?site=ru-airdef-mod&page=daily");
  await page.waitForSelector(".chart-card");
  await pin(page, page.locator(".chart-card").first(), 0.5);
  await expect(byHour(page)).toHaveCount(0);
});
