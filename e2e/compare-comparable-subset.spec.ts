import { test, expect, type Page } from "@playwright/test";

// The "of which comparable" child under "All targets engaged".
//
// The parent is each unit's WHOLE reported output, which is honest but not
// like-for-like: two columns can differ because one unit did more, or merely
// because it counts more things. The child adds up only the categories every
// selected column can fill.
//
// Which categories are shared, what the caption names, and the sum are the
// registry's (comparableSet and friends, registry.test.ts). These are the
// row reaching the table: where it sits, the toggles it follows, and each
// column reading its own unit's figures.
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
    expect((await rowCells(page, CHILD))[0]).not.toContain("categories every column");
    await gotoCompare(page, `sbs:${m},rubikon:${m}`, "&scope=1");
    const cells = await rowCells(page, CHILD);
    expect(cells[0]).toContain("categories every column");
    expect(cells[0]).toContain("left out as unique to some: Aircraft");
    // On the ROW, not repeated under every column. A per-column caption reads
    // as a statement about that unit: "left out: Aircraft" under «Рубикон»
    // would say «Рубикон» lost aircraft, when it is the one unit with no
    // aircraft counter and it lost nothing.
    expect(cells[1]).not.toContain("left out");
    expect(cells[2]).not.toContain("left out");
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
    // Derived — no source publishes it — so marked like the other computed figures.
    expect((await rowCells(page, CHILD))[1]).toContain("*");

    await gotoCompare(page, `sbs:${m},rubikon:${m}`, "&sub=0");
    await expect(page.locator("tbody tr").filter({ hasText: CHILD })).toHaveCount(0);
  });

  test("never exceeds the total it is a subset of", async ({ page }) => {
    // That no counter is counted twice is registry.test.ts. This is each
    // column reading its OWN snapshot: a sub-unit column summing the
    // grouping's figures would come out far above its own total.
    const m = thisMonth();
    await gotoCompare(page, `sbs:${m},sbs:alpha-unit:${m},rubikon:${m}`);
    const total = (await rowCells(page, PARENT)).slice(1).map(num);
    const subset = (await rowCells(page, CHILD)).slice(1).map(num);
    expect(subset).toHaveLength(total.length);
    subset.forEach((v, i) => expect(v).toBeLessThanOrEqual(total[i]));
  });

  test("is not shown when every column is the same entity", async ({ page }) => {
    // SBS and two of its sub-units publish exactly the same counters, so the
    // total above is already like-for-like and there is nothing to set apart.
    const m = thisMonth();
    await gotoCompare(page, `sbs:${m},sbs:alpha-unit:${m},sbs:bravo-unit:${m}`, "&scope=1");
    await page.locator("tbody tr").filter({ hasText: PARENT }).first().waitFor();
    await expect(page.locator("tbody tr").filter({ hasText: CHILD })).toHaveCount(0);
  });
});
