import { test, expect, type Page } from "@playwright/test";

// SBS sub-units as compare columns.
//
// They are modelled as a refinement of the `sbs` entity rather than as extra
// CompareEntityIds, so the whole canonical-row table applies to them with no
// per-unit mapping. These tests pin the parts of that which could silently
// regress: the URL token, the column's data actually coming from the unit, and
// the one row that must NOT inherit the grouping's answer.
//
// Only SBS columns are used — the fixture covers sbs.db and sbs-units.db, and
// the other two entities' DBs are not fixtured, so asserting on them would be
// asserting on whatever data happens to be on disk.
const ADD = "compare-add-column";

// Fixture values (e2e/build-fixtures.mjs): the grouping is in the 5,000s,
// Alpha Unit around 100, Bravo Unit around 200.
async function rowCells(page: Page, label: string): Promise<string[]> {
  const tr = page.locator("tbody tr").filter({ hasText: label }).first();
  await tr.waitFor();
  return (await tr.locator("td").allTextContents()).map((s) => s.replace(/\s+/g, " ").trim());
}

// "YYYY-MM" for the current Kyiv month, and for N months before it — the same
// arithmetic e2e/build-fixtures.mjs used to place the fixture's months.
function thisMonth(): string {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" }).slice(0, 7);
}

function monthsBack(n: number): string {
  const [y, m] = thisMonth().split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 - n, 1)).toISOString().slice(0, 7);
}

async function gotoCompare(page: Page, cols: string): Promise<void> {
  await page.goto(`/?view=compare&cols=${cols}`);
  await page.locator("tbody tr").first().waitFor();
}

