import { test, expect, type Page } from "@playwright/test";

// The fixtures inject a partial "today" at the real current date (see
// e2e/build-fixtures.mjs), so the app emits the projection without clock mocking.
//
// What is left here is the WIRING — a hook's estimate reaching a rendered
// tooltip, once per tooltip shape and once per hook. The estimate itself (the
// completion curve, the sample floor, the settled-day cutoff) is arithmetic and
// lives in src/utils/eodProjection.test.ts, where a case costs a line rather
// than a hover probe.
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

test.describe("End-of-day projection", () => {
  test("SBS daily — single-series tooltip shows a projected value", async ({ page }) => {
    await page.goto(SBS_DAILY);
    const txt = await eodTooltip(page, 0); // Personnel Casualties (single line, full-width)
    expect(txt).toMatch(/EoD est/);
    expect(txt).toMatch(/~[\d,]+/);   // a projected number
    expect(txt).toMatch(/\(\d+%\)/);  // completion share
  });

  test("SBS daily — paired chart projects both series", async ({ page }) => {
    await page.goto(SBS_DAILY);
    const txt = await eodTooltip(page, 1); // Targets Hit / Destroyed (paired, collapsed subset)
    // A tooltip shape of its own: the collapsed-subset row carries ONE
    // "EoD est" label with both projections in its Value + Subset cells, so
    // this is not the single-series case with a different chart index.
    expect(txt).toMatch(/EoD est/);
    expect((txt.match(/~[\d,]+\s*\(\d+%\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  test("SBS daily — hovered card is elevated so the tooltip isn't clipped", async ({ page }) => {
    await page.goto(SBS_DAILY);
    await eodTooltip(page, 1); // leaves the mouse hovering this card
    const z = await page.evaluate(() => {
      const el = document.querySelector(".chart-card:hover");
      return el ? getComputedStyle(el).zIndex : null;
    });
    // src/styles/theme.css: `.chart-card:hover { z-index: 2; }` — enough to sit above the
    // sibling `.chart-card { z-index: 1; }` whose top edge would otherwise
    // paint over the hover-card's tooltip.
    expect(z).toBe("2");
  });

  test("SBS hourly — tooltip header shows the EoD estimate", async ({ page }) => {
    await page.goto(SBS_HOURLY);
    const txt = await eodTooltip(page, 0);
    expect(txt).toMatch(/TODAY (?:00:00|\d{2}:00–\d{2}:59): (?:n\/a|[\d,]+), EoD est ~[\d,]+ \(\d+% in by \d{2}:\d{2}\)/);
  });

  test("SBS hourly — each passed hour shows the estimate made at it", async ({ page }) => {
    // The fixture's today has readings at 00, 06, 10 and 14 against history
    // that is 50% in by 10:00 and 62% by 14:00.
    await page.goto(SBS_HOURLY);
    await page.waitForSelector(".hourly-card");
    const card = page.locator(".hourly-card").first();
    await card.scrollIntoViewIfNeeded();
    const svg = card.locator("svg.recharts-surface").first();
    const box = (await svg.boundingBox())!;
    await svg.click({ position: { x: box.width * 0.5, y: box.height * 0.5 } });
    const sheet = page.locator(".chart-sheet[data-open]");
    await expect(sheet).toBeVisible();
    const label = page.locator(".chart-sheet-label");

    // Step the pinned hour to `hh:00–hh:59`, from wherever the click landed.
    const stepTo = async (hh: number) => {
      for (let i = 0; i < 30; i++) {
        const cur = Number(((await label.textContent()) ?? "").slice(0, 2));
        if (cur === hh) return;
        await page.getByLabel(cur < hh ? "Next point" : "Previous point").click();
      }
      throw new Error(`could not step to ${hh}:00`);
    };

    await stepTo(10);
    await expect(sheet).toContainText(/TODAY 10:00–10:59: [\d,]+, EoD est ~[\d,]+ \(50% in by 10:00\)/);
    // No reading at 08:00, so no estimate — not 06:00's, and not the latest.
    await stepTo(8);
    await expect(sheet).toContainText(/TODAY 08:00–08:59: n\/a/);
    await expect(sheet).not.toContainText("EoD est");
    // Past the latest reading, the current estimate.
    await stepTo(18);
    await expect(sheet).toContainText(/TODAY 18:00–18:59: n\/a, EoD est ~[\d,]+ \(62% in by 14:00\)/);
  });

  test("GSUA ru-attacks daily — single-series tooltip shows a projected value", async ({ page }) => {
    await page.goto(GSUA_DAILY);
    const txt = await eodTooltip(page, 0); // Combat Engagements
    expect(txt).toMatch(/EoD est/);
    expect(txt).toMatch(/~[\d,]+/);
    expect(txt).toMatch(/\(\d+%\)/);
  });

  // No GSUA hourly case: it renders through the same header as SBS hourly
  // above, and GSUA's own hook is already proven wired by the daily one.
});
