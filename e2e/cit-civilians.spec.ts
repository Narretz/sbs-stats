import { test, expect, type Locator, type Page } from "@playwright/test";

// The CIT civilian-casualties pages, on build-fixtures.mjs's CIT_REPORTS: one
// December report, then 5–11 Jan 2026 with no report on Wed 7 Jan and ONE
// 48-hour weekend report for Sat 10 + Sun 11. What has to reach the screen is
// what the numbers alone can't say: the weekend is one report, drawn as one
// bar across both days, and the missing day is a gap rather than a zero.
const DAILY = "/?site=cit-civilians&page=daily&days=7&date=2026-01-11";
const MONTHLY = "/?site=cit-civilians&page=monthly";
const KILLED = "Civilians killed";
const SIDE = "#casualties-by-controlling-side";

function chartCard(page: Page, title: string) {
  return page
    .locator("div")
    .filter({ has: page.getByText(title, { exact: true }) })
    .filter({ has: page.locator("svg.recharts-surface") })
    .last();
}

// Sweep the plot area until the tooltip header starts with `header`.
async function tooltipAt(page: Page, card: Locator, header: string): Promise<string> {
  await card.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  const box = (await card.locator("svg.recharts-surface").first().boundingBox())!;
  const wrapper = card.locator(".recharts-tooltip-wrapper");
  for (let i = 0; i <= 60; i++) {
    await page.mouse.move(box.x + (box.width * i) / 60, box.y + box.height * 0.8);
    await page.waitForTimeout(60);
    const tip = (await wrapper.innerText()).trim();
    if (tip.startsWith(header)) return tip;
  }
  throw new Error(`no tooltip for ${header}`);
}

test.describe("CIT daily page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(DAILY);
    await expect(page.getByText(KILLED, { exact: true })).toBeVisible();
    await page.waitForTimeout(800);
  });

  test("renders the headline charts and the controlling-side chart", async ({ page }) => {
    for (const title of ["All civilian casualties", KILLED, "Civilians injured"]) {
      await expect(page.getByText(title, { exact: true })).toBeVisible();
    }
    await expect(page.locator(SIDE)).toBeVisible();
  });

  test("TOTAL counts the weekend report once, in either stat scope", async ({ page }) => {
    // All data: 5 (Dec) + 2 + 4 + 1 + 3 + 6 (weekend). Window: the January week.
    const killed = chartCard(page, KILLED);
    await page.getByTestId("stat-scope-select").selectOption("all");
    await expect(killed.getByText("Σ TOTAL 21")).toBeVisible();
    await page.getByTestId("stat-scope-select").selectOption("window");
    await expect(killed.getByText("Σ TOTAL 16")).toBeVisible();
  });

  test("a weekend report is one bar spanning its two days", async ({ page }) => {
    const card = page.locator(SIDE);
    await card.scrollIntoViewIfNeeded();
    // Two stacked series; per series Mon, Tue, Thu, Fri and ONE weekend bar —
    // nothing for the gap on Wed, nothing of its own for the Saturday. Thu has
    // no Russian-controlled casualties, and a zero-height bar draws no path.
    const bars = card.locator(".recharts-bar-rectangle path");
    await expect(bars).toHaveCount(9);
    const widths = await bars.evaluateAll((els) =>
      els.map((e) => (e as SVGGraphicsElement).getBBox().width));
    const single = Math.min(...widths);
    const widest = Math.max(...widths);
    // Two bar widths plus the gap between the days.
    expect(widest).toBeGreaterThan(single * 2);
    expect(widths.filter((w) => w === widest)).toHaveLength(2);
  });

  test("the weekend tooltip quotes the report's 48-hour totals", async ({ page }) => {
    const tip = await tooltipAt(page, page.locator(SIDE), "10 Jan 2026");
    // 34 + 12 over two days → a daily average of 17 + 6.
    expect(tip).toMatch(/Total\s+23/);
    expect(tip).toContain("One 48-hour weekend report covering 10/01–11/01");
    expect(tip).toContain("34 Ukrainian-controlled, 12 Russian-controlled in total");
  });

  test("a day with no report is a gap, not a zero", async ({ page }) => {
    const tip = await tooltipAt(page, page.locator(SIDE), "7 Jan 2026");
    expect(tip).toContain("No CIT report covers this day.");
    expect(tip).not.toContain("Total");
  });
});

test.describe("CIT monthly page", () => {
  test("the controlling-side chart splits each month", async ({ page }) => {
    await page.goto(MONTHLY);
    const card = page.locator(SIDE);
    await expect(card).toBeVisible();
    // January: Ukrainian-controlled 8+18+10+12+34, Russian-controlled 4+6+0+6+12.
    const tip = await tooltipAt(page, card, "Jan 2026");
    expect(tip).toMatch(/Total\s+110/);
    expect(tip).toMatch(/Ukrainian-controlled\s+82/);
    expect(tip).toMatch(/Russian-controlled\s+28/);
  });
});
