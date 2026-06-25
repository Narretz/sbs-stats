import { test, expect, type Page } from "@playwright/test";

// The fixtures inject a partial "today" at the real current date (see
// e2e/build-fixtures.mjs), so the app emits the projection without clock mocking.
// Hover the rightmost (today) point of the Nth chart and return the tooltip text
// once it contains the EoD estimate. Retries to absorb tooltip/animation timing.
async function eodTooltip(page: Page, chartIndex: number): Promise<string> {
  await page.waitForSelector(".recharts-surface");
  await page.waitForTimeout(700);
  // Scope to THIS chart's wrapper — there's one .recharts-tooltip-wrapper per
  // chart, so an unscoped locator would always read chart 0's tooltip.
  const wrapper = page.locator(".recharts-wrapper").nth(chartIndex);
  await wrapper.scrollIntoViewIfNeeded();
  const box = await wrapper.boundingBox();
  if (!box) return "";
  const tip = wrapper.locator(".recharts-tooltip-wrapper");
  const eodCount = (s: string) => (s.match(/EoD est/g) ?? []).length;
  // Scan right→left: the first point that yields a tooltip is the rightmost one
  // (today). Probe a few heights since area charts only react over the fill.
  for (let attempt = 0; attempt < 2; attempt++) {
    for (let x = box.x + box.width - 4; x > box.x + box.width * 0.55; x -= 3) {
      for (const yf of [0.6, 0.78, 0.9]) {
        await page.mouse.move(x, box.y + box.height * yf);
        await page.waitForTimeout(60);
        if (!(await tip.count())) continue;
        let txt = (await tip.innerText()).trim();
        if (!txt) continue;
        // Let the tooltip finish painting; keep the read with the most EoD rows.
        for (let k = 0; k < 3; k++) {
          await page.waitForTimeout(70);
          const t = (await tip.innerText()).trim();
          if (eodCount(t) > eodCount(txt)) txt = t;
        }
        return txt;
      }
    }
    await page.mouse.move(box.x - 5, box.y - 50); // clear hover, then retry
    await page.waitForTimeout(150);
  }
  return "";
}

// "/" lands on the Custom-charts homepage; per-site views are reached via
// the ?site=…&page=… URL params. Tests deep-link to bypass home → site.
const SBS_DAILY = "/?site=sbs&page=daily";
const SBS_HOURLY = "/?site=sbs&page=hourly";
const GSUA_DAILY = "/?site=ru-attacks-gsua&page=daily";
const GSUA_HOURLY = "/?site=ru-attacks-gsua&page=hourly";

test.describe("End-of-day projection", () => {
  test("SBS daily — single-series tooltip shows a projected value", async ({ page }) => {
    await page.goto(SBS_DAILY);
    const txt = await eodTooltip(page, 0); // Personnel Casualties (full-width, single line)
    expect(txt).toMatch(/EoD est/);
    expect(txt).toMatch(/~[\d,]+/);   // a projected number
    expect(txt).toMatch(/\(\d+%\)/);  // completion share
  });

  test("SBS daily — paired chart projects both series", async ({ page }) => {
    await page.goto(SBS_DAILY);
    const txt = await eodTooltip(page, 2); // Targets — Hit / Destroyed
    expect((txt.match(/EoD est/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  test("SBS daily — hovered card is elevated so the tooltip isn't clipped", async ({ page }) => {
    await page.goto(SBS_DAILY);
    await eodTooltip(page, 1); // leaves the mouse hovering this card
    const z = await page.evaluate(() => {
      const el = document.querySelector(".chart-card:hover");
      return el ? getComputedStyle(el).zIndex : null;
    });
    // theme.ts: `.chart-card:hover { z-index: 2; }` — enough to sit above the
    // sibling `.chart-card { z-index: 1; }` whose top edge would otherwise
    // paint over the hover-card's tooltip.
    expect(z).toBe("2");
  });

  test("SBS hourly — tooltip header shows the EoD estimate", async ({ page }) => {
    await page.goto(SBS_HOURLY);
    const txt = await eodTooltip(page, 0);
    expect(txt).toMatch(/TODAY EoD est ~[\d,]+ \(\d+% in by \d{2}:\d{2}\)/);
  });

  test("GSUA ru-attacks daily — single-series tooltip shows a projected value", async ({ page }) => {
    await page.goto(GSUA_DAILY);
    const txt = await eodTooltip(page, 0); // Combat Engagements
    expect(txt).toMatch(/EoD est/);
    expect(txt).toMatch(/~[\d,]+/);
    expect(txt).toMatch(/\(\d+%\)/);
  });

  test("GSUA ru-attacks hourly — tooltip header shows the EoD estimate", async ({ page }) => {
    await page.goto(GSUA_HOURLY);
    const txt = await eodTooltip(page, 0);
    expect(txt).toMatch(/TODAY EoD est ~[\d,]+ \(\d+% in by \d{2}:\d{2}\)/);
  });
});
