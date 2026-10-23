import { test, expect } from "@playwright/test";

// Pages are chunks loaded on first visit, and a deploy renames them all — so
// a tab open across one fails to load its next page. main.tsx reloads once on
// that (Vite's `vite:preloadError`), and only once. The POW exchanges page
// stands in for any page: its data is bundled, so no fixture DB is involved.
const CHUNK = /\/assets\/PowExchangesPage-[\w-]+\.js$/;
const HEADING = { name: "Prisoner Exchanges between Russia and Ukraine" };

test("a page chunk that fails to load is fetched again after one reload", async ({ page }) => {
  let hits = 0;
  await page.route(CHUNK, (r) => (++hits === 1 ? r.fulfill({ status: 404 }) : r.continue()));
  await page.goto("/?site=pow-exchanges");
  await expect(page.getByRole("heading", HEADING)).toBeVisible();
  expect(hits).toBe(2);
});

test("a chunk that keeps failing ends at the error screen, not in a reload loop", async ({ page }) => {
  let hits = 0;
  await page.route(CHUNK, (r) => {
    hits++;
    return r.fulfill({ status: 404 });
  });
  await page.goto("/?site=pow-exchanges");
  await expect(page.getByText(/^✖ /)).toBeVisible();
  // Give a runaway reload the time to show itself.
  await page.waitForTimeout(1500);
  expect(hits).toBe(2);
  await expect(page.getByText(/^✖ /)).toBeVisible();
});
