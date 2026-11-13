import { test, expect } from "@playwright/test";
import { FIXED_TODAY, FOG_HOURS, WEATHER_DAY, WEATHER_EMPTY_DAY } from "./build-fixtures.mjs";

// The front-line weather strip on the SBS hourly page: one card above the
// charts for the day being viewed. What has to reach the screen is the hour
// grid read off weather.app.db (built by scripts/weather/app_db.sql, as in CI),
// rated by src/utils/weatherRating.ts — the arithmetic itself is unit-tested.
// Fixture (build-fixtures.mjs buildWeather): Pokrovsk fogged in for
// FOG_HOURS on WEATHER_DAY, Kupiansk clear; today is forecast from 12:00.

const strip = (page: import("@playwright/test").Page) => page.getByTestId("weather-strip");
const row = (page: import("@playwright/test").Page, sector: string) =>
  strip(page).locator(`[role=row][data-sector="${sector}"]`);

test.describe("SBS hourly weather strip", () => {
  test("shows the viewed day's drone conditions per direction", async ({ page }) => {
    await page.goto(`/?site=sbs&page=hourly&days=7&date=${WEATHER_DAY}`);
    await expect(strip(page).getByRole("grid")).toBeVisible();
    await expect(strip(page)).toContainText(`${WEATHER_DAY} · drones POOR at 1 of 2 directions`);

    const fogged = row(page, "Pokrovsk").locator("[role=gridcell]");
    await expect(fogged).toHaveCount(24);
    for (let h = 0; h < 24; h++) {
      await expect(fogged.nth(h)).toHaveAttribute("data-level", FOG_HOURS.includes(h) ? "2" : "0");
    }
    await expect(row(page, "Pokrovsk").getByTestId("weather-day")).toHaveText("POOR");
    await expect(row(page, "Kupiansk").getByTestId("weather-day")).toHaveText("GOOD");

    // The per-hour count of severely limited directions.
    const counts = strip(page).getByTestId("weather-severe-count");
    await expect(counts.nth(FOG_HOURS[0])).toHaveText("1");
    await expect(counts.nth(FOG_HOURS[0] - 1)).toHaveText("·");

    // A cell explains itself on hover (and on tap).
    await fogged.nth(FOG_HOURS[0]).hover();
    await expect(strip(page)).toContainText(
      `Pokrovsk 0${FOG_HOURS[0]}:00 · drones severely limited: fog · 10 °C · 0.0 mm · wind 3/6 m/s · vis 0.3 km`);

    // The SBS charts are still there below it.
    await expect(page.locator(".hourly-card svg.recharts-surface").first()).toBeVisible();
  });

  test("marks today's hours still ahead as forecast", async ({ page }) => {
    await page.goto("/?site=sbs&page=hourly&days=7");
    const cells = row(page, "Kupiansk").locator("[role=gridcell]");
    await expect(cells).toHaveCount(24);
    await expect(cells.nth(11)).not.toHaveAttribute("data-forecast", "1");
    await expect(cells.nth(12)).toHaveAttribute("data-forecast", "1");
    await expect(strip(page)).toContainText("faded = forecast");
    await expect(strip(page)).toContainText(FIXED_TODAY);
  });

  test("says so for a day without weather data, and keeps the page", async ({ page }) => {
    await page.goto(`/?site=sbs&page=hourly&days=7&date=${WEATHER_EMPTY_DAY}`);
    await expect(strip(page)).toContainText(`No weather data for ${WEATHER_EMPTY_DAY}.`);
    await expect(page.locator(".hourly-card svg.recharts-surface").first()).toBeVisible();
  });
});
