import type { ReactNode } from "react";
import { useTheme } from "@/hooks/useTheme";
import { useRoute } from "@/hooks/RouteContext";
import { FONTS } from "@/theme";

// The pieces every app header is built from. They live here rather than in
// SiteHeader because the homepage and the unlisted compare view need the same
// chrome — before this, the homepage carried a hand-copied header that drifted:
// no compare link, and none of the responsive CSS.

// Sticky by default; the homepage scrolls its header away as it always has.
export function AppHeader({
  children, sticky = true,
}: { children: ReactNode; sticky?: boolean }) {
  const { theme: t } = useTheme();
  return (
    <header
      className="app-header"
      style={{
        borderBottom: `1px solid ${t.border}`,
        background: t.headerBg,
        ...(sticky
          ? { backdropFilter: "blur(8px)", position: "sticky" as const, top: 0, zIndex: 10 }
          : {}),
      }}
    >
      {children}
    </header>
  );
}

export function AppHeaderGroup({ children }: { children: ReactNode }) {
  return <div className="app-header-group">{children}</div>;
}

// Wordmark, abbreviated on narrow screens via CSS (both spans are in the DOM;
// the media query picks one). Doubles as the Home link when `onHome` is given —
// omitted on the homepage itself, where it would be a link to nowhere.
export function Brand({ onHome }: { onHome?: () => void }) {
  const { theme: t } = useTheme();
  return (
    <button
      onClick={onHome}
      disabled={!onHome}
      title={onHome ? "Home" : undefined}
      style={{
        display: "flex", alignItems: "center",
        background: "transparent", border: "none", padding: 0,
        cursor: onHome ? "pointer" : "default",
      }}
    >
      <span
        className="app-header-brand"
        style={{
          fontFamily: FONTS.display, fontSize: 13, fontWeight: 700,
          color: t.text, letterSpacing: "0.06em", textAlign: "left",
          whiteSpace: "nowrap",
        }}
      >
        <span className="app-header-brand-long">RU-UA WAR STATISTICS</span>
        <span className="app-header-brand-short">RU-UA WAR</span>
      </span>
    </button>
  );
}

export function ThemeToggle() {
  const { mode, theme: t, toggle } = useTheme();
  return (
    <button
      onClick={toggle}
      title={`Switch to ${mode === "light" ? "dark" : "light"} mode`}
      style={{
        background: t.bgAlt, border: `1px solid ${t.border}`, borderRadius: 4,
        padding: "5px 10px", cursor: "pointer", fontSize: 14, lineHeight: 1, color: t.text,
      }}
    >
      {mode === "light" ? "🌙" : "☀️"}
    </button>
  );
}

// Dashed outline so it reads as leaving the current site rather than as another
// page of it. Renders nothing when already on the compare view.
export function CompareLink() {
  const { theme: t } = useTheme();
  const { route, goSpecial } = useRoute();
  if (route.kind === "special") return null;
  return (
    <button
      data-testid="nav-compare"
      onClick={() => goSpecial("compare")}
      title="Compare units side by side"
      style={{
        background: "transparent",
        color: t.textMuted,
        border: `1px dashed ${t.border}`,
        borderRadius: 4,
        padding: "5px 8px",
        fontFamily: FONTS.display,
        fontSize: 12,
        cursor: "pointer",
        letterSpacing: "0.04em",
        whiteSpace: "nowrap",
      }}
    >
      COMPARE
    </button>
  );
}
