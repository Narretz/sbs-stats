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

// Add the first unchecked metric in the first chart's MetricPicker.
async function addOneMetricToFirstChart(page: Page) {
  const trigger = page.locator('button:has-text("metric")').first();
  const beforeLabel = await trigger.innerText();
  await trigger.click();
  const popover = page.locator("[popover]").first();
  await popover.waitFor({ state: "visible" });
  await popover.locator('input[type="checkbox"]:not(:checked)').first().check();
  await page.keyboard.press("Escape");
  // Trigger label updates on the next render — wait for it to reflect +1.
  await expect(trigger).not.toHaveText(beforeLabel);
  return trigger;
}

test.describe("Homepage custom charts", () => {
  test("changing the time window via the preset dropdown preserves a just-added metric", async ({ page }) => {
    await openHomeWithDefaults(page);
    const trigger = await addOneMetricToFirstChart(page);
    const afterAdd = await trigger.innerText();

    const drop = page.locator('[data-testid="day-range"]').first();
    await drop.selectOption("30");
    await page.waitForFunction(() => /[?&]charts=.*d30/.test(location.search));
    await expect(trigger).toHaveText(afterAdd);
  });

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
