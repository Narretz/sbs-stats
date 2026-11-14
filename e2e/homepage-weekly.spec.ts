import { test, expect, type Page } from "@playwright/test";

// The combined charts' weekly grain: daily sources summed into Mon–Sun weeks,
// set against the President's weekly strike tally on one chart. The
// arithmetic (sums, gaps, partial weeks) is unit-tested in weekRange /
// combinedQuery; what this checks is that the grain reaches the screen and
// the URL.
const TALLY = "President UA · Strike Drones Launched (rounded)";
const AIR = "RU Strikes · Drones — Launched";

function card(page: Page) {
  return page.locator("div").filter({ has: page.locator("svg.recharts-surface") }).filter({ hasText: TALLY }).last();
}

async function tooltipAt(page: Page, header: string): Promise<string> {
  const c = card(page);
  await c.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  const box = (await c.locator("svg.recharts-surface").first().boundingBox())!;
  const wrapper = c.locator(".recharts-tooltip-wrapper");
  for (let i = 0; i <= 40; i++) {
    await page.mouse.move(box.x + (box.width * i) / 40, box.y + box.height * 0.5);
    await page.waitForTimeout(60);
    const tip = (await wrapper.innerText()).trim();
    if (tip.startsWith(header)) return tip;
  }
  throw new Error(`no tooltip for ${header}`);
}

test.describe("Homepage weekly grain", () => {
  test("the weekly tally and a summed daily source share one weekly chart", async ({ page }) => {
    // Four weeks ending 25 Jan 2026 — the tally fixture's weeks
    // (build-fixtures.mjs ZELENSKY_WEEKS).
    const charts = `W:w4:zelensky.drones,ru-air-attacks.drone_launched`;
    await page.goto(`/?charts=${encodeURIComponent(charts)}&date=2026-01-25`);
    await expect(page.getByText(TALLY).first()).toBeVisible();
    await expect(page.getByText(AIR).first()).toBeVisible();
    await expect(page.locator('select[title="Time granularity for this chart"]').first()).toHaveValue("weekly");

    const tip = await tooltipAt(page, "2026-01-05/11");
    expect(tip).toContain("1,000");
  });

  test("switching a chart to Weekly writes the weekly spec to the URL", async ({ page }) => {
    await page.goto(`/?charts=${encodeURIComponent("A:d30:ru-air-attacks.drone_launched")}`);
    const grain = page.locator('select[title="Time granularity for this chart"]').first();
    await grain.selectOption("weekly");
    await page.waitForFunction(() => /[?&]charts=A%3Aw26%3A/.test(location.search) || /charts=A:w26:/.test(decodeURIComponent(location.search)));
    // The daily source is kept — it has a weekly view.
    await expect(page.getByText(AIR).first()).toBeVisible();
  });

  // Which grains the picker offers the tally on: MetricPicker.browser.test.tsx.

  test("a chart switched to Bars draws bars and keeps the choice in the URL", async ({ page }) => {
    const charts = `W:w4:zelensky.drones`;
    await page.goto(`/?charts=${encodeURIComponent(charts)}&date=2026-01-25`);
    await expect(page.getByText(TALLY).first()).toBeVisible();
    const chartSvg = card(page).locator("svg.recharts-surface").first();
    await expect(chartSvg.locator(".recharts-bar-rectangle")).toHaveCount(0);

    await page.locator('select[title="Draw this chart\'s series as lines or as bars"]').first().selectOption("bar");
    await page.waitForFunction(() => decodeURIComponent(location.search).includes("W:w4b:"));
    // Two of the fixture's four weeks carry a drone figure.
    await expect(chartSvg.locator(".recharts-bar-rectangle path")).toHaveCount(2);

    // …and a reload restores it from the URL.
    await page.reload();
    await expect(card(page).locator("svg.recharts-surface").first().locator(".recharts-bar-rectangle path")).toHaveCount(2);
  });

  // The tally on the monthly grain: months built from its weeks (the
  // arithmetic is combinedQuery.test.ts). The fixture's tallies both fall in
  // January, so of a window to February only January has a bar.
  test("the tally draws its months on a monthly chart", async ({ page }) => {
    await page.goto(`/?charts=${encodeURIComponent("M:m3b:zelensky.drones")}&date=2026-02-10`);
    await expect(page.getByText(TALLY).first()).toBeVisible();
    await expect(card(page).locator("svg.recharts-surface").first().locator(".recharts-bar-rectangle path")).toHaveCount(1);
  });
});
