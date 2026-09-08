import { test, expect, type Page } from "@playwright/test";

// The sticky controls row (time window, weekday filter, date nav, MAX/MED/TOTAL
// scope) must only appear when it can actually do something.
//
// Two ways it used to appear when it couldn't:
//   a) while the DB was still downloading — controls over a loading screen,
//      acting on rows that don't exist yet;
//   b) on a monthly page whose dataset is shorter than the smallest window
//      preset. There the month picker hides itself, the visible window IS the
//      whole dataset, and so "Window data" and "All data" compute identical
//      MAX/MED/TOTAL — a control that invites a click and changes nothing.

const ROW = ".page-controls-sticky";
const SCOPE = "stat-scope-select";

async function counts(page: Page) {
  return {
    row: await page.locator(ROW).count(),
    scope: await page.getByTestId(SCOPE).count(),
    // The month/day range picker is the row's other <select>.
    selects: await page.locator(`${ROW} select`).count(),
  };
}

test.describe("Controls row visibility", () => {
  test("no controls while the database is still loading", async ({ page }) => {
    // Hold the DB response open so the loading state is observable.
    await page.route("**/*.db*", async (route) => {
      await new Promise((r) => setTimeout(r, 3000));
      await route.continue();
    });
    await page.goto("/?site=sbs&page=daily");
    await expect(page.getByText(/Loading/i).first()).toBeVisible();
    expect((await counts(page)).row).toBe(0);
    expect((await counts(page)).scope).toBe(0);
  });

  test("controls appear once the data has loaded", async ({ page }) => {
    await page.goto("/?site=sbs&page=daily");
    await page.waitForSelector(".recharts-surface");
    const c = await counts(page);
    expect(c.row).toBe(1);
    expect(c.scope).toBe(1);
  });

  // Both fixture datasets are deliberately tiny (see e2e/build-fixtures.mjs),
  // so their monthly views sit under the 12-month threshold and the picker
  // hides itself. Asserted concretely rather than as an if/else on what's
  // rendered: a conditional would go quietly vacuous if the fixtures ever grew,
  // whereas this fails loudly and tells whoever grew them to cover both sides.
  //
  // The row-present side of the rule is covered by the daily tests below —
  // same gate, same component.
  for (const site of ["sbs", "ru-attacks-gsua"]) {
    test(`${site} monthly is shorter than the smallest window → no controls at all`, async ({ page }) => {
      await page.goto(`/?site=${site}&page=monthly`);
      await page.waitForSelector(".recharts-surface");
      const c = await counts(page);
      expect(c.row, "whole row dropped, not just the scope control").toBe(0);
      expect(c.scope).toBe(0);
    });
  }

  test("the scope toggle never appears without a window picker", async ({ page }) => {
    // The invariant itself, swept across every fixture-backed view. Wherever a
    // scope control exists there must also be a range picker beside it.
    const views = [
      "sbs&page=daily", "sbs&page=hourly", "sbs&page=monthly",
      "ru-attacks-gsua&page=daily", "ru-attacks-gsua&page=monthly",
      "ru-air-attacks-gsua&page=daily", "ru-air-attacks-gsua&page=monthly",
    ];
    for (const v of views) {
      await page.goto(`/?site=${v}`);
      await page.waitForSelector(".recharts-surface");
      const c = await counts(page);
      if (c.scope > 0) {
        expect(c.selects, `${v}: scope control needs a range picker beside it`)
          .toBeGreaterThanOrEqual(2);
      }
    }
  });

  test("daily pages always keep their controls", async ({ page }) => {
    // Daily views always have a day-range worth offering, so the gate above
    // must not strip them.
    await page.goto("/?site=ru-air-attacks-gsua&page=daily");
    await page.waitForSelector(".recharts-surface");
    const c = await counts(page);
    expect(c.row).toBe(1);
    expect(c.scope).toBe(1);
  });
});
