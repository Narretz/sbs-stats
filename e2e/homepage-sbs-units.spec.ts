import { test, expect, type Page } from "@playwright/test";

// SBS sub-units in the homepage's combined charts.
//
// The thing most worth pinning here is a non-functional property: the picker
// must NOT render one row per (unit x metric). 15 units x 89 metrics is 1,335
// rows, in a list that is rendered per chart on the page. The group is a unit
// <select> plus one shared metric list instead, so switching units must change
// WHICH metrics the checkboxes point at without changing how many there are.
//
// Fixture units: Alpha Unit (~100), Bravo Unit (~200), Gone Unit (retired).
// See e2e/build-fixtures.mjs.

async function openHome(page: Page) {
  await page.goto("/");
  await page.locator('button:has-text("metric")').first().waitFor();
}

// Sub-unit metrics are monthly-only, so the first chart has to be switched
// before the group appears.
async function firstChartToMonthly(page: Page) {
  await page.locator("select").filter({ hasText: "Daily" }).first().selectOption("monthly");
  await page.waitForTimeout(300);
}

async function openFirstPicker(page: Page) {
  await page.locator('button:has-text("metric")').first().click();
  const pop = page.locator("[popover]:popover-open");
  await pop.waitFor({ state: "visible" });
  return pop;
}

test.describe("Homepage — SBS sub-unit metrics", () => {
  test("the units DB is not fetched until a picker is opened", async ({ page }) => {
    const fetched: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes(".db")) fetched.push(r.url().split("/").pop() ?? "");
    });

    await openHome(page);
    await page.waitForTimeout(1200);
    // Most visits never touch a sub-unit, and this DB grows every month — so
    // it must not be on the homepage's critical path.
    expect(fetched.some((f) => f.startsWith("sbs-units"))).toBe(false);

    await firstChartToMonthly(page);
    await openFirstPicker(page);
    await expect.poll(() => fetched.some((f) => f.startsWith("sbs-units"))).toBe(true);
  });

  test("the group lists units and its size is independent of how many there are", async ({ page }) => {
    await openHome(page);
    await firstChartToMonthly(page);
    const pop = await openFirstPicker(page);

    const unitSelect = pop.getByTestId("metric-picker-unit");
    await unitSelect.waitFor();
    const unitOptions = await unitSelect.locator("option").allTextContents();
    expect(unitOptions.join("|")).toContain("Alpha Unit");
    expect(unitOptions.join("|")).toContain("Gone Unit (retired)");
    // A unit with no stored months isn't offered — same rule as the SBS page.
    expect(unitOptions.join("|")).not.toContain("Empty Unit");

    // THE property: switching unit must not add rows.
    const before = await pop.locator("label").count();
    await unitSelect.selectOption("bravo-unit");
    await page.waitForTimeout(250);
    expect(await pop.locator("label").count()).toBe(before);
  });

  test("a sub-unit metric charts that unit's data and lands in the URL", async ({ page }) => {
    await openHome(page);
    await firstChartToMonthly(page);
    const pop = await openFirstPicker(page);

    // Clear the defaults so the chart's axis reflects the unit alone.
    await pop.locator("button.ctl").filter({ hasText: "Clear all" }).click();
    await pop.getByTestId("metric-picker-unit").selectOption("alpha-unit");
    await pop.locator("label").filter({ hasText: /^Targets Hit$/ }).last().locator("input").check();
    await pop.locator("button.ctl").filter({ hasText: "Close" }).click();

    await expect
      .poll(() => /sbs-unit\.alpha-unit\.total_targets_hit/.test(decodeURIComponent(page.url())))
      .toBe(true);

    // Alpha Unit's three months are 100/101/102; the grouping's are ~5,000.
    // The first chart's own y-axis top is what proves the series was read from
    // the unit's rows rather than the grouping's. Scoped to that chart — the
    // page has others, one of which carries a percentage axis.
    await expect
      .poll(async () => {
        const ticks = await page
          .locator(".recharts-wrapper")
          .first()
          .locator(".recharts-yAxis .recharts-cartesian-axis-tick-value")
          .allTextContents();
        const nums = ticks.map((v) => Number(v.replace(/,/g, ""))).filter((n) => !Number.isNaN(n));
        return nums.length ? Math.max(...nums) : null;
      })
      .toBe(102);
  });

  test("a daily chart says why the group is empty instead of hiding it", async ({ page }) => {
    // The per-unit daily series exists in the DB but starts from the day the
    // ingest was switched on — there is no backfill for it — so charting it
    // today would draw a near-empty line.
    //
    // Omitting the group entirely is what made the feature feel missing rather
    // than inapplicable: the default chart granularity is daily, so that was
    // the first thing anyone saw.
    await openHome(page);
    const pop = await openFirstPicker(page);
    const group = pop.getByTestId("metric-picker-unit-group");
    await expect(group).toBeVisible();
    await expect(group).toContainText("Monthly charts only");
    await expect(pop.getByTestId("metric-picker-unit")).toHaveCount(0);
  });

  test("the group sits with SBS, not after the last source", async ({ page }) => {
    // It IS SBS data. At the end of the list it sat ~4,700px down a 460px-tall
    // popover, past every other source — unreachable in practice.
    await openHome(page);
    await firstChartToMonthly(page);
    const pop = await openFirstPicker(page);
    await pop.getByTestId("metric-picker-unit").waitFor();

    const headers = await pop.locator("div").evaluateAll((els) =>
      els
        .filter((e) => e.children.length === 0 && (e.textContent ?? "").trim().length > 0)
        .map((e) => (e.textContent ?? "").trim()),
    );
    const sbs = headers.indexOf("SBS");
    const unit = headers.indexOf("SBS sub-unit");
    expect(sbs).toBeGreaterThanOrEqual(0);
    expect(unit).toBeGreaterThan(sbs);
    // Directly after SBS — nothing else in between.
    expect(headers.slice(sbs + 1, unit)).not.toContain("GSUA");
  });

  test("searching a unit's name selects that unit", async ({ page }) => {
    // The group filters within one unit, so without this a search for "Fenix"
    // while another unit was active answered "No matches in this unit" — in
    // the one place someone hunting for a unit would look.
    await openHome(page);
    await firstChartToMonthly(page);
    const pop = await openFirstPicker(page);
    const unitSelect = pop.getByTestId("metric-picker-unit");
    await unitSelect.waitFor();

    await unitSelect.selectOption("alpha-unit");
    await pop.locator('input[placeholder="Search metrics…"]').fill("bravo");
    await expect(unitSelect).toHaveValue("bravo-unit");

    // Narrowing further keeps the unit and filters its metrics.
    await pop.locator('input[placeholder="Search metrics…"]').fill("bravo tanks");
    await expect(unitSelect).toHaveValue("bravo-unit");
    await expect
      .poll(async () => pop.getByTestId("metric-picker-unit-group").locator("label").count())
      .toBeLessThan(10);
  });
});
