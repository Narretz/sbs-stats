import { test, expect, type Page } from "@playwright/test";
import { FIXED_TODAY, FOG_HOURS, WEATHER_DAY, WEATHER_EMPTY_DAY } from "./build-fixtures.mjs";

// The front-line weather strip: a card above the charts on the hourly and
// daily pages, behind a "Front-line weather" checkbox under Show more. What has
// to reach the screen is the grid read off weather.app.db (built by
// scripts/weather/app_db.sql, as in CI), the charts' own hover card and pinned
// sheet, and — while switched off — no download at all. The ratings and the
// wording are unit-tested (weatherRating / weatherStrip tests).
// Fixture (build-fixtures.mjs buildWeather): Pokrovsk fogged in for FOG_HOURS
// on WEATHER_DAY, Kupiansk clear; today is forecast from 12:00.

const strip = (page: Page) => page.getByTestId("weather-strip");
const row = (page: Page, sector: string) => strip(page).locator(`[role=row][data-sector="${sector}"]`);
const sheet = (page: Page) => page.locator(".chart-sheet[data-open]");

async function switchOn(page: Page) {
  await page.getByTestId("more-controls").click();
  await page.getByTestId("weather-toggle").check();
}

test.describe("weather strip toggle", () => {
  test("is off by default, and off means not downloaded", async ({ page }) => {
    const fetched: string[] = [];
    page.on("request", (r) => { if (r.url().includes("weather.app.db")) fetched.push(r.url()); });
    await page.goto("/?site=sbs&page=hourly&days=7");
    await expect(page.locator(".hourly-card svg.recharts-surface").first()).toBeVisible();
    await expect(strip(page)).toHaveCount(0);
    expect(fetched).toEqual([]);

    await switchOn(page);
    await expect(strip(page).getByRole("grid")).toBeVisible();
    expect(fetched).toHaveLength(1);
  });

  test("is remembered across pages and visits", async ({ page }) => {
    await page.goto("/?site=sbs&page=hourly&days=7");
    await switchOn(page);
    await expect(strip(page)).toBeVisible();
    await page.goto("/?site=sbs&page=daily&days=7");
    await expect(strip(page).getByRole("grid")).toBeVisible();

    await page.getByTestId("more-controls").click();
    await page.getByTestId("weather-toggle").uncheck();
    await expect(strip(page)).toHaveCount(0);
    await page.reload();
    await expect(page.locator(".chart-card").first()).toBeVisible();
    await expect(strip(page)).toHaveCount(0);
  });
});

