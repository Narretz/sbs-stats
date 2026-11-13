import { describe, expect, it } from "vitest";
import { buildDailyStrip, buildHourlyStrip, datesBetween, forecastDayAfter, summariseDay } from "@/utils/weatherStrip";
import {
  dayCellDescriptor, dayColumnDescriptor, hourCellDescriptor, hourColumnDescriptor, type DescriptorColors,
} from "@/utils/weatherDescriptors";

const CALM = {
  temperature_2m: 10, precipitation: 0, snowfall: 0, weather_code: 1,
  visibility: 24000, wind_speed_10m: 3, wind_gusts_10m: 6,
};
const sectors = [
  { id: 1, key: "Kupiansk", near: "Kupiansk" },
  { id: 2, key: "Pokrovsk", near: "Pokrovsk–Myrnohrad" },
];
const day = (sector: number, date: string, over: (hour: number) => object = () => ({}), forecastFrom = 24) =>
  Array.from({ length: 24 }, (_, hour) => ({
    sector, date, hour, forecast: hour >= forecastFrom, ...CALM, ...over(hour),
  }));
// Oct 11 in miniature: Pokrovsk fogged in 01–09, at 40 m.
const fog = (h: number) => (h >= 1 && h < 10 ? { visibility: 40, weather_code: 45, temperature_2m: 9 } : {});
const colors: DescriptorColors = { text: "T", muted: "M", level: (l) => `L${l}` };

describe("buildHourlyStrip", () => {
  it("rates each direction's day and counts severe directions per hour", () => {
    const m = buildHourlyStrip(sectors, [...day(1, "2026-10-11"), ...day(2, "2026-10-11", fog)]);
    expect(m.rows.map((r) => r.day)).toEqual(["ok", "severe"]);
    expect(m.severeSectors).toBe(1);
    expect(m.severeCount.slice(0, 11)).toEqual([0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0]);
    expect(m.rows[1].windows).toEqual([{ start: 1, end: 10, reasons: ["fog"] }]);
  });

  it("keeps 24 columns when hours are missing, and says when there is no data", () => {
    const m = buildHourlyStrip(sectors, day(1, "2026-10-11").slice(0, 5));
    expect(m.rows[0].cells).toHaveLength(24);
    expect(m.rows[0].cells[5].rating).toBeNull();
    expect(m.rows[1].day).toBeNull();
    expect(m.hasData).toBe(true);
    expect(buildHourlyStrip(sectors, []).hasData).toBe(false);
  });
});

describe("buildDailyStrip", () => {
  const dates = datesBetween("2026-10-10", "2026-10-12");

  it("has a column per date, gaps where nothing is stored", () => {
    const m = buildDailyStrip(sectors, [...day(1, "2026-10-11"), ...day(2, "2026-10-11", fog)], dates);
    expect(m.dates).toEqual(["2026-10-10", "2026-10-11", "2026-10-12"]);
    expect(m.rows[1].cells.map((c) => c.summary?.rating ?? null)).toEqual([null, "severe", null]);
    expect(m.severeCount).toEqual([0, 1, 0]);
    expect(m.hasData).toBe(true);
  });

  it("summarises a day: hours, reasons, windows, extremes", () => {
    const s = summariseDay(day(2, "2026-10-11", fog, 20))!;
    expect(s).toMatchObject({
      rating: "severe", hours: 24, forecastHours: 4, severeHours: 9, limitedHours: 9,
      reasons: ["fog"], windows: [{ start: 1, end: 10, reasons: ["fog"] }],
      precip: 0, tMin: 9, tMax: 10, gustMax: 6, visMin: 40,
    });
    expect(summariseDay([])).toBeNull();
  });
});

describe("forecastDayAfter", () => {
  it("is tomorrow only for a window ending today", () => {
    expect(forecastDayAfter("2026-11-13", "2026-11-13")).toBe("2026-11-14");
    expect(forecastDayAfter("2026-12-31", "2026-12-31")).toBe("2027-01-01");
    expect(forecastDayAfter("2026-11-12", "2026-11-13")).toBeNull();
  });
});

describe("descriptors", () => {
  const hourly = buildHourlyStrip(sectors, [...day(1, "2026-10-11"), ...day(2, "2026-10-11", fog, 7)]);
  const daily = buildDailyStrip(sectors, [...day(1, "2026-10-11"), ...day(2, "2026-10-11", fog)],
    datesBetween("2026-10-11", "2026-10-11"));

  it("an hour cell: the hovered direction's weather", () => {
    const d = hourCellDescriptor("Pokrovsk", "2026-10-11", hourly.rows[1].cells[7], colors);
    expect(d.header).toBe("Pokrovsk · 2026-10-11 07:00 (forecast)");
    expect(d.rows.map((r) => [r.label, r.value])).toEqual([
      ["Drones", "severe — fog"],
      ["Temperature", "9 °C"],
      ["Precipitation", "0.0 mm"],
      ["Snowfall", "0.0 cm"],
      ["Wind / gusts", "3 / 6 m/s"],
      ["Visibility", "<0.1 km"],
    ]);
    expect(d.rows[0].color).toBe("L2");
  });

  it("an hour column: every direction, for the sheet", () => {
    const d = hourColumnDescriptor(hourly, "2026-10-11", 4, colors);
    expect(d.header).toBe("2026-10-11 04:00 · severe for drones at 1 of 2 directions");
    expect(d.rows.map((r) => [r.label, r.value, r.extra?.[0]])).toEqual([
      ["Kupiansk", "ok", "–"],
      ["Pokrovsk", "severe", "fog"],
    ]);
  });

  it("a day cell and a day column", () => {
    const cell = dayCellDescriptor("Pokrovsk", daily.rows[1].cells[0], colors);
    expect(cell.header).toBe("Pokrovsk · Sun 2026-10-11");
    expect(cell.rows.find((r) => r.label === "Drone-denied")?.value).toBe("01–10h fog");
    // A clear day keeps every row, with a dash where there is nothing to say.
    const clear = dayCellDescriptor("Kupiansk", daily.rows[0].cells[0], colors);
    expect(clear.rows.map((r) => r.label)).toEqual(cell.rows.map((r) => r.label));
    expect(clear.rows.find((r) => r.label === "Drone-denied")?.value).toBe("–");
    expect(clear.rows.find((r) => r.label === "Mainly")?.value).toBe("–");
    const col = dayColumnDescriptor(daily, 0, colors);
    expect(col.header).toBe("Sun 2026-10-11 · a severe day for drones at 1 of 2 directions");
    expect(col.rows.map((r) => [r.label, r.value])).toEqual([["Kupiansk", "ok"], ["Pokrovsk", "severe"]]);
  });

  it("says when there is no data", () => {
    const empty = buildDailyStrip(sectors, [], ["2026-10-11"]);
    expect(dayCellDescriptor("Kupiansk", empty.rows[0].cells[0], colors).footer).toBe("No weather data for this day.");
    expect(dayColumnDescriptor(empty, 0, colors).rows.every((r) => r.value === null)).toBe(true);
  });
});
