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

  test("URL is single-encoded — chart names with spaces appear with '+' not '%2520'", async ({ page }) => {
    await openHomeWithDefaults(page);
    // Mutate the chart name to something with whitespace so the encoded form
    // is observable. Defaults already contain spaces, but the URL is omitted
    // entirely while the state equals defaults — change the window to force
    // serialization.
    await page.locator('[data-testid="day-range"]').first().selectOption("30");
    await page.waitForFunction(() => /[?&]charts=/.test(location.search));

    const url = page.url();
    expect(url).not.toContain("%2520");          // no doubled space
    expect(url).toMatch(/RU\+vs\+UA\+UAV\+Attacks/); // single-encoded space → '+'
  });

  test("chart names containing ':' and ';' round-trip through the URL", async ({ page }) => {
    // Construct a URL with a name carrying both delimiters. The escape replaces
    // ':'→%3A and ';'→%3B before URLSearchParams encodes the % again to %25.
    const tricky = "My: chart; name";
    const enc = tricky.replace(/[%:;]/g, encodeURIComponent);
    const param = encodeURIComponent(`${enc}:d20:sbs.personnel_killed`);
    await page.goto(`/?charts=${param}`);

    const nameInput = page.locator('input[placeholder="Chart name"]').first();
    await expect(nameInput).toHaveValue(tricky);
    await expect(page.locator('[data-testid="day-range-custom"]').first()).toHaveValue("20");
  });

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

  test("MetricPicker mounts with no React 'unrecognized prop' warnings", async ({ page }) => {
    const warns: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error" || m.type() === "warning") warns.push(m.text());
    });
    await openHomeWithDefaults(page);
    // Open the picker to exercise the close-button branch too.
    await page.locator('button:has-text("metric")').first().click();
    await page.locator("[popover]").first().waitFor({ state: "visible" });
    await page.keyboard.press("Escape");

    const popoverWarns = warns.filter((w) => /popoverTarget/i.test(w));
    expect(popoverWarns).toEqual([]);
  });
});
