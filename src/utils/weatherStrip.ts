// The weather strip's model: one day's cells rated and arranged into rows,
// kept out of the component so it is testable without a DOM.
import {
  coverWindows, droneDay, droneHour, SEVERE,
  type CoverWindow, type DayRating, type HourRating, type Level, type WeatherHour,
} from "@/utils/weatherRating";

export interface StripCell {
  hour: number;
  rating: HourRating | null;   // null: no data for this hour
  forecast: boolean;
  weather: WeatherHour | null;
}

export interface StripRow {
  sector: { id: number; key: string; near: string };
  cells: StripCell[];          // always 24, hour 0–23
  day: DayRating | null;       // null when the day has no data at all
  windows: CoverWindow[];
}

export interface StripModel {
  rows: StripRow[];
  /** Per hour, how many sectors were severely limited. */
  severeCount: number[];
  /** Hours with any data, so an empty day can say so. */
  hasData: boolean;
  poorSectors: number;
}

interface Cell extends WeatherHour { sector: number; hour: number; forecast: boolean }

export function buildStrip(
  sectors: { id: number; key: string; near: string }[],
  cells: Cell[],
): StripModel {
  const bySector = new Map<number, Map<number, Cell>>();
  for (const c of cells) {
    if (!bySector.has(c.sector)) bySector.set(c.sector, new Map());
    bySector.get(c.sector)!.set(c.hour, c);
  }
  const severeCount = Array<number>(24).fill(0);
  const rows = sectors.map((sector) => {
    const hours = bySector.get(sector.id) ?? new Map<number, Cell>();
    const stripCells: StripCell[] = Array.from({ length: 24 }, (_, hour) => {
      const c = hours.get(hour);
      if (!c) return { hour, rating: null, forecast: false, weather: null };
      const rating = droneHour(c);
      if (rating.level === SEVERE) severeCount[hour]++;
      return { hour, rating, forecast: c.forecast, weather: c };
    });
    const rated = stripCells.filter((c) => c.rating).map((c) => ({ hour: c.hour, rating: c.rating! }));
    return {
      sector,
      cells: stripCells,
      day: rated.length ? droneDay(rated.map((r) => r.rating.level as Level)) : null,
      windows: coverWindows(rated),
    };
  });
  return {
    rows,
    severeCount,
    hasData: rows.some((r) => r.day !== null),
    poorSectors: rows.filter((r) => r.day === "POOR").length,
  };
}

const LEVEL_WORD = ["ok", "limited", "severely limited"] as const;
const fmt = (v: number | null, digits = 0) => (v == null ? "–" : v.toFixed(digits));

/** One line describing a cell, for its tooltip and the tap-to-read line. */
export function describeCell(sectorKey: string, cell: StripCell): string {
  const hh = String(cell.hour).padStart(2, "0");
  if (!cell.rating || !cell.weather) return `${sectorKey} ${hh}:00 · no data`;
  const w = cell.weather;
  const why = cell.rating.reasons.map(([, r]) => r).join(", ");
  // Dense model fog comes back as 20–40 m, which would round to "0.0".
  const vis = w.visibility == null ? "–"
    : w.visibility >= 10_000 ? ">10"
    : w.visibility < 100 ? "<0.1"
    : (w.visibility / 1000).toFixed(1);
  return [
    `${sectorKey} ${hh}:00${cell.forecast ? " (forecast)" : ""}`,
    `drones ${LEVEL_WORD[cell.rating.level]}${why ? `: ${why}` : ""}`,
    `${fmt(w.temperature_2m)} °C`,
    `${fmt(w.precipitation, 1)} mm`,
    `wind ${fmt(w.wind_speed_10m)}/${fmt(w.wind_gusts_10m)} m/s`,
    `vis ${vis} km`,
  ].join(" · ");
}
