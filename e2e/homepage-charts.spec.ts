import { test, expect, type Page } from "@playwright/test";

// Homepage custom-charts UI regressions. None of these need DB data to load —
// they assert URL / state / DOM behavior — so they're tolerant of the e2e
// fixture set only covering SBS + GSUA.

async function openHomeWithDefaults(page: Page) {
  await page.goto("/");
  // Wait for the first chart card's MetricPicker trigger to render so the
  // defaults are mounted before we start poking.
  await page.locator('button:has-text("metric")').first().waitFor();
}

test.describe("Homepage custom charts", () => {
  // A just-added metric surviving a time-window change (a stale onChange in
  // the window picker once dropped it) is DayRangeSelect.browser.test.tsx.

  // The `charts=` encoding itself — delimiters in a name, single-encoding
  // through URLSearchParams, malformed specs — is covered in
  // src/home/charts.test.ts, where the cases cost a line each instead of a
  // browser boot.

  test("Remove prompts via window.confirm; dismissing keeps the chart", async ({ page }) => {
    await openHomeWithDefaults(page);
    const startCount = await page.locator('input[placeholder="Chart name"]').count();

    let confirmMsg = "";
    page.once("dialog", async (d) => {
      confirmMsg = d.message();
      await d.dismiss();
    });
    await page.locator('button:has-text("Remove")').first().click();
    await page.waitForTimeout(150);

    expect(confirmMsg).toMatch(/Remove ".+"\?/);
    expect(await page.locator('input[placeholder="Chart name"]').count()).toBe(startCount);
  });

  test("Remove via accept actually removes the chart", async ({ page }) => {
    await openHomeWithDefaults(page);
    const startCount = await page.locator('input[placeholder="Chart name"]').count();
    page.once("dialog", (d) => d.accept());
    await page.locator('button:has-text("Remove")').first().click();
    await expect(page.locator('input[placeholder="Chart name"]')).toHaveCount(startCount - 1);
  });

  test("per-chart Y-axis override round-trips through the URL", async ({ page }) => {
    await openHomeWithDefaults(page);
    const ySelect = page.locator('select[title^="Y-axis transform for this chart"]').first();
    await expect(ySelect).toHaveValue("inherit"); // defaults inherit the global yMode
    await ySelect.selectOption("log");
    // Serializes as a `y<log>` suffix on the chart's spec token.
    await page.waitForFunction(() => /[?&]charts=.*ylog/.test(location.search));

    await page.reload();
    await expect(
      page.locator('select[title^="Y-axis transform for this chart"]').first(),
    ).toHaveValue("log");
  });

  test("a charts= URL carrying a per-chart Y suffix is parsed back", async ({ page }) => {
    const param = encodeURIComponent("Log chart:d20ylog:sbs.personnel_killed");
    await page.goto(`/?charts=${param}`);
    await expect(page.locator('select[title^="Y-axis transform for this chart"]').first()).toHaveValue("log");
    await expect(page.locator('[data-testid="day-range-custom"]').first()).toHaveValue("20");
  });
});

test("GSUA's attributed and unattributed combat engagements chart from the direction coverage", async ({ page }) => {
  // The fixture's canonical posts credit 60% of each day's engagements to a
  // direction; the split itself is unit-tested in combinedQuery.
  const charts = "A:d7:gsua.combat_engagements_attributed,gsua.combat_engagements_unattributed";
  await page.goto(`/?charts=${encodeURIComponent(charts)}`);
  // Σ of one series, once the chart has its rows (it reads 0 until then).
  const sum = async (label: string) => {
    const stat = page.getByText(new RegExp(`${label} · MAX`)).first();
    const total = async () => Number((await stat.innerText()).match(/Σ ([\d,]+)/)![1].replace(/,/g, ""));
    await expect.poll(total).toBeGreaterThan(0);
    return total();
  };
  const attributed = await sum("Attributed");
  const unattributed = await sum("Unattributed");
  expect(attributed / (attributed + unattributed)).toBeCloseTo(0.6, 1);

  // All data: whole-history stats, a read of their own, over more days.
  await page.getByTestId("stat-scope-select").selectOption("all");
  await expect.poll(() => sum("Unattributed")).toBeGreaterThan(unattributed);
});
