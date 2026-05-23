import { useTheme } from "@/hooks/useTheme";
import { FONTS } from "@/theme";
import { SITES, SITE_LABELS, type Page, type Site } from "@/types";
import { RefreshIndicator } from "@/components/RefreshIndicator";

interface SiteHeaderProps {
  site: Site;
  page: Page;
  pages: Page[];
  onSiteChange: (site: Site) => void;
  onPageChange: (page: Page) => void;
  // Refresh / loading state from active DB context
  lastRefreshed: Date | null;
  refreshCount: number;
  onRefresh: () => void;
  isLoading: boolean;
}

const PAGE_LABEL: Record<Page, string> = {
  daily: "DAILY",
  hourly: "HOURLY",
  monthly: "MONTHLY",
};

export function SiteHeader({
  site, page, pages, onSiteChange, onPageChange,
  lastRefreshed, refreshCount, onRefresh, isLoading,
}: SiteHeaderProps) {
  const { mode, theme: t, toggle } = useTheme();

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
        padding: "5px 14px",
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
    <header
      style={{
        borderBottom: `1px solid ${t.border}`,
        padding: "0 24px",
        height: 52,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        backdropFilter: "blur(8px)",
        position: "sticky",
        top: 0,
        zIndex: 10,
        background: t.headerBg,
      }}
    >
      {/* Brand + site picker */}
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <div style={{ width: 8, height: 8, borderRadius: "50%", background: t.accent, animation: "blink 2s infinite" }} />
        <span
          style={{
            fontFamily: FONTS.display,
            fontSize: 13,
            fontWeight: 700,
            color: t.text,
            letterSpacing: "0.06em",
            minWidth: 140,
          }}
        >
          {SITE_LABELS[site]}
        </span>
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

      {/* Nav + refresh + theme */}
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        {pages.map((p) => navBtn(p, PAGE_LABEL[p]))}
        <RefreshIndicator
          lastRefreshed={lastRefreshed}
          refreshCount={refreshCount}
          onRefresh={onRefresh}
          isLoading={isLoading}
        />
        <button
          onClick={toggle}
          title={`Switch to ${mode === "light" ? "dark" : "light"} mode`}
          style={{
            background: t.bgAlt,
            border: `1px solid ${t.border}`,
            borderRadius: 4,
            padding: "5px 10px",
            cursor: "pointer",
            fontSize: 14,
            lineHeight: 1,
            color: t.text,
          }}
        >
          {mode === "light" ? "🌙" : "☀️"}
        </button>
      </div>
    </header>
  );
}
