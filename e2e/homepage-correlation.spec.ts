import { test, expect } from "@playwright/test";
import { CORRELATION_END } from "./build-fixtures.mjs";

// The SBS / rest-of-GSUA note under a combined chart: rows from both DBs
// reaching it, per grain, and only for a listed pair. What r comes out of
// which rows — the subtraction, SBS's 0 days as gaps, the minimum —
// is src/utils/correlation.test.ts.

const PAIR = "sbs.hit_7,ru-losses.vehicles";

test("a listed pair gets r on a weekly chart, and nothing else does", async ({ page }) => {
  // The fixture's correlation window (build-fixtures.mjs CORRELATION_END):
  // GSUA = 3 × SBS, so the rest moves exactly with SBS.
  const charts = [`D:d90:${PAIR}`, `W:w13:${PAIR}`, `M:m3:${PAIR}`, "S:d90:sbs.hit_7"].join(";");
  await page.goto(`/?charts=${encodeURIComponent(charts)}&date=${CORRELATION_END}`);

  const notes = page.getByTestId("pair-correlation");
  // 13 full weeks, ending on a Sunday: 12 changes.
  await expect(notes.first()).toHaveText("SBS vs rest of GSUA · Vehicles: r 1.00 · weekly changes · n 12");
  // Daily and monthly have none, and neither has SBS on its own.
  await expect(notes).toHaveCount(1);
});
