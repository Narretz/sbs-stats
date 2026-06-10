// Single source of truth for chart **data-series colors** (bars, lines, areas).
// Chrome colors (button text, error borders, surface backgrounds) stay in theme.ts.
//
// Two kinds of colors live here:
//   1. FIXED hex constants below — do NOT switch between light/dark.
//      Edit the constant to change every usage.
//   2. THEME-DERIVED entries in chartColors(t) — pull from `t.primary` etc. so
//      they flip with dark mode. Reassign the line to break the theme link.
//
// To recolor a chart: edit one entry here, lint, done. No grep across files.

import type { Theme } from "@/theme";

// ── Fixed colors (theme-independent) ───────────────────────────────────────

// Deliberately a different red from t.accent (`#db2c18` light / `#ff6b35` dark).
// Keeping destroyed at a constant red means the destroyed/damaged contrast
// stays strong in dark mode (where t.accent becomes orange), and avoids
// collision with the "current/today" accent that may share the same chart.
export const COLOR_DESTROYED = "#dc2626";

// Lighter red for the destroyed trend line, so it stays distinguishable from
// the destroyed data line.
export const COLOR_DESTROYED_TREND = "#fca5a5";

// Neutral gray for past-day historical lines in the hourly chart — only the
// "today" line gets the accent color.
export const COLOR_HOURLY_PAST_DAY = "#9ca3af";

// Hex-alpha suffix applied to a base color for projected/forecast segments
// (≈ 33% opacity). Change to "33" for ~20%, "88" for ~53%, etc.
export const PROJECTED_ALPHA_SUFFIX = "55";

export const withProjectedAlpha = (hex: string): string => hex + PROJECTED_ALPHA_SUFFIX;


// ── Theme-derived semantic palette ─────────────────────────────────────────
//
// Call with `const c = chartColors(t);` then use `c.damaged`, `c.destroyed`,
// etc. Multiple semantic keys may point at the same underlying color — that's
// intentional, so each chart can be retuned without affecting unrelated ones.

export interface ChartColors {
  // Damaged/destroyed pair (SBS daily, SBU Alfa targets, etc.)
  damaged: string;
  destroyed: string;
  damagedProjected: string;
  destroyedProjected: string;
  destroyedTrend: string;

  // Single-metric bar charts (RU air attacks monthly, RU MoD monthly, …)
  barDefault: string;
  barCurrent: string;       // last/current month highlight
  barCurrentProjected: string;

  // RU MoD day vs overnight split
  daytime: string;
  overnight: string;

  // Hourly chart
  hourlyToday: string;
  hourlyPastDay: string;

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
    damaged: t.primary,
    destroyed: COLOR_DESTROYED,
    damagedProjected: withProjectedAlpha(t.primary),
    destroyedProjected: withProjectedAlpha(COLOR_DESTROYED),
    destroyedTrend: COLOR_DESTROYED_TREND,

    barDefault: t.primary,
    barCurrent: t.accent,
    barCurrentProjected: withProjectedAlpha(t.accent),

    daytime: t.primary,
    overnight: t.accent,

    hourlyToday: t.accent,
    hourlyPastDay: COLOR_HOURLY_PAST_DAY,

    grid: t.chartGrid,
    maxReference: t.accent,
    medReference: t.muted,
    trend: t.muted,

    noteBorder: t.borderImportant,
    noteText: t.textImportant,
  };
}
