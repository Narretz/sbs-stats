import { test, expect, type Page } from "@playwright/test";

// Regression guard for the DayRangeSelect custom-input stale-closure: the
// native `change` listener was bound in a useEffect with deps [value], so it
// captured the parent's `charts` array from the moment `value` last changed.
// Adding a metric mutated `charts` without touching `value`, so committing a
// custom window later wrote the stale (pre-add) array back to state + URL,
// silently dropping the just-added metric. Fix: drop the native listener,
// commit on React's onBlur (Enter already calls blur).

async function openHomeWithDefaults(page: Page) {
  await page.goto("/");
  await page.locator('button:has-text("metric")').first().waitFor();
}

async function addOneMetricToFirstChart(page: Page) {
  const trigger = page.locator('button:has-text("metric")').first();
  const before = await trigger.innerText();
  await trigger.click();
  const popover = page.locator("[popover]").first();
  await popover.waitFor({ state: "visible" });
  await popover.locator('input[type="checkbox"]:not(:checked)').first().check();
  await page.keyboard.press("Escape");
  await expect(trigger).not.toHaveText(before);
  return trigger;
}

test.describe("Homepage custom charts — time window picker", () => {
  test("adding a metric then changing the time window via the custom input (Enter) preserves the metric", async ({ page }) => {
    await openHomeWithDefaults(page);
    const trigger = await addOneMetricToFirstChart(page);
    const afterAdd = await trigger.innerText();

    const custom = page.locator('[data-testid="day-range-custom"]').first();
    await custom.fill("45");
    await custom.press("Enter");
    await page.waitForFunction(() => /[?&]charts=.*d45/.test(location.search));

    await expect(trigger).toHaveText(afterAdd);
    const charts = new URL(page.url()).searchParams.get("charts") ?? "";
    const firstChunk = charts.split(";")[0];
    const ids = firstChunk.split(":").at(-1)!.split(",");
    expect(ids.length).toBe(3);
  });

  test("spinner-equivalent (ArrowUp without blur) debounces and commits", async ({ page }) => {
    await openHomeWithDefaults(page);
    // Default daily window is 60d (per defaultCharts.json). ArrowUp twice → 62.
    const custom = page.locator('[data-testid="day-range-custom"]').first();
    await expect(custom).toHaveValue("60");
    await custom.focus();
    await custom.press("ArrowUp");
    await custom.press("ArrowUp");
    // Don't blur — the debounce path must commit on its own ~350ms after the
    // last keystroke. Pre-fix (onBlur-only) the URL never updated.
    await page.waitForFunction(() => /[?&]charts=.*d62/.test(location.search), null, { timeout: 2_000 });
  });

  test("spinner-equivalent after adding a metric preserves the metric (closure freshness)", async ({ page }) => {
    await openHomeWithDefaults(page);
    const trigger = await addOneMetricToFirstChart(page);
    const afterAdd = await trigger.innerText();

    const custom = page.locator('[data-testid="day-range-custom"]').first();
    await custom.focus();
    await custom.press("ArrowUp");
    await page.waitForFunction(() => /[?&]charts=.*d61/.test(location.search), null, { timeout: 2_000 });

    await expect(trigger).toHaveText(afterAdd);
    const charts = new URL(page.url()).searchParams.get("charts") ?? "";
    const firstChunk = charts.split(";")[0];
    const ids = firstChunk.split(":").at(-1)!.split(",");
    expect(ids.length).toBe(3);
  });
});
