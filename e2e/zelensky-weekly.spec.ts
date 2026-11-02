import { test, expect, type Page } from "@playwright/test";

// The weekly tally page: three weekly bar charts off the `weekly` view. What
// has to reach the screen is what the bar height can't say on its own — the
// source's hedge on each figure, and that an empty week was never reported
// (not a quiet week). Week headers below are build-fixtures.mjs's
// ZELENSKY_WEEKS: full tally, no post, drones only.
const DRONES = "RU Strike Drones Launched";
const BOMBS = "RU Guided Aerial Bombs (KAB)";

function chartCard(page: Page, title: string) {
  return page
    .locator("div")
    .filter({ has: page.getByText(title, { exact: true }) })
    .filter({ has: page.locator("svg.recharts-surface") })
    .last();
}

// Sweep the plot area until the tooltip header names the week.
async function tooltipAt(page: Page, title: string, header: string): Promise<string> {
  const card = chartCard(page, title);
  await card.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  const box = (await card.locator("svg.recharts-surface").first().boundingBox())!;
  const wrapper = card.locator(".recharts-tooltip-wrapper");
  for (let i = 0; i <= 60; i++) {
    await page.mouse.move(box.x + (box.width * i) / 60, box.y + box.height * 0.55);
    await page.waitForTimeout(60);
    const tip = (await wrapper.innerText()).trim();
    if (tip.startsWith(header)) return tip;
  }
  throw new Error(`no tooltip for ${header} on "${title}"`);
}

test.describe("Zelensky weekly tally", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?site=zelensky-weekly&page=weekly");
    await expect(page.getByText(DRONES, { exact: true })).toBeVisible();
    await page.waitForTimeout(800);
  });

  test("renders one chart per weapon", async ({ page }) => {
    for (const title of [DRONES, BOMBS, "RU Missiles Launched"]) {
      await expect(page.getByText(title, { exact: true })).toBeVisible();
    }
  });

  test("the tooltip quotes the figure as hedged in the post", async ({ page }) => {
    const tip = await tooltipAt(page, DRONES, "2026-01-05/11");
    expect(tip).toContain("as posted: > 1,000");
  });

  test("a week with no post says so, rather than reading as zero", async ({ page }) => {
    const tip = await tooltipAt(page, DRONES, "2026-01-12/18");
    expect(tip).toContain("no weekly tally posted");
    expect(tip).not.toMatch(/Actual\s+0/);
  });

  test("a weapon the week's post didn't name is 'not reported'", async ({ page }) => {
    const tip = await tooltipAt(page, BOMBS, "2026-01-19/25");
    expect(tip).toContain("as posted: not reported");
  });

  // A pinned week links the post its figures were read from; the label
  // formatting is zelenskyWeekly.test.ts.
  test("a pinned week links its Telegram post", async ({ page }) => {
    const card = chartCard(page, DRONES);
    await card.scrollIntoViewIfNeeded();
    const svg = card.locator("svg.recharts-surface").first();
    const box = (await svg.boundingBox())!;
    const sheet = page.locator(".chart-sheet[data-open]");
    for (let i = 1; i <= 30; i++) {
      await svg.click({ position: { x: (box.width * i) / 30, y: box.height * 0.55 } });
      if ((await sheet.count()) && (await sheet.innerText()).includes("2026-01-05/11")) break;
    }
    await expect(sheet).toContainText("2026-01-05/11");
    const sources = sheet.locator(".chart-sheet-sources");
    await sources.getByRole("button", { name: /Sources \(1\)/ }).click();
    await expect(sources.locator("a").first()).toHaveAttribute("href", "https://t.me/V_Zelenskiy_official/1");
    await expect(sources.locator("a").first()).toHaveText(/^2026-01-11 10:00 Kyiv ↗$/);
  });
});

// The monthly roll-up: weeks' daily averages summed per month. The fixture's
// two tallies both fall in January, so its drones are their sum, and bombs —
// named in one week only — cover 7 of its 31 days. The split of a week across
// two months is zelenskyWeekly.test.ts.
test.describe("Zelensky monthly roll-up", () => {
  test("a month sums its weeks and says how many days they cover", async ({ page }) => {
    await page.goto("/?site=zelensky-weekly&page=monthly");
    await expect(page.getByText(DRONES, { exact: true })).toBeVisible();
    await page.waitForTimeout(800);
    const drones = await tooltipAt(page, DRONES, "2026-01");
    expect(drones).toMatch(/Actual\s+2,200/);
    expect(drones).toContain("14 of 31 days");
    // A past month short of days is flagged, not read as a quiet month.
    expect(drones).toContain("Undercounted");
    const bombs = await tooltipAt(page, BOMBS, "2026-01");
    expect(bombs).toMatch(/Actual\s+900/);
    expect(bombs).toContain("7 of 31 days");
  });
});
