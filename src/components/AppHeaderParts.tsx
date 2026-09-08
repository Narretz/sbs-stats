import type { ReactNode } from "react";
import { useTheme } from "@/hooks/useTheme";
import { useRoute } from "@/hooks/RouteContext";
import { FONTS } from "@/theme";
import { SITES, SITE_LABELS, type Site } from "@/types";

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

// Site switcher. `value` is the site you are on, or null on views that aren't
// a site — the homepage and the compare view — where it becomes a "browse by
// site…" jump menu instead of showing an arbitrary site as if it were current.
export function SitePicker({
  value, onChange,
}: { value: Site | null; onChange: (site: Site) => void }) {
  return (
    <select
      data-testid="site-picker"
      value={value ?? ""}
      onChange={(e) => { if (e.target.value) onChange(e.target.value as Site); }}
      className="ctl"
      style={{ maxWidth: "100%" }}
    >
      {value === null && <option value="">browse by site…</option>}
      {SITES.map((s) => (
        <option key={s} value={s}>{SITE_LABELS[s]}</option>
      ))}
    </select>
  );
}

export function ThemeToggle() {
  const { mode, toggle } = useTheme();
  return (
    <button
      onClick={toggle}
      title={`Switch to ${mode === "light" ? "dark" : "light"} mode`}
      className="ctl"
      style={{ padding: "5px 10px", fontSize: 14, lineHeight: 1 }}
    >
      {mode === "light" ? "🌙" : "☀️"}
    </button>
  );
}

// Dashed outline so it reads as leaving the current site rather than as another
// page of it. Stays visible on the compare view itself, in the pressed state —
// a nav item that vanishes once you arrive gives no sense of where you are.
export function CompareLink() {
  const { route, goSpecial } = useRoute();
  const active = route.kind === "special";
  return (
    <button
      className={active ? "ctl" : "ctl ctl-dashed"}
      data-testid="nav-compare"
      onClick={() => goSpecial("compare")}
      aria-pressed={active || undefined}
      aria-current={active ? "page" : undefined}
      title="Compare units side by side"
      style={{ whiteSpace: "nowrap", letterSpacing: "0.04em" }}
    >
      COMPARE
    </button>
  );
}
