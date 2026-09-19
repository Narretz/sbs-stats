import { test, expect, type Page } from "@playwright/test";

// Walking from a site page to the homepage must not consume or strip that
// page's params.
//
// `?days=` is written by every daily and hourly site view as its time window,
// and WAS the homepage's own setting before windows became per-chart. The
// homepage went on reading it as that: going home deletes only `site` /
// `page` / `view`, so a site page's window arrived looking exactly like a
// homepage link from back then. It silently retuned every curated daily chart
// to that window, then deleted the param as migrated. `weekdays` and `months`
// were untouched, which is what made the loss look arbitrary rather than like
// a rule. The homepage no longer reads `days` at all.

// 45 rather than one of the picker's presets on purpose: the JSON default is
// 60, and a window that lands on the default produces the default chart list —
// which serializes no `charts=` param at all, so the assertions below would
// pass whether or not the param was consumed.
const WINDOW = "45";
const HOME = 'button[title="Home"]';

async function gotoHourly(page: Page, search: string): Promise<void> {
  await page.goto(`/?site=sbs&page=hourly&${search}`);
  await page.locator(HOME).waitFor();
}

// The windows of the charts the homepage renders, read off its own URL. Absent
// until something makes the chart list non-default — which is the point: a
// legacy seed does, a site page's leftover param must not.
function chartWindows(page: Page): string[] {
  const charts = new URL(page.url()).searchParams.get("charts") ?? "";
  return charts.split(";").flatMap((c) => c.match(/:(d\d+|m\d+|mall):/)?.[1] ?? []);
}

test.describe("Site-page params survive the trip home", () => {
  test("the time window is still on the URL after going home", async ({ page }) => {
    await gotoHourly(page, `days=${WINDOW}&weekdays=1,2&months=6`);
    await page.locator(HOME).click();

    const p = new URL(page.url()).searchParams;
    expect(p.get("site")).toBeNull();
    // The three page params behave alike — the whole complaint was that one of
    // them didn't.
    expect(p.get("days")).toBe(WINDOW);
    expect(p.get("weekdays")).toBe("1,2");
    expect(p.get("months")).toBe("6");
  });

  test("it does not retune the homepage's curated charts", async ({ page }) => {
    // The damaging half, and the silent one: the param was consumed as a
    // legacy homepage-wide window before it was deleted.
    await gotoHourly(page, `days=${WINDOW}`);
    await page.locator(HOME).click();
    await page.locator('button:has-text("metric")').first().waitFor();

    expect(chartWindows(page)).not.toContain(`d${WINDOW}`);
  });

  test("and comes back with you", async ({ page }) => {
    await gotoHourly(page, `days=${WINDOW}`);
    await page.locator(HOME).click();
    await page.locator('button:has-text("metric")').first().waitFor();

    await page.getByTestId("site-picker").selectOption("sbs");
    await page.getByTestId("nav-hourly").click();
    await expect(page.locator('[data-testid="day-range-custom"]').first()).toHaveValue(WINDOW);
  });

  test("the homepage ignores a days param it is opened with", async ({ page }) => {
    // Not just when it arrives from a site page: `days` is not a homepage
    // setting, so it does nothing here however it got here — it neither moves
    // a chart's window nor gets cleared away.
    await page.goto(`/?days=${WINDOW}`);
    await page.locator('button:has-text("metric")').first().waitFor();

    expect(chartWindows(page)).not.toContain(`d${WINDOW}`);
    expect(new URL(page.url()).searchParams.get("days")).toBe(WINDOW);
  });
});
