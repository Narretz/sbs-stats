import { test, expect, type Page } from "@playwright/test";

// The "of which comparable" child under "All targets engaged".
//
// The parent is each unit's WHOLE reported output, which is honest but not
// like-for-like: two columns can differ because one unit did more, or merely
// because it counts more things. The child adds up only the categories every
// selected column can fill.
//
// "Shared" is a question about what each unit REPORTS AS A RULE, not about
// what it happened to publish that month — so these assertions are about the
// registry's mappings, not the fixture's values. SBS and «Рубикон» both carry
// 13 of the 15 candidate categories; aircraft and watercraft are SBS-only.
const PARENT = "All targets engaged";
const CHILD = "of which comparable";

function thisMonth(): string {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" }).slice(0, 7);
}

async function rowCells(page: Page, label: string): Promise<string[]> {
  const tr = page.locator("tbody tr").filter({ hasText: label }).first();
  await tr.waitFor();
  return (await tr.locator("td").allTextContents()).map((s) => s.replace(/\s+/g, " ").trim());
}

const num = (cell: string): number =>
  Number((cell.match(/[\d,]+/)?.[0] ?? "").replace(/,/g, ""));

async function gotoCompare(page: Page, cols: string, extra = ""): Promise<void> {
  await page.goto(`/?view=compare&cols=${cols}${extra}`);
  await page.locator("tbody tr").first().waitFor();
}

test.describe("Compare — comparable subset", () => {
  test("the caption follows the scope-notes toggle", async ({ page }) => {
    const m = thisMonth();
    await gotoCompare(page, `sbs:${m},rubikon:${m}`);
    expect((await rowCells(page, CHILD))[0]).not.toContain("categories all selected units");
    await gotoCompare(page, `sbs:${m},rubikon:${m}`, "&scope=1");
    expect((await rowCells(page, CHILD))[0]).toContain("categories all selected units");
  });

  test("is a child of the total, and follows the sub-category toggle", async ({ page }) => {
    const m = thisMonth();
    await gotoCompare(page, `sbs:${m},rubikon:${m}`);
    const rows = await page.locator("tbody tr").allTextContents();
    const parent = rows.findIndex((r) => r.includes(PARENT));
    const child = rows.findIndex((r) => r.includes(CHILD));
    expect(parent).toBeGreaterThanOrEqual(0);
    // Directly beneath the row it qualifies.
    expect(child).toBe(parent + 1);

    await gotoCompare(page, `sbs:${m},rubikon:${m}`, "&sub=0");
    await expect(page.locator("tbody tr").filter({ hasText: CHILD })).toHaveCount(0);
  });

  test("never exceeds the total it is a subset of", async ({ page }) => {
    // The guard against double-counting. The row sums PARENT canonical rows
    // only — the canonical children subdivide their parent's mapping, so
    // including them would count the same counter twice and could push this
    // above the total.
    const m = thisMonth();
    await gotoCompare(page, `sbs:${m},sbs:alpha-unit:${m},rubikon:${m}`);
    const total = (await rowCells(page, PARENT)).slice(1).map(num);
    const subset = (await rowCells(page, CHILD)).slice(1).map(num);
    expect(subset).toHaveLength(total.length);
    subset.forEach((v, i) => expect(v).toBeLessThanOrEqual(total[i]));
  });

  test("drops the categories unique to some units, and names them", async ({ page }) => {
    const m = thisMonth();
    await gotoCompare(page, `sbs:alpha-unit:${m},rubikon:${m}`, "&scope=1");
    const cells = await rowCells(page, CHILD);

    // «Рубикон» has no aircraft or watercraft counter at all — those are the
    // genuinely incomparable ones.
    expect(cells[0]).toContain("13 categories all selected units report");
    expect(cells[0]).toContain("left out as unique to some");
    expect(cells[0]).toContain("Aircraft");
    expect(cells[0]).toContain("Fleet");

    // On the ROW, not repeated under every column. A per-column caption reads
    // as a statement about that unit: "left out: Aircraft" under «Рубикон»
    // would say «Рубикон» lost aircraft, when it is the one unit with no
    // aircraft counter and it lost nothing.
    expect(cells[1]).not.toContain("left out");
    expect(cells[2]).not.toContain("left out");
  });

  test("a category a unit reports as a rule but not this month still counts", async ({ page }) => {
    // The distinction that makes the set stable month to month. Air defence is
    // in every one of these units' vocabularies, so it stays in the shared set
    // even in a month where a column published nothing for it — silence means
    // zero, not "incomparable". Keying off values instead made the set flicker
    // and docked one unit for another unit's quiet month.
    const m = thisMonth();
    await gotoCompare(page, `sbs:alpha-unit:${m},rubikon:${m}`, "&scope=1");
    const cells = await rowCells(page, CHILD);
    expect(cells[0]).not.toContain("Air defense");
  });

  test("two columns of the same vocabulary drop nothing", async ({ page }) => {
    // Two SBS sub-units publish exactly the same counters, so there is nothing
    // one reports that the other can't be compared on.
    const m = thisMonth();
    await gotoCompare(page, `sbs:alpha-unit:${m},sbs:bravo-unit:${m}`, "&scope=1");
    const cells = await rowCells(page, CHILD);
    expect(cells[0]).toContain("15 categories all selected units report");
    expect(cells[0]).not.toContain("left out");
  });

  test("the subset is derived, and marked as such", async ({ page }) => {
    // No source publishes it — this app added it up — so it carries the same
    // "*" the other computed figures do.
    const m = thisMonth();
    await gotoCompare(page, `sbs:${m},rubikon:${m}`);
    const cells = await rowCells(page, CHILD);
    expect(cells[1]).toContain("*");
  });
});
