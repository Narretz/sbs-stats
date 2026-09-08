// ─── Theme tokens ─────────────────────────────────────────────────────────────
// PT Sans is widely used in Ukrainian government / military digital platforms.
// PT Mono provides clean monospaced data display.

export const FONTS = {
  display: "'PT Sans', 'Helvetica Neue', Arial, sans-serif",
  mono: "'PT Mono', 'Courier New', monospace",
} as const;

export interface Theme {
  bg: string;
  bgAlt: string;
  surface: string;
  surfaceBorder: string;
  border: string;
  text: string;
  textMuted: string;
  textFaint: string;
  primary: string;
  accent: string;
  muted: string;
  headerBg: string;
  chartGrid: string;
  borderImportant: string;
  textImportant: string;
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
  accent:       "#db2c18",   // strong red — today / current highlight
  muted:        "#70a65b",
  headerBg:     "rgba(244,245,247,0.92)",
  chartGrid:    "#e5e7eb",
  borderImportant:  "#E17B6F",
  textImportant:  "#111827",
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
  accent:       "#ff6b35",
  muted:        "#4a6fa5",
  headerBg:     "rgba(8,12,20,0.85)",
  chartGrid:    "#1a2540",
  borderImportant:  "#ff6b35",
  textImportant:  "#ffffff",  
};

