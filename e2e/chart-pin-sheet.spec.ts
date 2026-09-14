import { test, expect, type Page } from "@playwright/test";
import { FIXED_TODAY } from "./build-fixtures.mjs";

// The pinned-detail bottom sheet: click or tap a chart to pin one x-position,
// step it with ‹ ›, and read the same numbers the hover tooltip would show.
//
// Two of these carry most of the weight. "prev/next moves both" is what proves
// the selection is genuinely ours rather than recharts' internal hover state,
// and "a narrowed window drops the pin" is what proves the pin is keyed by
// date rather than by index — an index-keyed pin would silently slide onto a
// different day when the data underneath is replaced.

const dayISO = (offset: number) => {
  const d = new Date(`${FIXED_TODAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};
const fmt = (iso: string) => {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
};

const AIR = "/?site=ru-air-attacks-gsua&page=daily&days=7";
const sheet = (p: Page) => p.locator(".chart-sheet[data-open]");
const label = (p: Page) => p.locator(".chart-sheet-label");

// Every chart card already carries the deep-link slug as its `id`
// (ChartCardTitle → chartAnchor), which is a far steadier handle than the
// title text — and it is the same id the pin is keyed by.
function card(page: Page, id: string) {
  return page.locator(`.chart-card#${id}`);
}

// The day-range picker, identified by an option only it has.
function daysSelect(page: Page) {
  return page.locator("select").filter({ has: page.locator("option", { hasText: "90d" }) });
}

// Click the plot area of `title` at a fraction across its width. Vertical
// position is deliberately arbitrary: recharts resolves the click to the
// nearest x-band, so the whole plot is a hit target — which is the entire
// point on touch.
async function pinAt(page: Page, id: string, frac: number) {
  const c = card(page, id);
  await c.scrollIntoViewIfNeeded();
  const svg = c.locator("svg.recharts-surface").first();
  const box = (await svg.boundingBox())!;
  await svg.click({ position: { x: box.width * frac, y: box.height * 0.4 } });
  await expect(sheet(page)).toBeVisible();
}

// x-coordinate of the pinned cursor. The MED reference line is horizontal and
// the pinned one vertical, so orientation tells them apart without depending
// on stroke colour (which is theme-dependent).
async function cursorX(page: Page, id: string): Promise<number | null> {
  return card(page, id).locator(".recharts-reference-line line").evaluateAll((els) => {
    for (const el of els) {
      const x1 = Number(el.getAttribute("x1")), x2 = Number(el.getAttribute("x2"));
      const y1 = Number(el.getAttribute("y1")), y2 = Number(el.getAttribute("y2"));
      if (Math.abs(x1 - x2) < 0.5 && Math.abs(y1 - y2) > 1) return x1;
    }
    return null;
  });
}

// recharts activates a tooltip from mousemove, and one synthetic move can land
// before it has bound its handlers — nudge across a few pixels.
async function sweep(page: Page, x: number, y: number) {
  for (const dx of [-6, -3, 0, 3]) {
    await page.mouse.move(x + dx, y);
    await page.waitForTimeout(70);
  }
}

const ALL = "all-drones-missiles-launched";
const ALL_TITLE = "All — Drones + Missiles · Launched";
const DRONES = "drones";
const DRONES_TITLE = "Drones";

test.describe("Chart pin sheet", () => {
  test("clicking a point opens the sheet with that date's values", async ({ page }) => {
    await page.goto(AIR);
    await page.waitForSelector(".chart-card");
    await pinAt(page, ALL, 0.9);
    await expect(page.locator(".chart-sheet-title")).toHaveText(ALL_TITLE);
    // The last populated day in the fixture; 0.9 across a 7-day window lands on it.
    await expect(label(page)).toHaveText(fmt(dayISO(-1)));
    await expect(sheet(page)).toContainText("Launched");
  });

  test("prev/next moves the sheet date and the chart cursor together", async ({ page }) => {
    await page.goto(AIR);
    await page.waitForSelector(".chart-card");
    await pinAt(page, ALL, 0.5);
    const startLabel = await label(page).textContent();
    const startX = await cursorX(page, ALL);
    expect(startX).not.toBeNull();

    await page.getByLabel("Next point").click();
    const nextLabel = await label(page).textContent();
    const nextX = await cursorX(page, ALL);
    expect(nextLabel).not.toBe(startLabel);
    expect(nextX).not.toBeNull();
    // Both views of one piece of state: the cursor must have travelled, and to
    // the right, in step with the date.
    expect(nextX!).toBeGreaterThan(startX!);

    await page.getByLabel("Previous point").click();
    expect(await label(page).textContent()).toBe(startLabel);
    expect(await cursorX(page, ALL)).toBeCloseTo(startX!, 0);
  });

  test("the arrow keys step the pin, because focus lands in the sheet", async ({ page }) => {
    await page.goto(AIR);
    await page.waitForSelector(".chart-card");
    await pinAt(page, ALL, 0.5);
    // Guards the whole keyboard path: the sheet only receives these because
    // focus moved into it on open, which a CSS `visibility` transition can
    // silently prevent.
    await expect(page.locator(".chart-sheet")).toBeFocused();

    const start = await label(page).textContent();
    await page.keyboard.press("ArrowRight");
    expect(await label(page).textContent()).not.toBe(start);
    await page.keyboard.press("ArrowLeft");
    expect(await label(page).textContent()).toBe(start);
  });

  test("the stepper is disabled at both ends — it never wraps", async ({ page }) => {
    await page.goto(AIR);
    await page.waitForSelector(".chart-card");
    await pinAt(page, ALL, 0.5);
    const first = page.getByLabel("Previous point");
    const last = page.getByLabel("Next point");

    for (let i = 0; i < 12 && await first.isEnabled(); i++) await first.click();
    await expect(first).toBeDisabled();
    await expect(last).toBeEnabled();

    for (let i = 0; i < 12 && await last.isEnabled(); i++) await last.click();
    await expect(last).toBeDisabled();
    await expect(first).toBeEnabled();
  });

  test("a date with no data says so instead of rendering an empty sheet", async ({ page }) => {
    // A 90-day window over a 7-day fixture pads the leading dates to all-null
    // with no note attached — exactly the case that used to render nothing at
    // all, since recharts drops null points from the tooltip payload.
    await page.goto("/?site=ru-air-attacks-gsua&page=daily&days=90");
    await page.waitForSelector(".chart-card");
    await pinAt(page, ALL, 0.1);
    await expect(sheet(page)).toContainText("No data reported for this date.");
  });

  test("close: ✕, Escape and an outside click each dismiss; a second point re-selects", async ({ page }) => {
    await page.goto(AIR);
    await page.waitForSelector(".chart-card");

    await pinAt(page, ALL, 0.9);
    await page.getByLabel("Close details").click();
    await expect(sheet(page)).toBeHidden();

    await pinAt(page, ALL, 0.9);
    await page.keyboard.press("Escape");
    await expect(sheet(page)).toBeHidden();

    await pinAt(page, ALL, 0.9);
    await page.locator("h1").first().click();
    await expect(sheet(page)).toBeHidden();

    // Clicking elsewhere in the *same* chart is a re-selection, not a dismissal.
    await pinAt(page, ALL, 0.9);
    const before = await label(page).textContent();
    await pinAt(page, ALL, 0.3);
    await expect(sheet(page)).toBeVisible();
    expect(await label(page).textContent()).not.toBe(before);
  });

  test("pinning a second chart releases the first", async ({ page }) => {
    await page.goto(AIR);
    await page.waitForSelector(".chart-card");
    await pinAt(page, ALL, 0.9);
    expect(await cursorX(page, ALL)).not.toBeNull();

    await pinAt(page, DRONES, 0.5);
    await expect(page.locator(".chart-sheet-title")).toHaveText(DRONES_TITLE);
    // The first chart's pinned cursor is gone — only one pin exists at a time.
    expect(await cursorX(page, ALL)).toBeNull();
  });

  test("the pinned chart's hover tooltip goes quiet; other charts keep theirs", async ({ page }) => {
    await page.goto(AIR);
    await page.waitForSelector(".chart-card");
    await pinAt(page, ALL, 0.9);

    const c = card(page, ALL);
    const box = (await c.locator("svg.recharts-surface").first().boundingBox())!;
    await sweep(page, box.x + box.width * 0.5, box.y + box.height * 0.4);
    // `innerText`, not textContent: a tooltip recharts has hidden must read as
    // empty, or this passes on a tooltip that is merely invisible.
    expect((await c.locator(".recharts-tooltip-wrapper").innerText()).trim()).toBe("");

    const oc = card(page, DRONES);
    // The sheet occupies the bottom of the viewport, so a card left where
    // `scrollIntoViewIfNeeded` puts it can sit underneath it and swallow the
    // hover. Park this one at the top and aim high in its plot area.
    await oc.evaluate((el) => el.scrollIntoView({ block: "start" }));
    await page.waitForTimeout(300);
    const obox = (await oc.locator("svg.recharts-surface").first().boundingBox())!;
    const oy = obox.y + obox.height * 0.4;
    expect(await page.evaluate(([x, y]) => !document.elementFromPoint(x, y)?.closest(".chart-sheet"),
      [obox.x + obox.width * 0.5, oy])).toBe(true);
    await sweep(page, obox.x + obox.width * 0.5, oy);
    expect((await oc.locator(".recharts-tooltip-wrapper").innerText()).trim()).not.toBe("");
  });

  test("a pin survives a widened window and is dropped by one that excludes it", async ({ page }) => {
    await page.goto(AIR);
    await page.waitForSelector(".chart-card");
    await pinAt(page, ALL, 0.9);
    const pinned = await label(page).textContent();

    // Widening keeps the date in range: the pin follows it to a new index.
    await daysSelect(page).selectOption("90");
    await expect(sheet(page)).toBeVisible();
    expect(await label(page).textContent()).toBe(pinned);

    // Now pin an early padded date and narrow the window past it.
    await pinAt(page, ALL, 0.1);
    const early = await label(page).textContent();
    expect(early).not.toBe(pinned);
    await daysSelect(page).selectOption("7");
    await expect(sheet(page)).toBeHidden();
  });
});
