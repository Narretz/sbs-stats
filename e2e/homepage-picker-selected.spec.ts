import { test, expect } from "@playwright/test";

// The metric picker repeats what is on the chart at the top, each with its
// group inline, since the ticked ones are otherwise scattered across a dozen
// groups. The first default chart carries two metrics (src/data/defaultCharts.json).
test("the picker lists the chart's metrics at the top, with their groups", async ({ page }) => {
  await page.goto("/");
  const trigger = page.locator('button:has-text("metric")').first();
  await trigger.click();
  const pop = page.locator("[popover]:popover-open");
  const section = pop.getByTestId("metric-picker-selected");

  await expect(section).toContainText("Selected · 2");
  await expect(section.locator("label")).toHaveText([/^RU MoD AD · .+/, /^RU Strikes · .+/]);

  // Unticking it there takes it off the chart, like unticking it in its group.
  // A click, not uncheck(): the row leaves the section as it is unticked, so
  // there is no element left to confirm the state on.
  await section.locator("label").first().locator("input").click();
  await expect(section).toContainText("Selected · 1");
  await expect(trigger).toHaveText(/^1 metric/);

  // A search is about what matches; the section steps aside.
  await pop.getByPlaceholder("Search metrics…").fill("tanks");
  await expect(section).toHaveCount(0);
});