test.describe("Compare — SBS sub-units", () => {
  test("the picker groups sub-units and separates the retired ones", async ({ page }) => {
    await page.goto("/?view=compare");
    await page.getByTestId(ADD).waitFor();
    await expect
      .poll(async () => page.getByTestId(ADD).locator("optgroup").count())
      .toBeGreaterThan(0);

    const groups = await page.getByTestId(ADD).locator("optgroup").evaluateAll(
      (els) => els.map((e) => (e as HTMLOptGroupElement).label),
    );
    expect(groups).toEqual(["UA SBS sub-units", "UA SBS sub-units — no longer reporting"]);

    const options = (await page.getByTestId(ADD).locator("option").allTextContents()).join("|");
    // The three entities stay at the top level, ungrouped.
    expect(options).toContain("UA SBS (USF)");
    expect(options).toContain("Alpha Unit");
    expect(options).toContain("Gone Unit (retired)");
    // A unit with no stored months would be an empty column.
    expect(options).not.toContain("Empty Unit");
  });

  test("adding a sub-unit writes a three-token column to the URL", async ({ page }) => {
    await page.goto("/?view=compare");
    await page.getByTestId(ADD).waitFor();
    await expect
      .poll(async () => page.getByTestId(ADD).locator("optgroup").count())
      .toBeGreaterThan(0);

    await page.getByTestId(ADD).selectOption("sbs:alpha-unit");
    await expect(page).toHaveURL(/cols=sbs(%3A|:)alpha-unit(%3A|:)\d{4}-\d{2}/);
    await expect(page.locator("thead th").nth(1)).toContainText("Alpha Unit");
  });

  test("a sub-unit column shows the unit's figures, not the grouping's", async ({ page }) => {
    const month = thisMonth();
    await gotoCompare(page, `sbs:${month},sbs:alpha-unit:${month},sbs:bravo-unit:${month}`);

    const headers = (await page.locator("thead th").allTextContents()).join("|");
    expect(headers).toContain("UA SBS (USF)");
    expect(headers).toContain("Alpha Unit");
    expect(headers).toContain("Bravo Unit");

    // [label, grouping, alpha, bravo] — each column reads its own source.
    // `total_targets_hit` is 5x the per-class figure in the fixture (see
    // sbsCell): grouping ~25,000, Alpha ~500, Bravo ~1,000. Parsed rather than
    // pattern-matched: every cell but the first carries a "(-98.0%)" suffix.
    //
    // Polled, not read once: the table renders its rows before the DBs resolve
    // — and sbs-units.db is fetched only once a unit column asks for it — so a
    // single read can catch em dashes. It did, but only under parallel load,
    // where the wait is long enough to lose the race.
    const engaged = async () =>
      (await rowCells(page, "All targets engaged")).slice(1).map(
        (c) => Number((c.match(/[\d,]+/)?.[0] ?? "").replace(/,/g, "")),
      );
    await expect.poll(async () => (await engaged()).filter((n) => n > 0).length).toBe(3);

    const cells = await engaged();
    expect(cells[0]).toBeGreaterThan(20000);
    expect(cells[1]).toBeGreaterThanOrEqual(500);
    expect(cells[1]).toBeLessThan(600);
    expect(cells[2]).toBeGreaterThanOrEqual(1000);
    expect(cells[2]).toBeLessThan(1100);
  });

  test("the headcount row stays empty for a sub-unit", async ({ page }) => {
    const month = thisMonth();
    await gotoCompare(page, `sbs:${month},sbs:alpha-unit:${month}`);

    const cells = await rowCells(page, "Unit size (personnel)");
    // No sub-unit publishes a headcount, and the grouping's figure describes
    // the whole branch — inheriting it would invite a per-capita reading
    // against the wrong denominator.
    expect(cells[1]).toContain("60,000");
    expect(cells[2]).toBe("—");
  });

  test("a pre-sub-unit link still resolves", async ({ page }) => {
    const month = thisMonth();
    await gotoCompare(page, `sbs:${month}`);
    await expect(page.locator("thead th").nth(1)).toContainText("UA SBS (USF)");
    const cells = await rowCells(page, "All targets engaged");
    expect(cells[1]).toMatch(/25,0\d\d/);
  });

  test("the 'Only in' section reads the unit, not the whole of SBS", async ({ page }) => {
    // Regression. Those rows were rendered from `snapshots[entity]` rather than
    // the column's own snapshot, so a sub-unit column in an "Only in SBS"
    // section silently showed the grouping's figure — the same number in both
    // columns, looking entirely plausible.
    //
    // The section only exists when two ENTITIES are in play (with one entity
    // the same counters move into the table proper), hence the Rubikon column.
    const month = thisMonth();
    await gotoCompare(page, `sbs:${month},sbs:alpha-unit:${month},rubikon:${month}`);

    await expect(page.getByText(/Only in .*SBS/)).toBeVisible();

    // `hit_21` (Shelters) is the one fixtured target no canonical row maps, so
    // it lands in the "Only in" section. Fixture: grouping 5,00x, Alpha 10x.
    const cells = await rowCells(page, "Shelters");
    expect(cells[1]).toMatch(/5,0\d\d/);
    expect(cells[2]).toMatch(/^10\d/);
    expect(cells[2]).not.toEqual(cells[1]);
    // Rubikon has no such counter — its cell stays empty.
    expect(cells[3]).toBe("—");
  });

  test("a unit column's month picker offers the unit's own months", async ({ page }) => {
    // Same class of bug as above: the per-column month <select> was built from
    // the entity's months, so a unit column offered months it has no data for
    // without the "(no data)" marker the control uses to say so.
    await gotoCompare(page, `sbs:gone-unit:${thisMonth()}`);
    // Polled, not read once: the table renders its rows before the DB resolves,
    // so the select starts out holding only the selected month.
    //
    // Gone Unit's two months sit a year back (see the fixture), so the current
    // month is not among them and is flagged rather than silently listed
    // beside real ones. Before the fix this listed the grouping's months.
    await expect
      .poll(async () =>
        (await page.locator("thead th select").first().locator("option").allTextContents())
          .map((o) => o.trim()),
      )
      .toEqual([`${thisMonth()} (no data)`, monthsBack(12), monthsBack(13)]);
  });

  test("a unit slug on a non-SBS entity is ignored, not fatal", async ({ page }) => {
    const month = thisMonth();
    // Malformed link: only SBS has sub-units. The column should survive as the
    // plain entity rather than disappearing.
    await gotoCompare(page, `rubikon:alpha-unit:${month}`);
    await expect(page.locator("thead th").nth(1)).toContainText("Рубикон");
  });
});
