import { test, expect, type Page, type Locator } from "@playwright/test";

// The pin sheet is wired once in usePinnedChart, but each chart family reaches
// it differently: bar charts resolve a click to a category band, the hourly
// overlay has a *numeric* x-axis (so the pin stores a number, not a date
// string), and the stacked direction chart carries one bar per direction. This
// covers one chart of each family end to end; the fine-grained behaviour lives
// in chart-pin-sheet.spec.ts.

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

test("monthly bar chart pins and marks the bar", async ({ page }) => {
  // Not the SBS monthly page: its fixture is seven days inside one month and
  // renders no bars at all, so a click there would prove nothing.
  await page.goto("/?site=ru-attacks-gsua&page=monthly");
  await page.waitForSelector(".chart-card");
  const card = page.locator(".chart-card#combat-engagements");
  await pin(page, card, 0.3);
  await expect(page.locator(".chart-sheet-title")).toHaveText("Combat Engagements");
  expect(await hasCursor(card)).toBe(true);

  // The monthly fixtures hold a single month (the seven-day source window sits
  // inside one), so this is the degenerate end of the "never wraps" rule:
  // a lone point has nowhere to step in either direction. Multi-point stepping
  // for this code path is covered on the daily chart.
  await expect(page.getByLabel("Previous point")).toBeDisabled();
  await expect(page.getByLabel("Next point")).toBeDisabled();
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

test("the hourly sheet keeps the header's stats, which only the card had room for", async ({ page }) => {
  // The sheet used to skip the descriptor's header on the grounds that its
  // stepper already shows the x. That holds only while a header IS the x: the
  // hourly one also carries the hour's median across the window and how far the
  // current day sits from it, and pinning the chart dropped both.
  await page.goto("/?site=sbs&page=hourly");
  await page.waitForSelector(".hourly-card");
  const card = page.locator(".hourly-card").first();

  const svg = card.locator("svg.recharts-surface").first();
  const box = (await svg.boundingBox())!;
  await svg.hover({ position: { x: box.width * 0.58, y: box.height * 0.5 } });
  await svg.hover({ position: { x: box.width * 0.6, y: box.height * 0.5 } });
  const hover = await page.locator(".recharts-tooltip-wrapper > div > div").first().textContent();
  // One line in the card, exactly as before the split.
  expect(hover).toMatch(/^\d{2}:00–\d{2}:59 · med [\d,]+ · cur /);

  await pin(page, card);
  await expect(label(page)).toHaveText(/^(00:00|\d{2}:00–\d{2}:59)$/);
  await expect(sheet(page)).toContainText(/med [\d,]+ · cur .* vs med/);
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

test("the hourly tooltip's date list wraps instead of running off the screen", async ({ page }) => {
  // One row per day in the window, so a 120-day window is a 120-row list. In
  // the sheet it wraps against the sheet's own height; a floating tooltip is
  // positioned rather than laid out, so nothing above it bounds anything — and
  // an unbounded column-direction wrap never wraps. It ran off the bottom of
  // the window as one very long column.
  //
  // The fixture is seven days, so the bound is brought to the list rather than
  // the other way round: part of the cap is `vh`, so a short viewport shrinks
  // it until seven rows no longer fit in a single column.
  await page.setViewportSize({ width: 1280, height: 220 });
  await page.goto("/?site=sbs&page=hourly");
  await page.waitForSelector(".hourly-card");

  const svg = page.locator(".hourly-card svg.recharts-surface").first();
  await svg.scrollIntoViewIfNeeded();
  const box = (await svg.boundingBox())!;
  const list = page.getByTestId("hourly-tooltip-days");
  const columns = list.locator("> div");
  const rows = list.locator("> div > div");

  // The fixture's days are sampled at a handful of checkpoint hours, and the
  // hours in between are null for every series — where recharts raises an empty
  // tooltip. So sweep for a band that has values rather than hard-coding an x
  // fraction that would only be right for one axis width. (Two moves minimum
  // anyway: the card admits the hover card only once it has seen a pointer that
  // can genuinely hover — see usePinnedChart.)
  for (const f of [0.6, 0.62, 0.58, 0.64, 0.56, 0.5, 0.44, 0.7, 0.76, 0.82, 0.9]) {
    await svg.hover({ position: { x: box.width * f, y: box.height * 0.5 } });
    if (await rows.count() > 0) break;
  }

  await expect(list).toBeVisible();
  expect(await rows.count()).toBeGreaterThan(4);
  expect(await columns.count()).toBeGreaterThan(1);

  // Bounded by its own cap — 46vh of a 220px viewport — rather than by the
  // window happening to be tall enough.
  const listBox = (await list.boundingBox())!;
  expect(listBox.height).toBeLessThanOrEqual(220 * 0.46 + 1);

  // And the card is as wide as the columns it holds. This is the half of it
  // that a wrapping flex box could not deliver: its max-content width measures
  // one column in some engines, so the card was sized to its header line and
  // the columns past the third hung outside the border.
  const card = page.locator(".recharts-tooltip-wrapper > div").first();
  const cardBox = (await card.boundingBox())!;
  const rowsRight = await rows.evaluateAll((els) =>
    Math.max(...els.map((el) => el.getBoundingClientRect().right)));
  expect(rowsRight).toBeLessThanOrEqual(cardBox.x + cardBox.width);
});
