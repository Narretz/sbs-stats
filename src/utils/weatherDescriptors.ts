// What the weather strips say in the charts' own tooltip and pinned sheet
// (TooltipDescriptor, components/TooltipTable): one direction on hover, a
// whole column — every direction at that hour or on that day — in the sheet.
// Plain data in, descriptors out, so the wording is unit-tested.
import type { TooltipDescriptor, TooltipTableRow } from "@/components/TooltipTable";
import { OK, type HourRating, type Level } from "@/utils/weatherRating";
import { dayLevel, type DayCell, type DailyStrip, type HourCell, type HourlyStrip } from "@/utils/weatherStrip";

export interface DescriptorColors {
  text: string;
  muted: string;
  /** The strip's colour for a level, used for a limited row's label. */
  level: (l: Level) => string;
}

// The one scale, for hours and days alike.
const LEVEL_WORD = ["ok", "limited", "severe"] as const;
const FOOTER = "Open-Meteo model data, not observations. Small-drone conditions — a heuristic, not a record of flights.";

// A row with nothing to say keeps its place and says so with a dash: rows that
// came and went made the card change shape from one cell to the next.
const EMPTY = "–";
const fmt = (v: number | null | undefined, digits = 0) => (v == null ? EMPTY : v.toFixed(digits));
export function fmtVis(m: number | null | undefined): string {
  if (m == null) return "–";
  if (m >= 10_000) return ">10";
  // Dense model fog comes back as 20–40 m, which would round to "0.0".
  return m < 100 ? "<0.1" : (m / 1000).toFixed(1);
}
const hh = (h: number) => `${String(h).padStart(2, "0")}:00`;
export function weekdayDate(date: string): string {
  const wd = new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" });
  return `${wd} ${date}`;
}
const windowsText = (ws: { start: number; end: number; reasons: string[] }[]) =>
  ws.map((w) => `${String(w.start).padStart(2, "0")}–${String(w.end).padStart(2, "0")}h ${w.reasons.join("/")}`).join("; ");

function droneText(r: HourRating): string {
  const why = r.reasons.map(([, x]) => x).join(", ");
  return `${LEVEL_WORD[r.level]}${why ? ` — ${why}` : ""}`;
}

// ── Hourly ──────────────────────────────────────────────────────────────────

/** Hover: one direction at one hour. */
export function hourCellDescriptor(sectorKey: string, date: string, cell: HourCell, c: DescriptorColors): TooltipDescriptor {
  const header = `${sectorKey} · ${date} ${hh(cell.hour)}${cell.forecast ? " (forecast)" : ""}`;
  if (!cell.rating || !cell.weather) return { header, rows: [], footer: "No weather data for this hour." };
  const w = cell.weather;
  const row = (label: string, value: string, color = c.text): TooltipTableRow => ({ label, value, color });
  return {
    header,
    rows: [
      row("Drones", droneText(cell.rating), cell.rating.level === OK ? c.text : c.level(cell.rating.level)),
      row("Temperature", `${fmt(w.temperature_2m)} °C`),
      row("Precipitation", `${fmt(w.precipitation, 1)} mm`),
      row("Snowfall", `${fmt(w.snowfall, 1)} cm`),
      row("Wind / gusts", `${fmt(w.wind_speed_10m)} / ${fmt(w.wind_gusts_10m)} m/s`),
      row("Visibility", `${fmtVis(w.visibility)} km`),
    ],
    minWidth: 240,
  };
}

