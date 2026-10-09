import { test, expect, type Page } from "@playwright/test";

// The monthly window's end month (MonthNav): a window is (end, length), so
// moving the end slides the same number of months back, and the current month
// is "live" — no `end-month=` in the URL.
//
// Long Unit (build-fixtures.mjs → SBS_UNITS) is the one fixture with more than
// 12 months; below that the window controls hide themselves.
const PAGE = "/?site=sbs&page=monthly&unit=long-unit&months=3";
const END = "month-end-month";
const YEAR = "month-end-year";

function monthsBack(n: number): string {
  const [y, m] = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" }).split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 - n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// The first chart's x-axis, as YYYY-MM.
async function axisMonths(page: Page): Promise<string[]> {
  const ticks = page.locator(".chart-card").first().locator(".recharts-xAxis .recharts-cartesian-axis-tick-value");
  return (await ticks.allTextContents()).map((s) => s.replace("/", "-"));
}

test.describe("Monthly — end month", () => {
  test("slides the window back, and returns to live at the current month", async ({ page }) => {
    await page.goto(PAGE);
    const end = page.getByTestId(END);
    await expect(end).toHaveValue(monthsBack(0));
    await expect.poll(() => axisMonths(page)).toEqual([monthsBack(2), monthsBack(1), monthsBack(0)]);

    await page.getByRole("button", { name: "End: previous month" }).click();
    await expect(end).toHaveValue(monthsBack(1));
    await expect(page).toHaveURL(new RegExp(`end-month=${monthsBack(1)}`));
    // Same length, one month earlier.
    await expect.poll(() => axisMonths(page)).toEqual([monthsBack(3), monthsBack(2), monthsBack(1)]);

    await end.selectOption(monthsBack(0));
    await expect(page).not.toHaveURL(/end-month=/);
    await expect.poll(() => axisMonths(page)).toEqual([monthsBack(2), monthsBack(1), monthsBack(0)]);
  });

  test("reads the end month from the URL", async ({ page }) => {
    await page.goto(`${PAGE}&end-month=${monthsBack(5)}`);
    await expect(page.getByTestId(END)).toHaveValue(monthsBack(5));
    await expect.poll(() => axisMonths(page)).toEqual([monthsBack(7), monthsBack(6), monthsBack(5)]);
  });

  test("goes no earlier than the data", async ({ page }) => {
    // 15 months of data: the oldest is 14 back.
    await page.goto(`${PAGE}&end-month=${monthsBack(14)}`);
    await expect(page.getByRole("button", { name: "End: previous month" })).toBeDisabled();
    await expect(page.getByTestId(END).locator("option").first()).toHaveAttribute("value", monthsBack(14));
  });

  test("a year switch keeps the month, and the latest month is live", async ({ page }) => {
    await page.goto(`${PAGE}&end-month=${monthsBack(12)}`);
    const thisYear = monthsBack(0).slice(0, 4);
    await page.getByTestId(YEAR).selectOption(thisYear);
    // A year on from 12 months back is this month: live.
    await expect(page).not.toHaveURL(/end-month=/);
    await expect(page.getByTestId(END)).toHaveValue(monthsBack(0));
    await expect(page.getByTestId(END).locator("option:checked")).toHaveText(/\(live\)/);
  });
});
