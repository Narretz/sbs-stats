import { test, expect, type Page } from "@playwright/test";

// The GSUA daily page's direction picker: several directions can be picked,
// and they are overlaid, one line each — never summed (jointly reported
// directions carry the same figure, which a sum would count twice).
//
// Fixture directions (e2e/build-fixtures.mjs): Pokrovsk on each day's
// canonical report, Lyman on its 16:00 one. Listed alphabetically.

const PICKER = "direction-picker";

async function openPicker(page: Page) {
  await page.getByTestId(PICKER).click();
  const list = page.getByTestId(`${PICKER}-list`);
  await expect(list).toBeVisible();
  return list;
}

// By accessible name: the colour swatch beside each name is aria-hidden.
const tick = (list: ReturnType<Page["getByTestId"]>, name: string) =>
  list.getByRole("checkbox", { name, exact: true }).check();

test.describe("GSUA daily — direction picker", () => {
  test("one direction gets its own charts, two are overlaid", async ({ page }) => {
    await page.goto("/?site=ru-attacks-gsua&page=daily");
    await page.waitForSelector(".chart-card");
    const list = await openPicker(page);
    await expect(list.locator("label")).toHaveText([/Lyman/, /Pokrovsk/]);

    await tick(list, "Pokrovsk");
    await expect(page).toHaveURL(/[?&]direction=Pokrovsk(&|$)/);
    await expect(page.locator(".chart-card").filter({ hasText: "Attacks · Pokrovsk" })).toHaveCount(1);

    await tick(list, "Lyman");
    // Kept in list order, whatever order they were ticked in.
    await expect(page).toHaveURL(/[?&]direction=Lyman(%2C|,)Pokrovsk(&|$)/);
    const overlay = page.locator(".chart-card").filter({ hasText: "Attacks by direction" });
    await expect(overlay).toContainText("Pokrovsk");
    await expect(overlay).toContainText("Lyman");
    await expect(page.locator(".chart-card").filter({ hasText: "Attacks · Pokrovsk" })).toHaveCount(0);

    await list.getByRole("button", { name: "All Ukraine (overview)" }).click();
    await expect(page).not.toHaveURL(/[?&]direction=/);
    await expect(page.locator(".chart-card").filter({ hasText: "Attacks by direction" })).toHaveCount(0);
  });

  test("a link from before several could be picked still opens its direction", async ({ page }) => {
    await page.goto("/?site=ru-attacks-gsua&page=daily&direction=Lyman");
    await expect(page.locator(".chart-card").filter({ hasText: "Attacks · Lyman" })).toHaveCount(1);
    await expect(page.getByTestId(PICKER)).toHaveText(/Lyman/);
  });

  test("the monthly page has the picker too, summing each direction's days into months", async ({ page }) => {
    await page.goto("/?site=ru-attacks-gsua&page=monthly");
    await page.waitForSelector(".chart-card");
    const list = await openPicker(page);
    await tick(list, "Lyman");
    await expect(page).toHaveURL(/[?&]direction=Lyman(&|$)/);
    await expect(page.locator(".chart-card").filter({ hasText: "Attacks · Lyman" })).toHaveCount(1);

    await tick(list, "Pokrovsk");
    const overlay = page.locator(".chart-card").filter({ hasText: "Attacks by direction" });
    await expect(overlay).toContainText("Pokrovsk");
    await expect(overlay).toContainText("Lyman");
  });
});
