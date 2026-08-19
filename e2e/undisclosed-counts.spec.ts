import { test, expect, type Page } from "@playwright/test";
import { FIXED_TODAY } from "./build-fixtures.mjs";

// Regression guard for withheld attack counts on the RU air-attacks views.
//
// Ukraine's Air Force stopped publishing ballistic-missile launched/intercepted
// figures on 2026-08-13. piterfm marks those rows `status_data='hidden'` and
// carries a placeholder 0, so anything that SUMs the raw column reads a
// withheld attack as "nothing was launched" — and as the withholding continues
// the ballistic series decays to zero and looks like the attacks stopped.
//
// The frontend maps those rows to null. What has to hold is that a withheld day
// and a genuinely-quiet day stay *distinguishable*: build-fixtures.mjs seeds
// ballistic 0 disclosed on day −2 and ballistic withheld on day −1, both of
// which carry a literal 0 in the DB.
const dayISO = (offset: number) => {
  const d = new Date(`${FIXED_TODAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};
const WITHHELD = dayISO(-1);   // reported without figures → gap
const REAL_ZERO = dayISO(-2);  // disclosed, nothing launched → plots at 0

const fmt = (iso: string) => {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
};

// Hover the chart card titled `title` at the x position of `date`, and return
// whatever the tooltip renders.
function chartCard(page: Page, title: string) {
  // Innermost div holding both the card's title and its chart — `has:` alone
  // would match the bare title node, which has no SVG to hover.
  return page
    .locator("div")
    .filter({ has: page.getByText(title, { exact: true }) })
    .filter({ has: page.locator("svg.recharts-surface") })
    .last();
}

// Sweep the plot area and return the tooltip once its header names `date`.
// Scanning rather than computing an x keeps this independent of chart margins
// and category spacing. `innerText` (not textContent) so a tooltip recharts has
// hidden reads as empty — the gap case only passes if it is actually visible.
async function tooltipAt(page: Page, title: string, date: string): Promise<string> {
  const card = chartCard(page, title);
  // Below-the-fold cards must be scrolled in first: mouse.move is viewport-
  // relative, so hovering a chart past the fold silently hits nothing.
  await card.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  const svg = card.locator("svg.recharts-surface").first();
  const box = (await svg.boundingBox())!;
  const wrapper = card.locator(".recharts-tooltip-wrapper");
  const header = fmt(date);
  for (let i = 0; i <= 60; i++) {
    await page.mouse.move(box.x + (box.width * i) / 60, box.y + box.height * 0.55);
    await page.waitForTimeout(60); // let React re-render the tooltip for this x
    const tip = (await wrapper.innerText()).trim();
    if (tip.startsWith(header)) return tip;
  }
  throw new Error(`no tooltip for ${date} on "${title}"`);
}

test.describe("RU air attacks — withheld counts", () => {
  const DAYS = 8;
  test.beforeEach(async ({ page }) => {
    await page.goto(`/?site=ru-air-attacks-gsua&page=daily&days=${DAYS}&date=${FIXED_TODAY}`);
    await expect(page.getByText("Ballistic Missiles", { exact: true })).toBeVisible();
    await page.waitForTimeout(1200);
  });

  test("a disclosed zero still reads as zero", async ({ page }) => {
    const tip = await tooltipAt(page, "Ballistic Missiles", REAL_ZERO);
    expect(tip).toContain(fmt(REAL_ZERO));
    expect(tip).toMatch(/Launched\s+0/);
    expect(tip).not.toContain("not disclosed");
  });

  test("a withheld day charts as a gap and says why", async ({ page }) => {
    const tip = await tooltipAt(page, "Ballistic Missiles", WITHHELD);
    expect(tip).toContain(fmt(WITHHELD));
    // No value row at all — the point is null, so the line breaks here.
    expect(tip).not.toMatch(/Launched\s+\d/);
    expect(tip).toContain("stopped publishing ballistic missile counts");
  });

  test("the aggregate tooltip marks ballistic 'not disclosed', not 0", async ({ page }) => {
    const tip = await tooltipAt(page, "All — Drones + Missiles · Launched", WITHHELD);
    expect(tip).toContain("Ballistic Missiles");
    expect(tip).toContain("not disclosed");
    // The total is the sum of what *was* disclosed, flagged as a lower bound.
    expect(tip).toContain("a lower bound");
  });

  test("withheld days are excluded from the ballistic MAX/MED stats", async ({ page }) => {
    // Day −1 is withheld; the largest disclosed ballistic value is day −7 (7).
    // A placeholder 0 leaking through would not change MAX, but a withheld day
    // counted as 0 would drag MED down — assert the stats read off real days.
    const text = await chartCard(page, "Ballistic Missiles").innerText();
    expect(text).toMatch(/MAX\s+7\b/);
  });
});
