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
  bgImportant: string;
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
  textFaint:    "#9ca3af",
  primary:      "#1d6fa4",   // steel blue — readable on white
  accent:       "#db2c18",   // strong red — today / current highlight
  muted:        "#70a65b",
  headerBg:     "rgba(244,245,247,0.92)",
  chartGrid:    "#e5e7eb",
  bgImportant:  "#db2c18",
  textImportant:  "#ffffff",
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
  bgImportant:  "#ff6b35",
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
`;
