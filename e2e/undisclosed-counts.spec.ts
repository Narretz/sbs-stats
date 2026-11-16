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
//
// What the queries make of those rows — the gap, the flags, the lower bound,
// the stats over disclosed days — is src/data/ruAirAttacksDb.test.ts. These
// two hovers are for it reaching the screen, with the notes that explain it.
const dayISO = (offset: number) => {
  const d = new Date(`${FIXED_TODAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};
const WITHHELD = dayISO(-1);   // reported without figures → gap
const INTERCEPTS_ONLY = dayISO(-3); // a withheld report that gave its intercepts

// Tooltip headers are the ISO date itself (utils/dateFormat).
const fmt = (iso: string) => iso;

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

  test("a withheld day charts as a gap and says why", async ({ page }) => {
    const tip = await tooltipAt(page, "Ballistic Missiles", WITHHELD);
    expect(tip).toContain(fmt(WITHHELD));
    // No value row at all — the point is null, so the line breaks here.
    expect(tip).not.toMatch(/Launched\s+\d/);
    expect(tip).toContain("stopped publishing ballistic missile counts");
  });

  test("a withheld report's intercepts count, launched as a lower bound", async ({ page }) => {
    // 3 launched / 1 down disclosed, plus a withheld report of 2 shot down.
    const tip = await tooltipAt(page, "Ballistic Missiles", INTERCEPTS_ONLY);
    expect(tip).toMatch(/Launched\s+5/);
    expect(tip).toContain("Launched is a lower bound");
    // The withheld model row reads "≥ 2" (share 40%), then its 2 intercepts —
    // and no rate after them, which over a lower bound would be fiction.
    expect(tip).toMatch(/C-400 and Iskander-M\s+≥ 2\s+40\.0%\s+2\s+⚠/);
  });
});
