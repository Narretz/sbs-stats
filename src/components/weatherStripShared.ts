import { createElement, Fragment, useMemo } from "react";
import { useTheme } from "@/hooks/useTheme";
import { chartColors } from "@/chartColors";
import { chartAnchor } from "@/utils/chartAnchor";
import { SEVERE, type Level } from "@/utils/weatherRating";
import type { DescriptorColors } from "@/utils/weatherDescriptors";

// What the two weather strips share besides the grid: their title and anchor,
// the legend, their tooltip colours and their status line. Kept
// out of the component files: a file exporting both components and plain
// values breaks Fast Refresh (react-refresh/only-export-components).

// One title for both strips, so the daily strip's sheet link lands on the
// hourly strip of the same day (same anchor).
export const STRIP_TITLE = "Front-line weather — drone conditions";
export const STRIP_ANCHOR = chartAnchor(STRIP_TITLE);

// One scale, one legend, for hours and days alike.
export const LEGEND = (c: { weatherOk: string; weatherDegraded: string; weatherSevere: string }): [string, string][] =>
  [["ok", c.weatherOk], ["limited", c.weatherDegraded], ["severe", c.weatherSevere]];

/** The forecast column's axis label: "fcst", cut to "f" when its column is
 *  too narrow for the word (a container query on .weather-axis-fcst) — on a
 *  phone, or a long window — where it would run into its neighbours. */
export const FCST_AXIS = createElement(Fragment, null, "f", createElement("span", { className: "weather-fcst-rest" }, "cst"));

export const asOfText = (asOf: string | null) =>
  (asOf ? ` · as of ${asOf.slice(0, 10)} ${asOf.slice(11, 16)} UTC` : "");

// Row labels in the tooltip and sheet: severe in the strip's red, the rest in
// plain text — the "limited" pink is a fill colour, unreadable as text.
export function useDescriptorColors(): DescriptorColors {
  const { theme: t } = useTheme();
  const severe = chartColors(t).weatherSevere;
  return useMemo(() => ({
    text: t.text,
    muted: t.textMuted,
    level: (l: Level) => (l === SEVERE ? severe : t.text),
  }), [t, severe]);
}

/** The line a strip shows instead of its grid — loading, failed, or no data
 *  for the range — or null when there is a grid to show. `ready`: the strip
 *  has rows from some copy of the DB. During a background refresh that is
 *  still the old copy, so the grid stays up, and a refresh that fails leaves
 *  it showing that copy rather than the error. */
export function stripStatus(error: string | null, ready: boolean, hasData: boolean, empty: string): string | null {
  if (!ready) return error ? "Weather data unavailable." : "Loading weather…";
  if (!hasData) return empty;
  return null;
}
