import type { ReactNode } from "react";
import { useTheme } from "@/hooks/useTheme";
import { useRoute } from "@/hooks/RouteContext";
import { FONTS } from "@/theme";
import type { Site, SiteTier } from "@/types";
import { LISTED_SITES } from "@/sites/listed";

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

// The picker's groups, in order; SITES carries each site's tier.
const SITE_GROUPS: [SiteTier, string][] = [
  ["primary", "Main Datasets"],
  ["secondary", "Other Datasets"],
];

// Views that aren't a site, listed after the datasets under "Tools". The
// value is prefixed so it can't collide with a site key.
const TOOLS = [{ value: "tool:compare", view: "compare", label: "UNIT COMPARE" }] as const;

// Site switcher. `value` is the site you are on, or null on views that aren't
// a site. On a tool (the compare view) the picker shows that tool; on the
// homepage it becomes a "browse by site…" jump menu instead of showing an
// arbitrary site as if it were current. Picking a tool opens it.
export function SitePicker({
  value, onChange,
}: { value: Site | null; onChange: (site: Site) => void }) {
  const { route, goSpecial } = useRoute();
  const activeTool = route.kind === "special" ? TOOLS.find((tl) => tl.view === route.view) : undefined;
  const current = value ?? activeTool?.value ?? "";
  return (
    <select
      data-testid="site-picker"
      value={current}
      onChange={(e) => {
        const v = e.target.value;
        const tool = TOOLS.find((tl) => tl.value === v);
        if (tool) goSpecial(tool.view);
        else if (v) onChange(v as Site);
      }}
      className="ctl"
      style={{ maxWidth: "100%" }}
    >
      {current === "" && <option value="">browse by site…</option>}
      {SITE_GROUPS.map(([tier, label]) => (
        <optgroup key={tier} label={label}>
          {LISTED_SITES.filter((s) => s.tier === tier).map((s) => (
            <option key={s.key} value={s.key}>{s.label}</option>
          ))}
        </optgroup>
      ))}
      <optgroup label="Tools">
        {TOOLS.map((tl) => <option key={tl.value} value={tl.value}>{tl.label}</option>)}
      </optgroup>
    </select>
  );
}

export function ThemeToggle() {
  const { mode, toggle } = useTheme();
  return (
    <button
      onClick={toggle}
      title={`Switch to ${mode === "light" ? "dark" : "light"} mode`}
      className="ctl ctl-square"
      style={{ fontSize: 14, lineHeight: 1 }}
    >
      {mode === "light" ? "🌙" : "☀️"}
    </button>
  );
}

