import { test, expect } from "@playwright/test";

// The weekday filter on the shared checkbox popover (CheckboxMultiSelect):
// picking days writes them to the URL and names them on the button, which is
// lit while it filters; "All" clears it.

// The current weekday's checkbox carries a suffix ("Wed (today)"), so an
// exact "Wed" stops matching on Wednesdays.
const day = (name: string) => new RegExp(`^${name}( \\(today\\))?$`);

test("picking weekdays filters, names them, and All clears", async ({ page }) => {
  await page.goto("/?site=sbs&page=daily");
  await page.waitForSelector(".chart-card");
  const button = page.getByRole("button", { name: /^All ▾$/ });
  await button.click();
  await page.getByRole("checkbox", { name: day("Mon") }).check();
  await page.getByRole("checkbox", { name: day("Wed") }).check();

  await expect(page).toHaveURL(/[?&]weekdays=1(%2C|,)3(&|$)/);
  const lit = page.getByRole("button", { name: /^Mon, Wed ▾$/ });
  await expect(lit).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: "All", exact: true }).click();
  await expect(page).toHaveURL(/[?&]weekdays=(&|$)/);
  await expect(page.getByRole("button", { name: /^All ▾$/ })).not.toHaveAttribute("aria-pressed", "true");
});
