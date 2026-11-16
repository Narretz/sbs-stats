import { test, expect, type Page } from "@playwright/test";

// Deep links to individual charts: `?site=…&page=…#<chart-slug>` opens the page
// scrolled to that chart.
//
// The interesting part is the timing, and that's what these guard. The browser
// can't honour the fragment itself: at load time the DB is still being fetched
// and no chart element exists yet, so the target id appears only after the page
// reports data. useChartHashScroll polls for it and then scrolls twice — recharts
// sizes its containers after mount, so cards above the target grow a moment
// later and a single scroll lands short.
//
// Runs against the SBS daily view because it's fixture-backed (see
// e2e/build-fixtures.mjs). The anchor mechanism lives in the shared chart-card
// components, so every dataset page gets the same behaviour.

// How far below the viewport top a scrolled-to card should sit: clear of the
// 52px sticky header and the sticky controls bar under it (.chart-card
// scroll-margin-top in src/styles/theme.css). Allow slack for the controls bar's height.
const MIN_CLEARANCE = 40;
const MAX_CLEARANCE = 200;

async function chartIds(page: Page): Promise<string[]> {
  return page.$$eval(".chart-card[id]", (els) => els.map((e) => e.id));
}

async function scrollY(page: Page): Promise<number> {
  return page.evaluate(() => Math.round(window.scrollY));
}

// Charts render only after the DB loads; the scroll follows. Wait for both.
async function loadCharts(page: Page, url: string) {
  await page.goto(url);
  await page.waitForSelector(".recharts-surface");
  await page.waitForTimeout(1200); // recharts settle + the hook's second pass
}

test.describe("Chart deep links", () => {
  test("a fragment scrolls to that chart, clear of the sticky header", async ({ page }) => {
    await loadCharts(page, "/?site=sbs&page=daily");
    const ids = await chartIds(page);
    // Every card has one (chartAnchor.test.ts has their shape), and no two
    // match — a duplicate would leave one of the two charts unreachable.
    expect(ids.length).toBeGreaterThan(3);
    expect(new Set(ids).size).toBe(ids.length);
    // A chart mid-page: far enough down to require scrolling, but with enough
    // content below it that the browser can actually seat it at the intended
    // offset. (The very last card can't be — see the next test.)
    const target = ids[Math.floor(ids.length / 2)];

    await loadCharts(page, `/?site=sbs&page=daily#${target}`);
    expect(await scrollY(page)).toBeGreaterThan(0);

    const box = await page.locator(`#${target}`).boundingBox();
    expect(box).not.toBeNull();
    // Visible, and not hidden behind the sticky chrome.
    expect(box!.y).toBeGreaterThanOrEqual(MIN_CLEARANCE);
    expect(box!.y).toBeLessThanOrEqual(MAX_CLEARANCE);
  });

  test("a fragment for the last chart still brings it into view", async ({ page }) => {
    // Near the document end the browser runs out of scroll before it can seat
    // the card at scroll-margin-top — it lands lower than the mid-page case.
    // That's correct; what matters is that it's on screen and not under the
    // sticky header.
    await loadCharts(page, "/?site=sbs&page=daily");
    const ids = await chartIds(page);
    const target = ids[ids.length - 1];

    await loadCharts(page, `/?site=sbs&page=daily#${target}`);
    const viewport = page.viewportSize()!;
    const box = await page.locator(`#${target}`).boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(MIN_CLEARANCE);
    expect(box!.y).toBeLessThan(viewport.height);
  });

  test("an unknown fragment leaves the page at the top", async ({ page }) => {
    await loadCharts(page, "/?site=sbs&page=daily#no-such-chart");
    expect(await scrollY(page)).toBe(0);
  });

  test("no fragment leaves the page at the top", async ({ page }) => {
    await loadCharts(page, "/?site=sbs&page=daily");
    expect(await scrollY(page)).toBe(0);
  });

  // The '#' affordance staying out of the title's text: ChartCardTitle.browser.test.tsx.

  test("clicking a chart title puts its deep link in the URL", async ({ page }) => {
    await loadCharts(page, "/?site=sbs&page=daily");
    const ids = await chartIds(page);
    const target = ids[ids.length - 1];

    await page.locator(`#${target} .chart-anchor`).click();
    await page.waitForTimeout(600); // smooth scroll
    expect(page.url()).toContain(`#${target}`);
    expect(await scrollY(page)).toBeGreaterThan(0);
  });
});
