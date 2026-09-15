import { test, expect, type Page } from "@playwright/test";

// The unit picker on the SBS monthly page: it swaps the page's data source
// between the grouping total (sbs.db) and one sub-unit (sbs-units.db).
//
// The fixture (build-fixtures.mjs → SBS_UNITS) gives each case a distinct
// headline value, so a test can tell WHICH dataset is on screen without
// reading the title: the grouping is in the 5,000s, Alpha Unit around 100,
// Bravo Unit around 200, the retired Gone Unit around 50.
const MONTHLY = "/?site=sbs&page=monthly";
const SELECT = "sbs-unit-select";

async function gotoMonthly(page: Page, query = ""): Promise<void> {
  await page.goto(`${MONTHLY}${query}`);
  await page.getByTestId(SELECT).waitFor();
  // The registry populates the <select> a tick after the DB resolves.
  await expect(page.getByTestId(SELECT).locator("option")).not.toHaveCount(1);
}

// Every value rendered in a chart's MAX summary, as plain numbers.
async function maxValues(page: Page): Promise<number[]> {
  const body = await page.locator("body").innerText();
  return [...body.matchAll(/MAX\s+([\d,]+)/g)].map((m) => Number(m[1].replace(/,/g, "")));
}

test.describe("SBS monthly — unit filter", () => {
  test("lists active and retired units, and hides units with no data", async ({ page }) => {
    await gotoMonthly(page);
    const options = await page.getByTestId(SELECT).locator("option").allTextContents();

    expect(options[0]).toContain("all");
    expect(options.join("|")).toContain("Alpha Unit");
    expect(options.join("|")).toContain("Bravo Unit");
    // Retirement is derived from the ingest's `active` flag, and the label says
    // so rather than the unit being quietly dropped.
    expect(options.join("|")).toContain("Gone Unit (retired)");
    // A registry row with no stored months would render an empty page, so the
    // hook filters it out of the list entirely.
    expect(options.join("|")).not.toContain("Empty Unit");

    // Retired units sit in their own group, so a reader scanning the list
    // doesn't have to know which names stopped reporting.
    const groups = await page.getByTestId(SELECT).locator("optgroup").evaluateAll(
      (els) => els.map((e) => (e as HTMLOptGroupElement).label),
    );
    expect(groups).toEqual(["Units", "No longer reporting"]);
  });

  test("selecting a unit swaps the data, the title and the URL", async ({ page }) => {
    await gotoMonthly(page);
    // Grouping first: values are in the 5,000s.
    expect(Math.max(...(await maxValues(page)))).toBeGreaterThan(1000);

    await page.getByTestId(SELECT).selectOption("alpha-unit");
    await expect(page.locator("h1, h2").first()).toContainText("Alpha Unit");
    await expect(page).toHaveURL(/unit=alpha-unit/);
    // …and now nothing on the page is a grouping-sized number.
    await expect.poll(async () => Math.max(...(await maxValues(page)))).toBeLessThan(1000);

    // Switching again must re-query rather than keep the first unit's rows.
    await page.getByTestId(SELECT).selectOption("bravo-unit");
    await expect(page.locator("h1, h2").first()).toContainText("Bravo Unit");
    await expect.poll(async () => Math.max(...(await maxValues(page)))).toBeGreaterThan(150);
  });

  test("a unit in the URL is applied on load, and is linkable", async ({ page }) => {
    await gotoMonthly(page, "&unit=bravo-unit");
    await expect(page.getByTestId(SELECT)).toHaveValue("bravo-unit");
    await expect(page.locator("h1, h2").first()).toContainText("Bravo Unit");
  });

  test("returning to the grouping clears the param", async ({ page }) => {
    await gotoMonthly(page, "&unit=alpha-unit");
    await page.getByTestId(SELECT).selectOption("all");
    await expect(page).not.toHaveURL(/unit=/);
    await expect(page.locator("h1, h2").first()).toContainText("UA SBS Monthly Statistics");
  });

  test("an unknown unit falls back to the grouping instead of an empty page", async ({ page }) => {
    await gotoMonthly(page, "&unit=no-such-unit");
    await expect(page.getByTestId(SELECT)).toHaveValue("all");
    await expect(page).not.toHaveURL(/unit=/);
    expect(Math.max(...(await maxValues(page)))).toBeGreaterThan(1000);
  });

  test("a retired unit reports its coverage window, not today's", async ({ page }) => {
    await gotoMonthly(page, "&unit=gone-unit");
    // It has no daily rows, so the window falls back to its last month and the
    // freshness note says how far behind that is — true of a unit that stopped.
    const note = await page.getByText(/Data Availability/).first().innerText();
    expect(note).toMatch(/days behind/);
  });

  test("the picker is absent on pages with no unit data", async ({ page }) => {
    // The units DB is mounted only on the monthly page; the daily page reads the
    // grouping's intraday curve, which has no per-unit equivalent.
    await page.goto("/?site=sbs&page=daily");
    await page.locator(".recharts-wrapper").first().waitFor();
    await expect(page.getByTestId(SELECT)).toHaveCount(0);
  });
});
