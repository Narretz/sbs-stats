import { test, expect, type Page } from "@playwright/test";

// Compare — the current month read as a month-end projection.
//
// SBS (the grouping and every sub-unit) is the only source here that publishes
// mid-month, so it is the only one whose hooks derive a month-end figure — the same number the monthly charts draw as the ghost segment. The
// compare page offers it as an extra option under the month it projects.
//
// Only SBS columns carry real assertions: the fixture covers sbs.db and
// sbs-units.db, and «Альфа» has no fixture at all.

// "YYYY-MM" for the current Kyiv month and for N months before it — the same
// arithmetic e2e/build-fixtures.mjs used to place the fixture's months.
function thisMonth(): string {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" }).slice(0, 7);
}

function monthsBack(n: number): string {
  const [y, m] = thisMonth().split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 - n, 1)).toISOString().slice(0, 7);
}

function kyivToday(): [number, number, number] {
  const [y, m, d] = new Date()
    .toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" })
    .split("-").map(Number);
  return [y, m, d];
}

// Computed rather than hardcoded because the answer changes every day the
// suite runs — which is also why nothing below asserts "projected is larger".
// The arithmetic itself is covered in src/utils/monthProjection.test.ts; this
// is only enough of it to know the right number reached the cell.
//
// The grouping extrapolates the days complete at snapshot time. The fixture's
// snapshot is stamped 00:00Z today (03:00 Kyiv) and its daily rows carry no
// data_collected_at, so there is no partial to subtract: d − 1 complete days.
function groupingProjected(reported: number): number {
  const [y, m, d] = kyivToday();
  return Math.round((reported / (d - 1)) * new Date(y, m, 0).getDate());
}

// Sub-units still count today as a full day.
function unitProjected(reported: number): number {
  const [y, m, d] = kyivToday();
  return Math.round(reported * (new Date(y, m, 0).getDate() / d));
}

// On the 1st no day is complete, so the grouping offers no projection at all.
const skipOnFirst = () =>
  test.skip(kyivToday()[2] === 1, "no complete day yet on the 1st, so no grouping projection");

// Fixture (e2e/build-fixtures.mjs): the grouping's current month reports
// total_targets_hit 25,000; Alpha Unit's 510.
const SBS_ENGAGED = 25000;
const ALPHA_ENGAGED = 510;

async function gotoCompare(page: Page, cols: string): Promise<void> {
  await page.goto(`/?view=compare&cols=${cols}`);
  await page.locator("tbody tr").first().waitFor();
}

// The first value cell of a row, polled: the table renders its rows before the
// DBs resolve, so a single read can catch an em dash.
async function engaged(page: Page): Promise<string> {
  const tr = page.locator("tbody tr").filter({ hasText: "All targets engaged" }).first();
  await tr.waitFor();
  return (await tr.locator("td").nth(1).textContent() ?? "").replace(/\s+/g, " ").trim();
}

const monthSelect = (page: Page) => page.locator("thead th select").first();

test.describe("Compare — month-end projection", () => {
  test("the option sits under the month it projects, and nowhere else", async ({ page }) => {
    skipOnFirst();
    await gotoCompare(page, `sbs:${thisMonth()}`);
    await expect
      .poll(async () => (await monthSelect(page).locator("option").allTextContents()).map((o) => o.trim()))
      .toEqual([
        thisMonth(), `${thisMonth()} (projected)`,
        monthsBack(1), monthsBack(2),
      ]);
  });

  test("a unit that has stopped reporting offers none", async ({ page }) => {
    // Gone Unit's rows stop a year back, so there is no month still running to
    // extrapolate — and the option must not be borrowed from the grouping,
    // whose months the column falls back to for everything else.
    await gotoCompare(page, `sbs:gone-unit:${monthsBack(12)}`);
    await expect
      .poll(async () => (await monthSelect(page).locator("option").allTextContents()).join("|"))
      .toContain(monthsBack(12));
    expect((await monthSelect(page).locator("option").allTextContents()).join("|"))
      .not.toContain("projected");
  });

  test("choosing it marks the column, the URL and every figure", async ({ page }) => {
    skipOnFirst();
    await gotoCompare(page, `sbs:${thisMonth()}`);
    await expect.poll(async () => await engaged(page)).toContain(SBS_ENGAGED.toLocaleString());

    await monthSelect(page).selectOption(`${thisMonth()}:proj`);

    // The marker rides at the end of the column token, so the month stays the
    // last positional one for readers of the old two- and three-token forms.
    await expect(page).toHaveURL(/cols=sbs(%3A|:)\d{4}-\d{2}(%3A|:)proj/);
    await expect(page.locator("thead th").nth(1)).toContainText("month-end projection");
    // "~" on the value itself: the header says it once, but cells travel.
    await expect
      .poll(async () => await engaged(page))
      .toBe(`~${groupingProjected(SBS_ENGAGED).toLocaleString()}`);
  });

  test("a sub-unit projects its own figures, not the grouping's", async ({ page }) => {
    // The same trap every sub-unit feature has: read through the column's own
    // snapshot or the unit silently shows the whole branch's number.
    await gotoCompare(page, `sbs:alpha-unit:${thisMonth()}:proj`);
    await expect
      .poll(async () => await engaged(page))
      .toBe(`~${unitProjected(ALPHA_ENGAGED).toLocaleString()}`);
  });

  test("moving the column to a settled month drops the projection", async ({ page }) => {
    skipOnFirst();
    await gotoCompare(page, `sbs:${thisMonth()}:proj`);
    await expect.poll(async () => await engaged(page)).toContain("~");

    await monthSelect(page).selectOption(monthsBack(1));
    await expect(page).not.toHaveURL(/proj/);
    await expect(page.locator("thead th").nth(1)).not.toContainText("month-end projection");
    await expect.poll(async () => await engaged(page)).not.toContain("~");
  });

  test("a shared projection link outlives its month gracefully", async ({ page }) => {
    // Come next month, this link's month is settled and has no projection.
    // The settled total is what the projection stood in for, so the column
    // falls back to it rather than rendering a stripe of em dashes.
    await gotoCompare(page, `sbs:${monthsBack(1)}:proj`);
    await expect.poll(async () => await engaged(page)).toMatch(/^[\d,]+$/);
    await expect(page).not.toHaveURL(/proj/);
    await expect(monthSelect(page)).toHaveValue(monthsBack(1));
  });

  test("the sources that only publish settled months offer nothing", async ({ page }) => {
    await gotoCompare(page, `rubikon:${thisMonth()}`);
    await expect
      .poll(async () => (await monthSelect(page).locator("option").allTextContents()).join("|"))
      .not.toContain("projected");
  });
});
