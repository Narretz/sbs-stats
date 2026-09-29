import { test, expect, type Page } from "@playwright/test";

// The combined charts' weekly grain: daily sources summed into Mon–Sun weeks,
// set against the President's weekly-only strike tally on one chart. The
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

    const tip = await tooltipAt(page, "5–11 Jan 2026");
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

  test("the tally is pickable in the metric picker on a weekly chart, and only there", async ({ page }) => {
    // Through the picker itself, not a URL: the tally was once in the metric
    // registry but missing from the picker's group list, which a URL-built
    // chart can't notice.
    await page.goto(`/?charts=${encodeURIComponent("A:w26:")}`);
    await page.locator('button:has-text("metric")').first().click();
    const popover = page.locator("[popover]").first();
    await popover.waitFor({ state: "visible" });
    const tally = popover.locator("label", { hasText: "Strike Drones Launched (rounded)" });
    await expect(tally).toBeVisible();
    await tally.locator('input[type="checkbox"]').check();
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => decodeURIComponent(location.search).includes("zelensky.drones"));

    // A daily chart can't render a weekly-only series, so doesn't offer it.
    await page.goto(`/?charts=${encodeURIComponent("B:d30:")}`);
    await page.locator('button:has-text("metric")').first().click();
    await page.locator("[popover]").first().waitFor({ state: "visible" });
    await expect(page.locator("[popover]").first().locator("label", { hasText: "Strike Drones Launched (rounded)" })).toHaveCount(0);
  });
});