export const GLOBAL_CSS = (t: Theme) => `
  @import url('https://fonts.googleapis.com/css2?family=PT+Sans:wght@400;700&family=PT+Mono&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html { scroll-behavior: smooth; }
  body {
    background: ${t.bg};
    color: ${t.text};
    font-family: ${FONTS.display};
    -webkit-font-smoothing: antialiased;
  }
  ::-webkit-scrollbar { width: 6px; }
  ::-webkit-scrollbar-track { background: ${t.bgAlt}; }
  ::-webkit-scrollbar-thumb { background: ${t.border}; border-radius: 3px; }
  @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0.25} }
  @keyframes fadeIn { from{opacity:0;transform:translateY(6px)} to{opacity:1;transform:translateY(0)} }
  /* ── Controls ──────────────────────────────────────────────────────────────
     One look for every chart/table control: selects, buttons, toggles, on the
     site pages and the compare view alike. Base styling lives here rather than
     inline because :hover can't be expressed inline at all, and an inline
     border/background would beat these rules anyway. */
  .ctl {
    background: ${t.surface};
    color: ${t.text};
    border: 1px solid ${t.border};
    border-radius: 4px;
    padding: 5px 8px;
    font-family: ${FONTS.mono};
    font-size: 11px;
    line-height: 1.2;
    cursor: pointer;
    transition: border-color 0.15s ease, background 0.15s ease, color 0.15s ease;
  }
  .ctl:hover { border-color: ${t.primary}; }
  .ctl:focus-visible { outline: 2px solid ${t.primary}; outline-offset: 1px; }
  .ctl:disabled { opacity: 0.5; cursor: default; }
  .ctl:disabled:hover { border-color: ${t.border}; }
  /* Pressed/selected: the same treatment the page nav uses for the current page. */
  .ctl[aria-pressed="true"] {
    background: ${t.primary};
    color: #ffffff;
    border-color: ${t.primary};
    font-weight: 700;
  }
  .ctl[aria-pressed="true"]:hover { border-color: ${t.primary}; }
  /* Leaves the current site rather than moving within it. */
  .ctl-dashed { border-style: dashed; color: ${t.textMuted}; background: transparent; }
  .ctl-dashed:hover { color: ${t.text}; border-color: ${t.primary}; }
  /* Checkbox in button chrome: the label is the hit area, the tick carries the
     state. No filled background — this toggles a detail, it isn't a mode. */
  .ctl-check { display: inline-flex; align-items: center; gap: 6px; user-select: none; }
  .ctl-check input { cursor: pointer; margin: 0; accent-color: ${t.primary}; }
  /* :has(:focus-visible), not :focus-within — the latter also fires on a mouse
     click and would leave a focus ring behind after every toggle. */
  .ctl-check:has(input:focus-visible) { outline: 2px solid ${t.primary}; outline-offset: 1px; }
  .ctl-check:has(input:checked) { border-color: ${t.primary}; color: ${t.text}; }

  .ctl-label {
    font-family: ${FONTS.mono};
    font-size: 10px;
    color: ${t.textMuted};
    letter-spacing: 0.04em;
    white-space: nowrap;
  }

  /* App header. Layout lives here rather than inline because inline styles beat
     media queries — a hard-coded height/padding can't be overridden below. */
  .app-header {
    display: flex; align-items: center; justify-content: space-between;
    gap: 12px; padding: 0 24px; height: 52px;
  }
  .app-header-group { display: flex; align-items: center; gap: 10px; }
  .app-header-brand { min-width: 140px; }
  .app-header-brand-short { display: none; }
  .refresh-text { display: flex; flex-direction: column; gap: 1px; min-width: 64px; }
  @media (max-width: 860px) {
    .app-header {
      height: auto; min-height: 52px; padding: 8px 12px;
      flex-wrap: wrap; row-gap: 8px; justify-content: flex-start;
    }
    .app-header-group { flex-wrap: wrap; gap: 8px; }
    /* The brand stops reserving a 140px column and drops to an abbreviation, so
       the site picker and nav have room to wrap onto one line rather than three. */
    .app-header-brand { min-width: 0; }
    .app-header-brand-long { display: none; }
    .app-header-brand-short { display: inline; }
    /* The countdown text is the least useful thing in a wrapped header — the
       dial still shows progress and the whole control stays clickable. */
    .refresh-text { display: none; }
  }

  /* Hover-elevation for any chart card: a tooltip that overflows the card's
     bottom edge would otherwise be painted over by the next chart-card
     sibling in the grid. Lifting the hovered card's stacking context keeps
     its absolutely-positioned tooltip on top. */
  .chart-card { position: relative; z-index: 1; }
  .chart-card:hover { z-index: 2; }
  /* Deep-linked charts (#<slug>) must clear the 52px sticky header AND the
     sticky controls bar under it, or the card lands behind them. The controls
     bar wraps to a variable height, so this is a generous fixed clearance
     rather than a measured one. Below 640px the controls bar is static
     (see .page-controls-sticky) so only the header needs clearing. */
  .chart-card { scroll-margin-top: 124px; }
  /* Matches the wrapped header heights measured at these widths — an anchored
     chart has to clear the sticky header, not hide behind it. */
  @media (max-width: 860px) { .chart-card { scroll-margin-top: 104px; } }
  @media (max-width: 520px) { .chart-card { scroll-margin-top: 136px; } }
  /* The "#" deep-link affordance on a chart title: present but silent until
     the title is hovered or keyboard-focused. Generated content on purpose —
     as a real span it landed in the heading's textContent, so the title read
     "Mortars #" to anything matching on text. */
  .chart-anchor::after { content: " #"; opacity: 0; transition: opacity 0.15s ease; }
  .chart-anchor:hover::after,
  .chart-anchor:focus-visible::after { opacity: 0.55; }
  /* Per-site pages' controls bar (time window, date nav, etc.) pinned right
     below the 52px SiteHeader. z-index sits below the header (z:10) so the
     header still covers it when scrolling, but above chart cards (z:1/2).
     Solid bg + subtle bottom border keeps content from showing through.
     On phone-sized screens the bar usually wraps to multiple rows and eats
     too much vertical real estate; let it scroll with the page there. */
  .page-controls-sticky {
    position: sticky;
    top: 52px;
    z-index: 8;
    background: ${t.bg};
    padding: 10px 0;
    border-bottom: 1px solid ${t.border};
  }
  @media (max-width: 640px) {
    .page-controls-sticky { position: static; }
  }
  /* The native <details>/<summary> triangle is too small at the page's 11px
     mono baseline — scale just the marker so the affordance is visible. */
  summary::marker { font-size: 1.6em; }
`;
