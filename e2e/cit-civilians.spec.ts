import { test, expect, type Locator, type Page } from "@playwright/test";

// The CIT civilian-casualties pages, on build-fixtures.mjs's CIT_REPORTS: one
// December report, then 5–11 Jan 2026 with no report on Wed 7 Jan and ONE
// 48-hour weekend report for Sat 10 + Sun 11. What has to reach the screen is
// what the numbers alone can't say: the weekend is one report, drawn as one
// bar across both days, and the missing day is a gap rather than a zero.
// How the headline chart treats that bar — one entry, hovered and pinned as
// the report at its 48-hour figures — is CitHeadlineChart.browser.test.tsx.
const DAILY = "/?site=cit-civilians&page=daily&more=1&days=7&date=2026-01-11";
const MONTHLY = "/?site=cit-civilians&page=monthly";
const ALL_TITLE = "All civilian casualties";
// Chart cards by their anchor ids (ChartCardTitle slugifies the title).
const ALL = "#all-civilian-casualties";
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
    await expect(page.getByText(ALL_TITLE, { exact: true })).toBeVisible();
    await page.waitForTimeout(800);
  });

  test("renders the controlling-side chart, then the stacked headline chart", async ({ page }) => {
    const ids = await page.locator(".chart-card").evaluateAll((els) => els.map((e) => e.id));
    expect(ids).toEqual([SIDE.slice(1), ALL.slice(1)]);
    // Both are CitStackedChart, so both draw the median of their stack.
    await expect(page.locator(SIDE).getByText(/~ MED BOTH SIDES \d/)).toBeVisible();
    await expect(page.locator(ALL).getByText(/~ MED KILLED \+ INJURED \d/)).toBeVisible();
  });

  test("TOTAL counts the weekend report once, in either stat scope", async ({ page }) => {
    // All data: 5 (Dec) + 2 + 4 + 1 + 3 + 6 (weekend). Window: the January week.
    const killed = page.locator(ALL);
    await page.getByTestId("stat-scope-select").selectOption("all");
    await expect(killed.getByText("Σ TOTAL 21")).toBeVisible();
    await page.getByTestId("stat-scope-select").selectOption("window");
    await expect(killed.getByText("Σ TOTAL 16")).toBeVisible();
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

  test("the controlling-side weekend tooltip is the report, at its 48-hour totals", async ({ page }) => {
    const tip = await tooltipAt(page, page.locator(SIDE), "2026-01-10/11");
    // Total, then killed and injured, per side.
    expect(tip).toMatch(/Total\s+46\s+6\s+40/);
    expect(tip).toMatch(/Ukrainian-controlled\s+34\s+4\s+30/);
    expect(tip).toMatch(/Russian-controlled\s+12\s+2\s+10/);
    expect(tip).toMatch(/occupied Ukraine\s+5\s+1\s+4/);
  });
});

test.describe("CIT monthly page", () => {
  test("the controlling-side chart splits each month", async ({ page }) => {
    await page.goto(MONTHLY);
    const card = page.locator(SIDE);
    await expect(card).toBeVisible();
    // January: Ukrainian-controlled 8+18+10+12+34, Russian-controlled 4+6+0+6+12.
    const tip = await tooltipAt(page, card, "2026-01");
    // Killed: 2+3+1+2+4 and 2+2; injured: 6+15+9+10+30 and 13+11.
    expect(tip).toMatch(/Total\s+110\s+16\s+94/);
    expect(tip).toMatch(/Ukrainian-controlled\s+82\s+12\s+70/);
    expect(tip).toMatch(/Russian-controlled\s+28\s+4\s+24/);
  });

  test("the stacked headline chart sums each month's reports", async ({ page }) => {
    await page.goto(MONTHLY);
    await expect(page.locator(ALL)).toBeVisible();
    const ids = await page.locator(".chart-card").evaluateAll((els) => els.map((e) => e.id));
    expect(ids).toEqual([SIDE.slice(1), ALL.slice(1)]);
    // January's headline killed: 2+4+1+3+6 (the weekend report once).
    const tip = await tooltipAt(page, page.locator(ALL), "2026-01");
    expect(tip).toMatch(/Civilians killed\s+16/);
    expect(tip).toMatch(/Total\s+\d+/);
  });
});