test.describe("weather strip", () => {
  test.beforeEach(async ({ context }) => {
    await context.addInitScript(() => localStorage.setItem("weatherStrip", "1"));
  });

  test("hourly: each direction's hours for the viewed day", async ({ page }) => {
    await page.goto(`/?site=sbs&page=hourly&days=7&date=${WEATHER_DAY}`);
    await expect(strip(page).getByRole("grid")).toBeVisible();
    await expect(strip(page)).toContainText(`${WEATHER_DAY} · a severe day for drones at 1 of 2 directions`);

    const fogged = row(page, "Pokrovsk").getByRole("gridcell");
    await expect(fogged).toHaveCount(24);
    for (let h = 0; h < 24; h++) {
      await expect(fogged.nth(h)).toHaveAttribute("data-level", FOG_HOURS.includes(h) ? "2" : "0");
    }
    await expect(row(page, "Pokrovsk").getByTestId("weather-tail")).toHaveText("severe");
    await expect(row(page, "Kupiansk").getByTestId("weather-tail")).toHaveText("ok");

    // The count row: directions severely limited per hour.
    const counts = strip(page).getByTestId("weather-count");
    await expect(counts.nth(FOG_HOURS[0])).toHaveText("1");
    await expect(counts.nth(FOG_HOURS[0] - 1)).toHaveText("·");

    // The SBS charts are still there below it.
    await expect(page.locator(".hourly-card svg.recharts-surface").first()).toBeVisible();
  });

  test("hourly: hover shows the one direction, a click pins the hour for every direction", async ({ page }) => {
    await page.goto(`/?site=sbs&page=hourly&days=7&date=${WEATHER_DAY}`);
    const h = FOG_HOURS[0];
    const cell = row(page, "Pokrovsk").getByRole("gridcell").nth(h);
    await cell.hover();
    await expect(page.getByText(`Pokrovsk · ${WEATHER_DAY} 0${h}:00`)).toBeVisible();
    await expect(page.getByText("severe — fog")).toBeVisible();

    await cell.click();
    await expect(sheet(page)).toContainText(`${WEATHER_DAY} 0${h}:00 · severe for drones at 1 of 2 directions`);
    await expect(sheet(page)).toContainText("Kupiansk");
    await expect(sheet(page)).toContainText("Pokrovsk");
    await expect(page.locator(".chart-sheet-label")).toHaveText(`${WEATHER_DAY} 0${h}:00`);

    // The stepper walks the hours.
    await page.getByLabel("Next point").click();
    await expect(page.locator(".chart-sheet-label")).toHaveText(`${WEATHER_DAY} 0${h + 1}:00`);
  });

  test("hourly: today's hours still ahead are forecast", async ({ page }) => {
    await page.goto("/?site=sbs&page=hourly&days=7");
    const cells = row(page, "Kupiansk").getByRole("gridcell");
    await expect(cells).toHaveCount(24);
    await expect(cells.nth(11)).not.toHaveAttribute("data-forecast", "1");
    await expect(cells.nth(12)).toHaveAttribute("data-forecast", "1");
    await expect(strip(page)).toContainText(FIXED_TODAY);
  });

  test("hourly: a day without weather data says so, and keeps the page", async ({ page }) => {
    await page.goto(`/?site=sbs&page=hourly&days=7&date=${WEATHER_EMPTY_DAY}`);
    await expect(strip(page)).toContainText(`No weather data for ${WEATHER_EMPTY_DAY}.`);
    await expect(page.locator(".hourly-card svg.recharts-surface").first()).toBeVisible();
  });

  test("daily: a column per day, and the day's sheet links to its hours", async ({ page }) => {
    await page.goto(`/?site=sbs&page=daily&days=7&date=${FIXED_TODAY}`);
    await expect(strip(page).getByRole("grid")).toBeVisible();
    const fogged = row(page, "Pokrovsk").getByRole("gridcell");
    await expect(fogged).toHaveCount(7);
    // Columns run oldest to newest, ending today: WEATHER_DAY is today − 2.
    await expect(fogged.nth(4)).toHaveAttribute("data-level", "2");   // a severe day
    await expect(fogged.nth(6)).toHaveAttribute("data-level", "0");   // today, clear
    await expect(fogged.nth(6)).toHaveAttribute("data-forecast", "1");
    await expect(fogged.nth(0)).toHaveAttribute("data-level", "");    // nothing stored
    await expect(row(page, "Pokrovsk").getByTestId("weather-tail")).toHaveText("1/7");
    // Only the count is highlighted, not "/7".
    const tail = row(page, "Pokrovsk").getByTestId("weather-tail");
    const [count, rest] = await tail.evaluate((el) => [
      getComputedStyle(el.querySelector("span")!).color, getComputedStyle(el).color]);
    expect(count).not.toBe(rest);

    await fogged.nth(4).hover();
    await expect(page.getByText(`Pokrovsk · `).first()).toBeVisible();

    await fogged.nth(4).click();
    await expect(sheet(page)).toContainText("a severe day for drones at 1 of 2 directions");
    await sheet(page).getByText("By hour").click();
    await expect(page).toHaveURL(new RegExp(`[?&]page=hourly\\b.*date=${WEATHER_DAY}|date=${WEATHER_DAY}.*page=hourly`));
    await expect(strip(page)).toContainText(`${WEATHER_DAY} · a severe day for drones at 1 of 2 directions`);
  });

  // Regression: the card was a fixed box at `left: cursor`, only as wide as
  // the room left before the viewport's edge — towards the right it squeezed,
  // and its table's label column went to nothing.
  test("the hover card keeps its width and stays on screen near the right edge", async ({ page }) => {
    await page.setViewportSize({ width: 560, height: 800 });
    await page.goto(`/?site=sbs&page=daily&days=30&date=${FIXED_TODAY}`);
    const cells = row(page, "Pokrovsk").getByRole("gridcell");
    await expect(cells).toHaveCount(30);
    for (const i of [0, 15, 26, 29]) {
      await cells.nth(i).hover();
      const card = page.locator("[data-weather-hover]");
      await expect(card).toBeVisible();
      const box = (await card.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(560);
      const cut = await card.locator("span").evaluateAll((els) =>
        els.filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent));
      expect(cut).toEqual([]);
    }
  });

  test("the hover card stays open across the gap between two cells", async ({ page }) => {
    await page.goto(`/?site=sbs&page=daily&days=7&date=${FIXED_TODAY}`);
    const cells = row(page, "Pokrovsk").getByRole("gridcell");
    const a = (await cells.nth(2).boundingBox())!;
    const b = (await cells.nth(3).boundingBox())!;
    expect(b.x).toBeGreaterThan(a.x + a.width);   // there is a gap to cross
    const y = a.y + a.height / 2;
    await page.mouse.move(a.x + a.width / 2, y);
    const card = page.locator("[data-weather-hover]");
    await expect(card).toBeVisible();
    await page.mouse.move((a.x + a.width + b.x) / 2, y);
    await expect(card).toBeVisible();
    // …and it closes off the cells: over the direction's name.
    await row(page, "Pokrovsk").locator("div").first().hover();
    await expect(card).toHaveCount(0);
  });

  test("daily: GSUA, which lays out its own chart grids", async ({ page }) => {
    await page.goto(`/?site=ru-attacks-gsua&page=daily&days=7&date=${FIXED_TODAY}`);
    await expect(strip(page).getByRole("grid")).toBeVisible();
    await expect(row(page, "Pokrovsk").getByRole("gridcell").nth(4)).toHaveAttribute("data-level", "2");
  });
});
