import { test, expect, type Page, type Locator } from "@playwright/test";
import { FIXED_TODAY } from "./build-fixtures.mjs";

// The pin sheet is wired once in usePinnedChart, but each chart family reaches
// it differently: bar charts resolve a click to a category band, the hourly
// overlay has a *numeric* x-axis (so the pin stores a number, not a date
// string), and the stacked direction chart carries one bar per direction. This
// covers one chart of each family end to end, on a real page; the sheet's own
// behaviour (stepping, keys, closing, one pin at a time, a pin surviving new
// data) is src/components/ChartSheet.browser.test.tsx, and the hourly
// overlay's tooltip — its date list, its stats in the sheet — is
// HourlyLineChart.browser.test.tsx.

const sheet = (p: Page) => p.locator(".chart-sheet[data-open]");
const label = (p: Page) => p.locator(".chart-sheet-label");

async function pin(page: Page, card: Locator, frac = 0.6) {
  await card.scrollIntoViewIfNeeded();
  const svg = card.locator("svg.recharts-surface").first();
  const box = (await svg.boundingBox())!;
  await svg.click({ position: { x: box.width * frac, y: box.height * 0.5 } });
  await expect(sheet(page)).toBeVisible();
}

// The pinned cursor is the only *vertical* reference line on these charts
// (MAX/MED are horizontal), so orientation identifies it without depending on
// theme colours.
async function hasCursor(card: Locator): Promise<boolean> {
  return card.locator(".recharts-reference-line line").evaluateAll((els) =>
    els.some((el) => {
      const x1 = Number(el.getAttribute("x1")), x2 = Number(el.getAttribute("x2"));
      const y1 = Number(el.getAttribute("y1")), y2 = Number(el.getAttribute("y2"));
      return Math.abs(x1 - x2) < 0.5 && Math.abs(y1 - y2) > 1;
    }));
}

test("a daily line chart pins the clicked date, with its values", async ({ page }) => {
  await page.goto("/?site=ru-air-attacks-gsua&page=daily&days=7");
  const card = page.locator(".chart-card#all-drones-missiles-launched");
  await pin(page, card, 0.9);
  await expect(page.locator(".chart-sheet-title")).toHaveText("All — Drones + Missiles · Launched");
  // The last populated day in the fixture; 0.9 across a 7-day window lands on it.
  const d = new Date(`${FIXED_TODAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  await expect(label(page)).toHaveText(d.toISOString().slice(0, 10));
  await expect(sheet(page)).toContainText("Launched");
  expect(await hasCursor(card)).toBe(true);
});

test("monthly bar chart pins and marks the bar", async ({ page }) => {
  // GSUA's monthly page: its fixture covers the days its combat-engagements
  // bars are summed from, the case this family is about.
  await page.goto("/?site=ru-attacks-gsua&page=monthly");
  await page.waitForSelector(".chart-card");
  const card = page.locator(".chart-card#combat-engagements");
  await pin(page, card, 0.3);
  await expect(page.locator(".chart-sheet-title")).toHaveText("Combat Engagements");
  expect(await hasCursor(card)).toBe(true);
  // A month label, not a raw index; the stepper stopping at the ends is
  // ChartSheet.browser.test.tsx.
  await expect(label(page)).toHaveText(/^\d{4}-\d{2}$/);
  await expect(sheet(page)).toContainText("Actual");
});

test("the hourly overlay pins on its numeric x-axis", async ({ page }) => {
  await page.goto("/?site=sbs&page=hourly");
  await page.waitForSelector(".hourly-card");
  const card = page.locator(".hourly-card").first();
  await pin(page, card);
  // The pin stores a number here, not a YYYY-MM-DD string — the header proves
  // it resolved to a real hour band rather than falling through to a raw index.
  await expect(label(page)).toHaveText(/^(00:00|\d{2}:00–\d{2}:59)$/);
  expect(await hasCursor(card)).toBe(true);

  // 25 hour bands here, so stepping is real — and it steps a number, not a
  // date string.
  const before = await label(page).textContent();
  await page.getByLabel("Next point").click();
  expect(await label(page).textContent()).not.toBe(before);
});

test("the stacked direction chart pins and lists its directions", async ({ page }) => {
  await page.goto("/?site=ru-attacks-gsua&page=monthly");
  await page.waitForSelector(".chart-card");
  const card = page.locator(".chart-card#combat-engagements-composition-by-direction");
  await pin(page, card);
  await expect(sheet(page)).toContainText("Total");
  await expect(sheet(page)).toContainText(/direction/i);
});

test("the paired monthly chart pins", async ({ page }) => {
  await page.goto("/?site=ru-air-attacks-gsua&page=monthly");
  await page.waitForSelector(".chart-card");
  const card = page.locator(".chart-card#drones");
  await pin(page, card);
  await expect(sheet(page)).toContainText("Launched");
  expect(await hasCursor(card)).toBe(true);
});
