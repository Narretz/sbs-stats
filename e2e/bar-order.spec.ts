import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { FIXED_TODAY } from "./build-fixtures.mjs";

// The bar order (utils/barOrder): ranked, a page's charts draw every period
// from the first up to the window's end, highest or lowest first, as many as
// the window has — the page queries the whole span and hands its charts the
// ranking. The SBS fixture's far-past sentinel (999,999 personnel on
// 2020-01-01, outside every day-range window) is what tells a ranking over all
// the data from one over the window's rows.

const monthISO = (offset: number) => {
  const [y, m] = FIXED_TODAY.slice(0, 7).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + offset, 1)).toISOString().slice(0, 7);
};

// The first chart's x-axis labels, in drawn order. recharts renders every
// axis's labels in one layer, outside the axis group, so they're told apart by
// their shape.
async function firstChartTicks(page: Page): Promise<string[]> {
  const card = page.locator(".chart-card").first();
  await card.locator(".recharts-bar-rectangle").first().waitFor();
  const labels = await card.locator(".recharts-cartesian-axis-tick-value").allTextContents();
  return labels.filter((t) => /^\d{4}[-/]\d{2}/.test(t));
}

test("daily: ranked by max, the whole history's highest day leads a 7-day window", async ({ page }) => {
  await page.goto("/?site=sbs&page=daily&days=7&order=max");
  const ticks = await firstChartTicks(page);
  expect(ticks[0]).toBe("2020-01-01");
  // As many bars as the window has days; today, still being reported, isn't one.
  expect(ticks).toHaveLength(7);
  expect(ticks).not.toContain(FIXED_TODAY);
});

test("monthly: ranked by min, past months lowest first and the month in progress left out", async ({ page }) => {
  // The fixture's grouping months: 5002 two months back, 5001 last month,
  // 5000 this month — the lowest, but in progress.
  await page.goto("/?site=sbs&page=monthly&order=min");
  const ticks = await firstChartTicks(page);
  expect(ticks).toEqual([monthISO(-1), monthISO(-2)].map((m) => m.replace("-", "/")));
});

test("the order control writes order= and switches the charts", async ({ page }) => {
  await page.goto("/?site=sbs&page=daily&days=7");
  await page.locator(".chart-card").first().locator(".recharts-line").first().waitFor();
  await page.getByTestId("bar-order-select").selectOption("max");
  await expect(page).toHaveURL(/[?&]order=max\b/);
  expect((await firstChartTicks(page))[0]).toBe("2020-01-01");
  await page.getByTestId("bar-order-select").selectOption("date");
  await expect(page).not.toHaveURL(/[?&]order=/);
  await expect(page.locator(".chart-card").first().locator(".recharts-line").first()).toBeVisible();
});

test("SBS ranked: each hit / destroyed pair is followed by destroyed's own chart", async ({ page }) => {
  // The pair ranks by hit, so the destroyed bars beside it are in no order.
  for (const p of ["daily&days=7", "monthly"]) {
    await page.goto(`/?site=sbs&page=${p}&order=max`);
    await expect(page.locator("#targets-hit-destroyed")).toBeVisible();
    await expect(page.locator("#targets-destroyed")).toBeVisible();
  }
});

test("GSUA ranked: combat engagements gets an unattributed chart, and a picked direction ranks too", async ({ page }) => {
  await page.goto("/?site=ru-attacks-gsua&page=daily&days=7&order=max");
  await expect(page.locator("#combat-engagements-unattributed .recharts-bar-rectangle").first()).toBeAttached();
  // With its "with direction" half, over the same span.
  await expect(page.locator("#combat-engagements .recharts-bar-rectangle")).toHaveCount(14);

  await page.goto("/?site=ru-attacks-gsua&page=daily&days=7&order=max&direction=Pokrovsk");
  await expect(page.getByTestId("bar-order-select")).toBeVisible();
  const card = page.locator("#attacks-pokrovsk");
  await expect(card.locator(".recharts-bar-rectangle")).toHaveCount(7);
  await expect(card.locator(".recharts-line")).toHaveCount(0);
});

test("CIT ranked daily: one bar per report, the weekend report labelled with both its days", async ({ page }) => {
  // The fixture's 5–11 Jan 2026: no report on Wed 7, one for Sat 10 + Sun 11.
  await page.goto("/?site=cit-civilians&page=daily&days=7&date=2026-01-11&order=max");
  const card = page.locator("#all-civilian-casualties");
  await card.locator(".recharts-bar-rectangle").first().waitFor();
  const ticks = (await card.locator(".recharts-cartesian-axis-tick-value").allTextContents())
    .filter((t) => /^\d{4}-/.test(t));
  // Five reports in the window: four days and the weekend.
  expect(ticks).toHaveLength(5);
  expect(ticks).toContain("2026-01-10/11");
});

test("exchanges ranked: the biggest exchange of the whole record leads", async ({ page }) => {
  // The bundled record itself — this page has no fixture.
  const records: { date: string; ua_received: number | null; ru_received: number | null }[] =
    JSON.parse(readFileSync("scripts/pow_exchanges/exchanges.json", "utf8")).exchanges;
  const total = (e: (typeof records)[number]) => (e.ua_received ?? 0) + (e.ru_received ?? 0);
  const biggest = [...records].sort((a, b) => total(b) - total(a) || a.date.localeCompare(b.date))[0];

  await page.goto("/?site=pow-exchanges&order=max");
  await expect(page.getByTestId("bar-order-select")).toHaveValue("max");
  expect((await firstChartTicks(page))[0]).toBe(biggest.date.replace(/-/g, "/"));
});
