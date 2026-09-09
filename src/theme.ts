// ─── Theme tokens ─────────────────────────────────────────────────────────────
// PT Sans is widely used in Ukrainian government / military digital platforms.
// PT Mono provides clean monospaced data display.
//
// This module is the SINGLE SOURCE OF TRUTH for every app-wide color. The rules
// that use them live in `src/styles/theme.css` and read them as CSS custom
// properties (`var(--color-primary)`, …); `ThemeProvider` publishes the active
// theme's values onto `<html>` so the stylesheet, inline `style` props and
// recharts (which needs real strings, not `var()`) all resolve to the same hex.
//
// Colors that are NOT app-wide live next to the chart that owns them — the HUR
// missile family palette (`components/missilePalette.ts`) and the qualitative
// palette for directions / freely-picked metrics (`chartColors.ts`).

export const FONTS = {
  display: "'PT Sans', 'Helvetica Neue', Arial, sans-serif",
  mono: "'PT Mono', 'Courier New', monospace",
} as const;

export interface Theme {
  // ── Surfaces & chrome ──────────────────────────────────────────────────
  bg: string;
  bgAlt: string;
  surface: string;
  surfaceBorder: string;
  border: string;
  text: string;
  textMuted: string;
  textFaint: string;
  primary: string;
  /** Text/glyph color on a `primary`-filled surface (pressed control, chip). */
  onPrimary: string;
  accent: string;
  muted: string;
  headerBg: string;
  chartGrid: string;
  borderImportant: string;
  textImportant: string;
  /** Hard error state. Stays red in both themes — `accent` turns orange in dark. */
  danger: string;

  // ── Chart data series ──────────────────────────────────────────────────
  // Every chart follows the same convention: the MAIN series is blue
  // (`series1`), a SECOND series against it is red (`series2`). Charts with
  // more than two series use a qualitative palette instead (see chartColors.ts).
  /** Main series — lines, bars, areas. */
  series1: string;
  /** Current/last bucket of the main series (today's bar, this month's bar). */
  series1Current: string;
  /** Second series drawn against the main one. */
  series2: string;
  /** Current/last bucket of the second series. */
  series2Current: string;
  /** Trend overlay on the second series — lighter, so it reads as derived. */
  series2Trend: string;
  /** De-emphasised series (past days behind today's line, "unattributed"). */
  seriesNeutral: string;
}

export const LIGHT: Theme = {
  bg:           "#f4f5f7",
  bgAlt:        "#eaecf0",
  surface:      "#ffffff",
  surfaceBorder:"#e2e5ea",
  border:       "#d0d5dd",
  text:         "#111827",
  textMuted:    "#6b7280",
  textFaint:    "#8B93A1",
  primary:      "#1d6fa4",   // steel blue — readable on white
  onPrimary:    "#ffffff",
  accent:       "#db2c18",   // strong red — today / current highlight
  muted:        "#70a65b",
  headerBg:     "rgba(244,245,247,0.92)",
  chartGrid:    "#e5e7eb",
  borderImportant: "#E17B6F",
  textImportant:   "#111827",
  danger:       "#dc2626",

  series1:        "#509CCD",
  series1Current: "#1d6fa4",
  series2:        "#DE6666",
  series2Current: "#C62121",
  series2Trend:   "#fca5a5",
  seriesNeutral:  "#9ca3af",
};

export const DARK: Theme = {
  bg:           "#080c14",
  bgAlt:        "#0d1420",
  surface:      "#0d1420",
  surfaceBorder:"#1a2540",
  border:       "#1a2540",
  text:         "#e2e8f0",
  textMuted:    "#64748b",
  textFaint:    "#374151",
  primary:      "#00d4ff",
  onPrimary:    "#ffffff",
  accent:       "#ff6b35",
  muted:        "#4a6fa5",
  headerBg:     "rgba(8,12,20,0.85)",
  chartGrid:    "#1a2540",
  borderImportant: "#ff6b35",
  textImportant:   "#ffffff",
  danger:       "#f87171",

  series1:        "#509CCD",
  series1Current: "#00d4ff",
  series2:        "#DE6666",
  series2Current: "#C62121",
  series2Trend:   "#fca5a5",
  seriesNeutral:  "#9ca3af",
};

// ── Theme ⇄ CSS custom properties ────────────────────────────────────────────
// `bgAlt` → `--color-bg-alt`. Derived rather than hand-listed so a new token
// can never be added to `Theme` and silently forgotten by the stylesheet.
export const cssVarName = (token: keyof Theme): string =>
  `--color-${String(token).replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`)}`;

/** `var(--color-…)` reference for a theme token, for use in CSS strings. */
export const cssVar = (token: keyof Theme): string => `var(${cssVarName(token)})`;

/** Publish a theme onto an element (in practice `<html>`) as CSS variables. */
export function applyThemeVars(el: HTMLElement, t: Theme): void {
  for (const [token, value] of Object.entries(t)) {
    el.style.setProperty(cssVarName(token as keyof Theme), value);
  }
  el.style.setProperty("--font-display", FONTS.display);
  el.style.setProperty("--font-mono", FONTS.mono);
}
