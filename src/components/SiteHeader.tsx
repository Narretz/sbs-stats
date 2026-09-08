import { useTheme } from "@/hooks/useTheme";
import { useRoute } from "@/hooks/RouteContext";
import { FONTS } from "@/theme";
import { SITES, SITE_LABELS, type Page, type Site } from "@/types";
import { RefreshIndicator } from "@/components/RefreshIndicator";

interface SiteHeaderProps {
  site: Site;
  page: Page;
  pages: Page[];
  onSiteChange: (site: Site) => void;
  onPageChange: (page: Page) => void;
  // The home link is wired through RouteContext, so site Roots don't need to
  // pass it. Set `hideHome` to opt out (rarely needed).
  hideHome?: boolean;
  // Refresh / loading state from active DB context
  lastRefreshed: Date | null;
  refreshCount: number;
  onRefresh: () => void;
  isLoading: boolean;
  refreshIntervalMs: number;
  // Static views (e.g. the JSON-backed missiles prototype) have nothing to
  // refresh — hide the auto-refresh indicator for them.
  showRefresh?: boolean;
}

const PAGE_LABEL: Record<Page, string> = {
  daily: "DAILY",
  hourly: "HOURLY",
  monthly: "MONTHLY",
  weekly: "WEEKLY",
};

// Brand wordmark, abbreviated on narrow screens via CSS (both spans are in the
// DOM; the media query picks one). Doubles as the Home link.
function Brand({ onHome }: { onHome?: () => void }) {
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

function ThemeToggle() {
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

const headerShell = (background: string, border: string) => ({
  borderBottom: `1px solid ${border}`,
  backdropFilter: "blur(8px)",
  position: "sticky" as const,
  top: 0,
  zIndex: 10,
  background,
});

// Header for the unlisted `?view=…` comparison page. It has no site or page
// nav of its own, but it still needs a way back and a theme toggle — linking to
// a page with neither would make it a dead end.
export function SpecialViewHeader({ title }: { title: string }) {
  const { theme: t } = useTheme();
  const { goHome } = useRoute();
  return (
    <header className="app-header" style={headerShell(t.headerBg, t.border)}>
      <div className="app-header-group">
        <Brand onHome={goHome} />
        <span style={{
          fontFamily: FONTS.mono, fontSize: 11, color: t.textMuted,
          letterSpacing: "0.04em", whiteSpace: "nowrap",
        }}>
          {title}
        </span>
      </div>
      <div className="app-header-group">
        <ThemeToggle />
      </div>
    </header>
  );
}

export function SiteHeader({
  site, page, pages, onSiteChange, onPageChange, hideHome = false,
  lastRefreshed, refreshCount, onRefresh, isLoading, refreshIntervalMs,
  showRefresh = true,
}: SiteHeaderProps) {
  const { theme: t } = useTheme();
  const { goHome, goSpecial } = useRoute();
  const homeHandler = hideHome ? undefined : goHome;

  const navBtn = (target: Page, label: string) => (
    <button
      key={target}
      data-testid={`nav-${target}`}
      onClick={() => onPageChange(target)}
      style={{
        background: page === target ? t.primary : "transparent",
        color: page === target ? "#ffffff" : t.textMuted,
        border: `1px solid ${page === target ? t.primary : t.border}`,
        borderRadius: 4,
        padding: "5px 8px",
        fontFamily: FONTS.display,
        fontSize: 12,
        fontWeight: page === target ? 700 : 400,
        cursor: "pointer",
        letterSpacing: "0.04em",
        transition: "all 0.15s",
      }}
    >
      {label}
    </button>
  );

  return (
    <header className="app-header" style={headerShell(t.headerBg, t.border)}>
      {/* Brand + site picker */}
      <div className="app-header-group">
        <Brand onHome={homeHandler} />
        <select
          data-testid="site-picker"
          value={site}
          onChange={(e) => onSiteChange(e.target.value as Site)}
          style={{
            background: t.bgAlt,
            color: t.text,
            border: `1px solid ${t.border}`,
            borderRadius: 4,
            padding: "5px 8px",
            fontFamily: FONTS.mono,
            fontSize: 11,
            cursor: "pointer",
          }}
        >
          {SITES.map((s) => (
            <option key={s} value={s}>
              {SITE_LABELS[s]}
            </option>
          ))}
        </select>
      </div>

      {/* Nav + compare + refresh + theme */}
      <div className="app-header-group">
        {pages.map((p) => navBtn(p, PAGE_LABEL[p]))}
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
        {showRefresh && (
          <RefreshIndicator
            lastRefreshed={lastRefreshed}
            refreshCount={refreshCount}
            onRefresh={onRefresh}
            isLoading={isLoading}
            intervalMs={refreshIntervalMs}
          />
        )}
        <ThemeToggle />
      </div>
    </header>
  );
}