/** Sheet: every direction at one hour. */
export function hourColumnDescriptor(strip: HourlyStrip, date: string, hour: number, c: DescriptorColors): TooltipDescriptor {
  const cells = strip.rows.map((r) => r.cells[hour]);
  const forecast = cells.some((x) => x.forecast);
  return {
    header: `${date} ${hh(hour)}${forecast ? " (forecast)" : ""} · severe for drones at ${strip.severeCount[hour]} of ${strip.rows.length} directions`,
    valueLabel: "Drones",
    extraColumns: ["Why", "°C", "mm", "Wind m/s", "Vis km"],
    rows: strip.rows.map(({ sector, cells }) => {
      const x = cells[hour];
      const w = x.weather;
      if (!x.rating || !w) return { label: sector.key, color: c.muted, value: null };
      return {
        label: sector.key,
        color: x.rating.level === OK ? c.text : c.level(x.rating.level),
        value: LEVEL_WORD[x.rating.level],
        extra: [
          x.rating.reasons.map(([, r]) => r).join(", ") || EMPTY,
          fmt(w.temperature_2m),
          fmt(w.precipitation, 1),
          `${fmt(w.wind_speed_10m)}/${fmt(w.wind_gusts_10m)}`,
          fmtVis(w.visibility),
        ],
      };
    }),
    footer: FOOTER,
    emptyState: "No weather data for this hour.",
  };
}

// ── Daily ───────────────────────────────────────────────────────────────────

/** Hover: one direction on one day. */
export function dayCellDescriptor(sectorKey: string, cell: DayCell, c: DescriptorColors): TooltipDescriptor {
  const header = `${sectorKey} · ${weekdayDate(cell.date)}`;
  const s = cell.summary;
  if (!s) return { header, rows: [], footer: "No weather data for this day." };
  const row = (label: string, value: string, color = c.text): TooltipTableRow => ({ label, value, color });
  const level = dayLevel(s.rating);
  return {
    header,
    rows: [
      row("Drones", s.rating, level === OK ? c.text : c.level(level)),
      row("Severe / limited", `${s.severeHours} h / ${s.limitedHours} h`),
      row("Mainly", s.reasons.slice(0, 3).join(", ") || EMPTY),
      row("Drone-denied", windowsText(s.windows) || EMPTY),
      row("Temperature", `${fmt(s.tMin)}…${fmt(s.tMax)} °C`),
      row("Precipitation", `${fmt(s.precip, 1)} mm`),
      row("Snowfall", `${fmt(s.snow, 1)} cm`),
      row("Max gust", `${fmt(s.gustMax)} m/s`),
      row("Min visibility", `${fmtVis(s.visMin)} km`),
    ],
    footer: s.forecastHours ? `${s.forecastHours} of ${s.hours} hours are forecast.` : undefined,
    minWidth: 260,
  };
}

/** Sheet: every direction on one day. */
export function dayColumnDescriptor(strip: DailyStrip, index: number, c: DescriptorColors): TooltipDescriptor {
  const date = strip.dates[index];
  const days = strip.rows.map((r) => r.cells[index].summary).filter((s) => s != null);
  const forecast = days.some((s) => s.forecastHours > 0);
  // The daily strip's extra column is tomorrow: every hour of it forecast.
  const allForecast = days.length > 0 && days.every((s) => s.forecastHours === s.hours);
  return {
    header: `${weekdayDate(date)}${allForecast ? " (forecast)" : forecast ? " (partly forecast)" : ""} · a severe day for drones at ${strip.severeCount[index]} of ${strip.rows.length} directions`,
    valueLabel: "Drones",
    extraColumns: ["Severe h", "Mainly", "Drone-denied", "mm", "Gust m/s", "Vis km"],
    rows: strip.rows.map(({ sector, cells }) => {
      const s = cells[index].summary;
      if (!s) return { label: sector.key, color: c.muted, value: null };
      const level = dayLevel(s.rating);
      return {
        label: sector.key,
        color: level === OK ? c.text : c.level(level),
        value: s.rating,
        extra: [
          s.severeHours,
          s.reasons.slice(0, 2).join(", ") || EMPTY,
          windowsText(s.windows) || EMPTY,
          fmt(s.precip, 1),
          fmt(s.gustMax),
          fmtVis(s.visMin),
        ],
      };
    }),
    footer: FOOTER,
    emptyState: "No weather data for this day.",
  };
}
