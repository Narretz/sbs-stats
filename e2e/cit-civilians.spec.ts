import { test, expect, type Locator, type Page } from "@playwright/test";

// The CIT civilian-casualties pages, on build-fixtures.mjs's CIT_REPORTS: one
// December report, then 5–11 Jan 2026 with no report on Wed 7 Jan and ONE
// 48-hour weekend report for Sat 10 + Sun 11. What has to reach the screen is
// what the numbers alone can't say: the weekend is one report, drawn as one
// bar across both days, and the missing day is a gap rather than a zero.
const DAILY = "/?site=cit-civilians&page=daily&days=7&date=2026-01-11";
const MONTHLY = "/?site=cit-civilians&page=monthly";
const KILLED = "Civilians killed";
// Chart cards by their anchor ids (ChartCardTitle slugifies the title).
const ALL = "#all-civilian-casualties";
const KILLED_CARD = "#civilians-killed";
const SIDE = "#casualties-by-controlling-side";

// Every bar a card draws, by width. A weekend report is one bar across two
// days, so the widest bar is more than two single-day bars wide.
async function barWidths(page: Page, selector: string): Promise<number[]> {
  const card = page.locator(selector);
  await card.scrollIntoViewIfNeeded();
  const bars = card.locator(".recharts-bar-rectangle path");
  await expect(bars.first()).toBeVisible();
  return bars.evaluateAll((els) => els.map((e) => (e as SVGGraphicsElement).getBBox().width));
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
    const killed = page.locator(KILLED_CARD);
    await page.getByTestId("stat-scope-select").selectOption("all");
    await expect(killed.getByText("Σ TOTAL 21")).toBeVisible();
    await page.getByTestId("stat-scope-select").selectOption("window");
    await expect(killed.getByText("Σ TOTAL 16")).toBeVisible();
  });

  test("a weekend report is one bar spanning its two days", async ({ page }) => {
    // Mon, Tue, Thu, Fri and ONE weekend bar — nothing for the gap on Wed,
    // nothing of its own for the Saturday.
    const widths = await barWidths(page, KILLED_CARD);
    expect(widths).toHaveLength(5);
    const single = Math.min(...widths);
    const widest = Math.max(...widths);
    // Two bar widths plus the gap between the days.
    expect(widest).toBeGreaterThan(single * 2);
    expect(widths.filter((w) => w === widest)).toHaveLength(1);
  });

  test("the stacked charts span the weekend in every band", async ({ page }) => {
    // Two series each. On the controlling-side chart Thu has no Russian-
    // controlled casualties, and a zero-height bar draws no path.
    for (const [selector, count] of [[ALL, 10], [SIDE, 9]] as const) {
      const widths = await barWidths(page, selector);
      expect(widths).toHaveLength(count);
      const widest = Math.max(...widths);
      expect(widest).toBeGreaterThan(Math.min(...widths) * 2);
      expect(widths.filter((w) => w === widest)).toHaveLength(2);
    }
  });

  test("the headline weekend tooltip quotes the report's 48-hour totals", async ({ page }) => {
    const tip = await tooltipAt(page, page.locator(ALL), "10 Jan 2026");
    // 6 killed + 40 injured over two days → a daily average of 3 + 20.
    expect(tip).toMatch(/Total\s+23/);
    expect(tip).toContain("One 48-hour weekend report covering 10/01–11/01");
    expect(tip).toContain("6 killed, 40 injured in total");
  });

  test("the controlling-side weekend tooltip quotes the report's 48-hour totals", async ({ page }) => {
    const tip = await tooltipAt(page, page.locator(SIDE), "10 Jan 2026");
    // 34 + 12 over two days → a daily average of 17 + 6.
    expect(tip).toMatch(/Total\s+23/);
    expect(tip).toContain("One 48-hour weekend report covering 10/01–11/01");
    expect(tip).toContain("34 Ukrainian-controlled, 12 Russian-controlled in total");
  });

  test("a day with no report is a gap, not a zero", async ({ page }) => {
    for (const selector of [KILLED_CARD, SIDE]) {
      const tip = await tooltipAt(page, page.locator(selector), "7 Jan 2026");
      expect(tip).toContain("No CIT report covers this day.");
      expect(tip).not.toMatch(/\s0(\s|$)/);
    }
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
