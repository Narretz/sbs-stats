import { describe, expect, it } from "vitest";
import { buildStrip, describeCell } from "@/utils/weatherStrip";

const CALM = {
  temperature_2m: 10, precipitation: 0, snowfall: 0, weather_code: 1,
  visibility: 24000, wind_speed_10m: 3, wind_gusts_10m: 6,
};
const sectors = [
  { id: 1, key: "Kupiansk", near: "Kupiansk" },
  { id: 2, key: "Pokrovsk", near: "Pokrovsk–Myrnohrad" },
];
const day = (sector: number, over: (hour: number) => object = () => ({}), forecastFrom = 24) =>
  Array.from({ length: 24 }, (_, hour) => ({ sector, hour, forecast: hour >= forecastFrom, ...CALM, ...over(hour) }));

describe("buildStrip", () => {
  it("rates each sector's day and counts severe sectors per hour", () => {
    // Oct 11 in miniature: Pokrovsk fogged in 01–09, Kupiansk clear.
    const fog = (h: number) => (h >= 1 && h < 10 ? { visibility: 40, weather_code: 45 } : {});
    const m = buildStrip(sectors, [...day(1), ...day(2, fog)]);
    expect(m.rows.map((r) => r.day)).toEqual(["GOOD", "POOR"]);
    expect(m.poorSectors).toBe(1);
    expect(m.severeCount.slice(0, 11)).toEqual([0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0]);
    expect(m.rows[1].windows).toEqual([{ start: 1, end: 10, reasons: ["fog"] }]);
  });

  it("keeps 24 columns when hours are missing, and says when there is no data", () => {
    const m = buildStrip(sectors, day(1).slice(0, 5));
    expect(m.rows[0].cells).toHaveLength(24);
    expect(m.rows[0].cells[5].rating).toBeNull();
    expect(m.rows[1].day).toBeNull();
    expect(m.hasData).toBe(true);
    expect(buildStrip(sectors, []).hasData).toBe(false);
  });

  it("carries the forecast flag through", () => {
    const m = buildStrip(sectors, day(1, () => ({}), 15));
    expect(m.rows[0].cells.map((c) => c.forecast).indexOf(true)).toBe(15);
  });
});

describe("describeCell", () => {
  it("names the conditions and the reasons", () => {
    const m = buildStrip(sectors, day(2, (h) => (h === 7 ? { visibility: 40, weather_code: 45, temperature_2m: 9 } : {}), 7));
    expect(describeCell("Pokrovsk", m.rows[1].cells[7])).toBe(
      "Pokrovsk 07:00 (forecast) · drones severely limited: fog · 9 °C · 0.0 mm · wind 3/6 m/s · vis <0.1 km");
    expect(describeCell("Kupiansk", m.rows[0].cells[3])).toBe("Kupiansk 03:00 · no data");
  });
});
