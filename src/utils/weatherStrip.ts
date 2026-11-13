// The weather strips' models: a day's hours (hourly page) or a window's days
// (daily pages) rated and arranged into one row per front-line direction.
// Kept out of the components so they are testable without a DOM; the
// descriptors that turn them into tooltips are in weatherDescriptors.ts.
import {
  coverWindows, DEGRADED, droneDay, droneHour, OK, SEVERE,
  type CoverWindow, type DayRating, type HourRating, type Level, type Reason, type WeatherHour,
} from "@/utils/weatherRating";

export interface StripSector { id: number; key: string; near: string }

interface Cell extends WeatherHour { sector: number; date: string; hour: number; forecast: boolean }

// ── Hourly ──────────────────────────────────────────────────────────────────

export interface HourCell {
  hour: number;
  rating: HourRating | null;   // null: no data for this hour
  forecast: boolean;
  weather: WeatherHour | null;
}

export interface HourlyRow {
  sector: StripSector;
  cells: HourCell[];           // always 24, hour 0–23
  day: DayRating | null;       // null when the day has no data at all
  windows: CoverWindow[];
}

export interface HourlyStrip {
  rows: HourlyRow[];
  /** Per hour, how many directions were severely limited. */
  severeCount: number[];
  hasData: boolean;
  poorSectors: number;
}

function bySectorHour(cells: Cell[]): Map<number, Map<number, Cell>> {
  const m = new Map<number, Map<number, Cell>>();
  for (const c of cells) {
    if (!m.has(c.sector)) m.set(c.sector, new Map());
    m.get(c.sector)!.set(c.hour, c);
  }
  return m;
}

/** One day's hours. `cells` should all be from that day. */
export function buildHourlyStrip(sectors: StripSector[], cells: Cell[]): HourlyStrip {
  const bySector = bySectorHour(cells);
  const severeCount = Array<number>(24).fill(0);
  const rows = sectors.map((sector) => {
    const hours = bySector.get(sector.id) ?? new Map<number, Cell>();
    const stripCells: HourCell[] = Array.from({ length: 24 }, (_, hour) => {
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
      day: rated.length ? droneDay(rated.map((r) => r.rating.level)) : null,
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

// ── Daily ───────────────────────────────────────────────────────────────────

export interface DaySummary {
  rating: DayRating;
  hours: number;
  forecastHours: number;
  severeHours: number;
  /** Degraded or worse. */
  limitedHours: number;
  /** Every reason behind a limited hour, the commonest first. */
  reasons: Reason[];
  windows: CoverWindow[];
  precip: number;
  snow: number;
  tMin: number | null;
  tMax: number | null;
  gustMax: number | null;
  visMin: number | null;
}

export interface DayCell { date: string; summary: DaySummary | null }

export interface DailyRow { sector: StripSector; cells: DayCell[] }

export interface DailyStrip {
  dates: string[];
  rows: DailyRow[];
  /** Per date, how many directions had a POOR drone day. */
  poorCount: number[];
  hasData: boolean;
}

const min = (xs: number[]) => (xs.length ? Math.min(...xs) : null);
const max = (xs: number[]) => (xs.length ? Math.max(...xs) : null);
const vals = (hs: Cell[], k: keyof WeatherHour) =>
  hs.map((h) => h[k]).filter((v): v is number => v != null);

export function summariseDay(hours: Cell[]): DaySummary | null {
  if (!hours.length) return null;
  const rated = hours.map((h) => ({ hour: h.hour, rating: droneHour(h) }));
  const counts = new Map<Reason, number>();
  for (const { rating } of rated) {
    for (const [, r] of rating.reasons) counts.set(r, (counts.get(r) ?? 0) + 1);
  }
  return {
    rating: droneDay(rated.map((r) => r.rating.level)),
    hours: hours.length,
    forecastHours: hours.filter((h) => h.forecast).length,
    severeHours: rated.filter((r) => r.rating.level === SEVERE).length,
    limitedHours: rated.filter((r) => r.rating.level >= DEGRADED).length,
    reasons: [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([r]) => r),
    windows: coverWindows(rated),
    precip: vals(hours, "precipitation").reduce((a, b) => a + b, 0),
    snow: vals(hours, "snowfall").reduce((a, b) => a + b, 0),
    tMin: min(vals(hours, "temperature_2m")),
    tMax: max(vals(hours, "temperature_2m")),
    gustMax: max(vals(hours, "wind_gusts_10m")),
    visMin: min(vals(hours, "visibility")),
  };
}

/** A window of days, one column per date in `dates`. */
export function buildDailyStrip(sectors: StripSector[], cells: Cell[], dates: string[]): DailyStrip {
  const byKey = new Map<string, Cell[]>();
  for (const c of cells) {
    const k = `${c.sector}|${c.date}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(c);
  }
  const poorCount = Array<number>(dates.length).fill(0);
  const rows = sectors.map((sector) => ({
    sector,
    cells: dates.map((date, i) => {
      const summary = summariseDay(byKey.get(`${sector.id}|${date}`) ?? []);
      if (summary?.rating === "POOR") poorCount[i]++;
      return { date, summary };
    }),
  }));
  return { dates, rows, poorCount, hasData: rows.some((r) => r.cells.some((c) => c.summary)) };
}

/** A day rating on the strip's three-step colour scale. */
export function dayLevel(rating: DayRating): Level {
  return rating === "POOR" ? SEVERE : rating === "MARGINAL" ? DEGRADED : OK;
}

/** YYYY-MM-DD for every day from `start` to `end`, inclusive. */
export function datesBetween(start: string, end: string): string[] {
  const out: string[] = [];
  const d = new Date(`${start}T12:00:00Z`);
  const last = new Date(`${end}T12:00:00Z`);
  while (d <= last) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
