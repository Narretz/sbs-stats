import { test, expect, type Page } from "@playwright/test";

// Charts render when they are nearly in view, not all at once.
//
// The SBS hourly page mounts 89 charts (7 headline metrics + 46 target classes
// x hit/destroyed), each with one <Line> per day in the window. Rendering them
// up front blocked the main thread for ~5.6s at a 120-day window before the
// page would answer a click — almost all of it for charts nobody had scrolled
// to. See LazyChartArea.

const HOURLY = "/?site=sbs&page=hourly";

const counts = (page: Page) =>
  page.evaluate(() => ({
    rendered: document.querySelectorAll(".recharts-surface").length,
    pending: document.querySelectorAll("[data-chart-pending]").length,
    height: document.documentElement.scrollHeight,
  }));

// `behavior: "instant"` because the app sets `scroll-behavior: smooth`, and a
// test that reads scrollY mid-animation measures the animation.
async function scrollTo(page: Page, y: number | "bottom") {
  await page.evaluate((target) => {
    const top = target === "bottom" ? document.documentElement.scrollHeight : (target as number);
    window.scrollTo({ top, behavior: "instant" as ScrollBehavior });
  }, y);
  await page.waitForTimeout(600);
}

test.describe("Charts render on approach", () => {
  test("only the charts near the viewport render, and the rest hold their space", async ({ page }) => {
    await page.goto(HOURLY);
    await page.locator(".hourly-card").first().waitFor();
    await page.waitForTimeout(1200);

    const cards = await page.locator(".hourly-card").count();
    const first = await counts(page);
    // A handful, not all of them — and every card that hasn't drawn its chart
    // is holding a box instead.
    expect(first.rendered).toBeGreaterThan(0);
    expect(first.rendered).toBeLessThan(cards / 2);
    expect(first.rendered + first.pending).toBe(cards);
  });

  test("the page is its full height from the first frame", async ({ page }) => {
    await page.goto(HOURLY);
    await page.locator(".hourly-card").first().waitFor();
    await page.waitForTimeout(1200);
    const before = (await counts(page)).height;

    await scrollTo(page, "bottom");
    await scrollTo(page, 0);
    const after = await counts(page);

    // The placeholder is exactly the plot area's height, so charts arriving
    // neither lengthen the page nor shift what is under the reader's cursor.
    expect(after.height).toBe(before);
    expect(after.rendered).toBeGreaterThan(0);
  });

  test("scrolling renders more, and nothing is ever taken back", async ({ page }) => {
    await page.goto(HOURLY);
    await page.locator(".hourly-card").first().waitFor();
    await page.waitForTimeout(1200);
    const start = (await counts(page)).rendered;

    await scrollTo(page, "bottom");
    const bottom = (await counts(page)).rendered;
    expect(bottom).toBeGreaterThan(start);

    // Back where we began: what rendered stays rendered. Unmounting would pay
    // the expensive first render again on the way back.
    await scrollTo(page, 0);
    expect((await counts(page)).rendered).toBeGreaterThanOrEqual(bottom);
  });

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
