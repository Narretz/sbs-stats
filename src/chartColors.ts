// Single source of truth for chart **data-series colors** (bars, lines, areas).
//
// Every color here resolves to a theme token (`src/theme.ts`) — nothing in this
// file is a literal hex any more. To recolor charts app-wide, edit the token;
// to recolor one chart's role, repoint its entry below.
//
// The house rule the tokens encode: the MAIN series of a chart is blue
// (`t.series1`), a SECOND series drawn against it is red (`t.series2`). Charts
// with an open-ended number of series (directions, freely-picked metrics) use
// QUALITATIVE_PALETTE instead; the HUR missile grid keeps its own family-coded
// palette in `components/missilePalette.ts`.

import type { Theme } from "@/theme";

// ── Alpha helpers ──────────────────────────────────────────────────────────

// Hex-alpha suffix applied to a base color for projected/forecast segments
// (≈ 40% opacity). Change to "33" for ~20%, "88" for ~53%, etc.
export const PROJECTED_ALPHA_SUFFIX = "65";

export const withProjectedAlpha = (hex: string): string => hex + PROJECTED_ALPHA_SUFFIX;

// Area-fill opacities for the stacked AREA charts in DailyLineChart (Destroyed
// drawn over Damaged). Expressed as 0–1 decimals because SVG `fillOpacity`
// takes that form; if you'd rather bake the alpha into the color string, use
// `withFillAlpha(hex, decimal)` below. Distinct from PROJECTED_ALPHA_SUFFIX —
// projected segments are lighter "hint overlays" (~40%), areas need to be
// more solid so the underlying data stays readable.
export const AREA_FILL_OPACITY = {
  damaged: 0.35,
  destroyed: 0.55,
} as const;

// Convert a 0–1 decimal opacity into the two-char hex byte that recharts/CSS
// accept as an alpha suffix on a 6-char hex color. Useful when you want to
// bake the alpha into the color string instead of passing fillOpacity.
export const withFillAlpha = (hex: string, opacity: number): string =>
  hex + Math.round(Math.max(0, Math.min(1, opacity)) * 255).toString(16).padStart(2, "0");

// ── Qualitative palette (theme-independent) ────────────────────────────────
//
// 24-color qualitative palette for charts whose series count is data-driven
// rather than fixed: GSUA attack directions (26 all-time, 16 max in one day)
// and the home page's freely-composed metric charts. Colors are interleaved
// from opposite hue families so adjacent stacks stay visually distinct even
// when 10+ appear in one bar, and are picked to read on both themes — which is
// why they don't flip with the theme.
export const QUALITATIVE_PALETTE = [
  "#3b82f6", "#ef4444", "#f59e0b", "#10b981", "#8b5cf6", "#ec4899",
  "#14b8a6", "#f97316", "#06b6d4", "#a855f7", "#84cc16", "#f43f5e",
  "#0ea5e9", "#eab308", "#7c3aed", "#22c55e", "#e11d48", "#0891b2",
  "#c026d3", "#65a30d", "#b45309", "#4f46e5", "#059669", "#be123c",
] as const;

/** Nth series color, wrapping around the palette. */
export const qualitativeColor = (i: number): string =>
  QUALITATIVE_PALETTE[i % QUALITATIVE_PALETTE.length];

// ── Theme-derived semantic palette ─────────────────────────────────────────
//
// Call with `const c = chartColors(t);` then use `c.damaged`, `c.destroyed`,
// etc. Multiple semantic keys may point at the same underlying token — that's
// intentional, so each chart can be retuned without affecting unrelated ones.

export interface ChartColors {
  // Generic single/paired line charts (SBS daily, GSUA hourly, Mediazona …)
  line: string;             // the main series — blue
  lineSecondary: string;    // a second series drawn against it — red

  // Damaged/destroyed pair (SBS daily, SBU Alfa targets, etc.)
  damaged: string;
  destroyed: string;
  damagedProjected: string;
  destroyedProjected: string;
  destroyedTrend: string;
  destroyedCurrent: string;

  // Single-metric bar charts (RU air attacks monthly, RU MoD monthly, …)
  barDefault: string;
  barCurrent: string;       // last/current month highlight
  barCurrentProjected: string;

  // RU MoD day vs overnight split — overnight is the dominant series
  daytime: string;
  overnight: string;

  // Hourly chart
  hourlyToday: string;
  hourlyPastDay: string;

  // Civilian casualties (CIT). Their own roles rather than borrowed equipment
  // ones: killed/injured is a different pairing from damaged/destroyed, and
  // retuning one should not silently retune the other.
  civiliansKilled: string;
  civiliansInjured: string;

  // De-emphasised / unattributed slices of an otherwise colored chart
  neutral: string;

  // Reference lines + trend overlays
  grid: string;
  maxReference: string;
  medReference: string;
  trend: string;

  // Caveat / note styling applied to bars carrying a tooltip `note`
  noteBorder: string;
  noteText: string;
}

export function chartColors(t: Theme): ChartColors {
  return {
    line: t.series1,
    lineSecondary: t.series2,

    damaged: t.series1,
    destroyed: t.series2,
    damagedProjected: withProjectedAlpha(t.series1),
    destroyedProjected: withProjectedAlpha(t.series2),
    destroyedTrend: t.series2Trend,
    destroyedCurrent: t.series2Current,

    barDefault: t.series1,
    barCurrent: t.series1Current,
    barCurrentProjected: withProjectedAlpha(t.series1),

    daytime: t.series2,
    overnight: t.series1,

    hourlyToday: t.series1,
    hourlyPastDay: t.seriesNeutral,

    // Killed is the graver of the pair, so it takes the red the house rule
    // reserves for a second series drawn against the main one; injured takes
    // the blue. They are charted separately (different magnitudes, never one
    // shared axis), so the pairing is about meaning, not adjacency.
    civiliansKilled: t.series2,
    civiliansInjured: t.series1,

    neutral: t.seriesNeutral,

    grid: t.chartGrid,
    maxReference: t.accent,
    medReference: t.muted,
    trend: t.muted,

    noteBorder: t.borderImportant,
    noteText: t.textImportant,
  };
}
