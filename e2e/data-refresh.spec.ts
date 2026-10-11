import { test, expect } from "@playwright/test";

test.describe("Data refresh", () => {
  test("the Data Availability line stays up while the DB reloads", async ({ page }) => {
    await page.goto("/?site=sbs&page=daily");
    const note = page.getByText(/Data Availability/).first();
    await expect(note).toBeVisible();
    const before = await note.innerText();

    // Hold the reload's download open, so the check below runs mid-refresh
    // rather than racing a fixture that arrives in a few milliseconds.
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    await page.route("**/sbs.db*", async (route) => {
      await held;
      await route.continue();
    });
    const reload = page.waitForRequest("**/sbs.db*");
    await page.getByTitle(/Click to refresh now/).click();
    await reload;

    await expect(note).toBeVisible();
    expect(await note.innerText()).toBe(before);

    release();
    await expect(page.getByTitle(/Last updated/)).toBeVisible();
    await expect(note).toHaveText(before);
  });
});
