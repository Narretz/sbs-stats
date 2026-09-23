import { test, expect } from "@playwright/test";
import { FIXED_TODAY } from "./build-fixtures.mjs";

// The start-date field is derived, not state: it displays the start of the
// current window and picking a date commits the day count that implies. The
// arithmetic is unit-tested (daysBetweenInclusive in monthRange.test.ts); what
// these cases check is that the two directions are actually wired to the same
// window on a real page — including through the end-date stepper, where a
// derived start has to slide rather than stretch.

// No window reaches back past the start of the full-scale invasion.
const WAR_START = "2022-02-24";

// ISO date `offset` days from FIXED_TODAY (UTC math so DST can't shift it).
function dayISO(offset: number): string {
  const d = new Date(`${FIXED_TODAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

test.describe("Daily/hourly pages — window start date", () => {
  test("shows the start of the window the URL asked for", async ({ page }) => {
    await page.goto(`/?site=sbs&page=daily&days=7&date=${FIXED_TODAY}`);
    const start = page.locator('[data-testid="window-start"]');
    // Inclusive of both ends: a 7-day window ending today starts 6 days back.
    await expect(start).toHaveValue(dayISO(-6));
  });

  test("picking a start sets the time window to match", async ({ page }) => {
    await page.goto(`/?site=sbs&page=daily&days=7&date=${FIXED_TODAY}`);
    const start = page.locator('[data-testid="window-start"]');
    await start.fill(dayISO(-2));

    // 3 inclusive days, and it lands in the URL as `days` — there is no
    // `start` param, because there is nothing extra to store.
    await page.waitForFunction(() => /[?&]days=3(&|$)/.test(location.search));
    expect(new URL(page.url()).searchParams.has("start")).toBe(false);
    await expect(page.locator('[data-testid="day-range-custom"]')).toHaveValue("3");
    await expect(start).toHaveValue(dayISO(-2));
  });

  test("changing the time window moves the start", async ({ page }) => {
    await page.goto(`/?site=sbs&page=daily&days=7&date=${FIXED_TODAY}`);
    const custom = page.locator('[data-testid="day-range-custom"]');
    await custom.fill("14");
    await custom.press("Enter");
    await page.waitForFunction(() => /[?&]days=14(&|$)/.test(location.search));
    await expect(page.locator('[data-testid="window-start"]')).toHaveValue(dayISO(-13));
  });

  test("stepping the end date slides the window instead of stretching it", async ({ page }) => {
    // The case that distinguishes a derived start from a pinned one: with the
    // end date a day earlier, "next day" keeps the length and moves both ends.
    await page.goto(`/?site=sbs&page=daily&days=7&date=${dayISO(-1)}`);
    const start = page.locator('[data-testid="window-start"]');
    await expect(start).toHaveValue(dayISO(-7));

    await page.getByRole("button", { name: "End: next day" }).click();
    await page.waitForFunction((d) => location.search.includes(`date=${d}`), FIXED_TODAY);
    await expect(start).toHaveValue(dayISO(-6));
    await expect(page.locator('[data-testid="day-range-custom"]')).toHaveValue("7");
  });

  test("on the hourly page too", async ({ page }) => {
    await page.goto(`/?site=sbs&page=hourly&days=7&date=${FIXED_TODAY}`);
    await expect(page.locator('[data-testid="window-start"]')).toHaveValue(dayISO(-6));
  });

  test("the start steps a day at a time, growing and shrinking the window", async ({ page }) => {
    await page.goto(`/?site=sbs&page=daily&days=7&date=${FIXED_TODAY}`);
    const start = page.locator('[data-testid="window-start"]');
    const days = page.locator('[data-testid="day-range-custom"]');

    // The end stays put, so moving the start back lengthens the window — the
    // opposite reading to the end nav, where the length is what stays put.
    await page.getByRole("button", { name: "Start: previous day" }).click();
    await expect(days).toHaveValue("8");
    await expect(start).toHaveValue(dayISO(-7));

    await page.getByRole("button", { name: "Start: next day" }).click();
    await page.getByRole("button", { name: "Start: next day" }).click();
    await expect(days).toHaveValue("6");
    await expect(start).toHaveValue(dayISO(-5));
    await page.waitForFunction(() => /[?&]days=6(&|$)/.test(location.search));
  });

  test("the start can't step past the end, or before the data", async ({ page }) => {
    // A one-day window is the shortest there is: start and end are the same day.
    await page.goto(`/?site=sbs&page=daily&days=1&date=${FIXED_TODAY}`);
    await expect(page.locator('[data-testid="window-start"]')).toHaveValue(FIXED_TODAY);
    await expect(page.getByRole("button", { name: "Start: next day" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Start: previous day" })).toBeEnabled();

    // The other edge is the first day the dataset covers, which the control
    // publishes as its own `min` — read it from there rather than hard-coding
    // the fixture's first day. Park the window on it (rather than widening the
    // window to reach it, which would pad the charts with every day in
    // between) and there is nothing earlier to step to.
    const floor = await page.locator('[data-testid="window-start"]').getAttribute("min");
    expect(floor).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await page.goto(`/?site=sbs&page=daily&days=1&date=${floor}`);
    await expect(page.locator('[data-testid="window-start"]')).toHaveValue(floor!);
    await expect(page.getByRole("button", { name: "Start: previous day" })).toBeDisabled();
  });

  test("the end nav is labelled as one end of a pair, the homepage's as a date", async ({ page }) => {
    await page.goto(`/?site=sbs&page=daily&days=7&date=${FIXED_TODAY}`);
    await expect(page.locator(".page-controls-sticky")).toContainText("Start");
    await expect(page.locator(".page-controls-sticky")).toContainText("End");

    // On the homepage there is no second end to be one of, so "End" would read
    // as half of a pair that isn't there.
    await page.goto("/");
    await page.getByRole("button", { name: "Date: next day" }).waitFor();
    await expect(page.getByRole("button", { name: /End:/ })).toHaveCount(0);
  });

  test("an absurd `days` in the URL is capped at the floor", async ({ page }) => {
    // Measured against an end date near the floor, so the assertion doesn't
    // cost a chart per day back to 2022.
    await page.goto("/?site=sbs&page=daily&days=99999&date=2022-03-01");
    await expect(page.locator('[data-testid="window-start"]')).toHaveValue(WAR_START);
    await expect(page.locator('[data-testid="day-range-custom"]')).toHaveValue("6");
  });

  test("moving the end earlier shortens the window rather than crossing the floor", async ({ page }) => {
    await page.goto("/?site=sbs&page=daily&days=30&date=2022-04-01");
    const start = page.locator('[data-testid="window-start"]');
    await expect(start).toHaveValue("2022-03-03");

    // The window is measured back from its end, so this would have dragged the
    // start to 2022-01-28.
    await page.getByLabel("End", { exact: true }).fill("2022-02-26");
    await expect(page.locator('[data-testid="day-range-custom"]')).toHaveValue("3");
    await expect(start).toHaveValue(WAR_START);
    await page.waitForFunction(() => /[?&]days=3(&|$)/.test(location.search));
  });

  test("the end date stops at the floor too, and offers no window longer than it", async ({ page }) => {
    await page.goto(`/?site=sbs&page=daily&days=1&date=${WAR_START}`);
    await expect(page.getByLabel("End", { exact: true })).toHaveAttribute("min", WAR_START);
    await expect(page.getByRole("button", { name: "End: previous day" })).toBeDisabled();

    // Every preset (7d and up) reaches back past the floor from here, so none
    // is listed — only the custom value the window actually holds.
    const presets = await page.locator('[data-testid="day-range"] option').allTextContents();
    expect(presets).toEqual(["1d"]);
  });

  test("the homepage's per-chart windows are bounded too", async ({ page }) => {
    // No start field there, but the same floor: the window is what gets
    // fetched and padded, whether or not a control shows both of its ends.
    await page.goto("/?date=2022-03-01&charts=Chart%201:d99999:sbs.flights_strike");
    await expect(page.locator('[data-testid="day-range-custom"]').first()).toHaveValue("6");
  });

  test("the homepage's per-chart pickers have no start field", async ({ page }) => {
    // Those windows always end today and live inside the `charts=` spec, so a
    // start date would mean something different there — deliberately out of
    // scope, and the prop that turns the field on is simply not passed.
    await page.goto("/");
    await page.locator('[data-testid="day-range-custom"]').first().waitFor();
    await expect(page.locator('[data-testid="window-start"]')).toHaveCount(0);
  });
});
