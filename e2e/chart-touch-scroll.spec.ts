import { test, expect, type Page } from "@playwright/test";

// Touch and the hover tooltip.
//
// recharts drives its tooltip from onTouchMove as well as onMouseMove, and has
// no touch counterpart to onMouseLeave — so a finger dragged across a chart on
// the way down the page used to leave a tooltip standing open over a chart the
// reader had already scrolled past, dismissable only by finding another chart
// to touch. Touch has the sheet instead; the hover card is for pointers that
// can actually hover.

test.use({ hasTouch: true });

const AIR = "/?site=ru-air-attacks-gsua&page=daily&days=7";
const ALL = "all-drones-missiles-launched";

const card = (p: Page, id: string) => p.locator(`.chart-card#${id}`);
const sheet = (p: Page) => p.locator(".chart-sheet[data-open]");

/** A finger pressed on the chart, dragged up the page, and lifted elsewhere.
 *  Playwright's touchscreen can only tap, so the gesture goes through CDP —
 *  which is what makes these real touch events (pointerType "touch") rather
 *  than dispatched ones the browser would never route to its own scroller. */
async function touchScroll(page: Page, x: number, y: number, dy: number) {
  const client = await page.context().newCDPSession(page);
  await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let i = 1; i <= 6; i++) {
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x, y: y + (dy * i) / 6 }],
    });
    await page.waitForTimeout(30);
  }
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await client.detach();
}

test.describe("Chart touch handling", () => {
  test("scrolling the page with a finger across a chart opens no tooltip", async ({ page }) => {
    await page.goto(AIR);
    await page.waitForSelector(".chart-card");
    const c = card(page, ALL);
    await c.scrollIntoViewIfNeeded();
    const box = (await c.locator("svg.recharts-surface").first().boundingBox())!;

    await touchScroll(page, box.x + box.width * 0.5, box.y + box.height * 0.6, -160);
    // recharts throttles its move handler and fires a trailing call, so the
    // tooltip this guards against can arrive after the finger is gone.
    await page.waitForTimeout(400);

    // `innerText`, not textContent: a wrapper recharts has merely hidden still
    // carries the markup of whatever it last rendered.
    expect((await c.locator(".recharts-tooltip-wrapper").innerText()).trim()).toBe("");
    await expect(sheet(page)).toBeHidden();
  });

  test("a tap still pins the point to the sheet", async ({ page }) => {
    await page.goto(AIR);
    await page.waitForSelector(".chart-card");
    const c = card(page, ALL);
    await c.scrollIntoViewIfNeeded();
    const box = (await c.locator("svg.recharts-surface").first().boundingBox())!;

    await page.touchscreen.tap(box.x + box.width * 0.9, box.y + box.height * 0.4);
    await expect(sheet(page)).toBeVisible();
    // The sheet is the whole affordance on touch: no second, floating copy of
    // the same numbers laid over the chart.
    expect((await c.locator(".recharts-tooltip-wrapper").innerText()).trim()).toBe("");
  });
});
