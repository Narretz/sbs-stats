import { useTheme } from "@/hooks/useTheme";
import { useRoute } from "@/hooks/RouteContext";
import { FONTS } from "@/theme";
import type { Page, Site } from "@/types";
import { RefreshIndicator } from "@/components/RefreshIndicator";
import {
  AppHeader, AppHeaderGroup, Brand, CompareLink, SitePicker, ThemeToggle,
} from "@/components/AppHeaderParts";

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

// Header for the unlisted `?view=…` comparison page. It has no site or page
// nav of its own, but it still needs a way back and a theme toggle — linking to
// a page with neither would make it a dead end.
export function SpecialViewHeader({ title }: { title: string }) {
  const { theme: t } = useTheme();
  const { goHome, goSite } = useRoute();
  return (
    <AppHeader>
      <AppHeaderGroup>
        <Brand onHome={goHome} />
        {/* No current site to show, so the picker is a jump menu — the same
            mode the homepage uses. Without it this view was a cul-de-sac you
            could only leave via Home. */}
        <SitePicker value={null} onChange={(s) => goSite(s)} />
        <span style={{
          fontFamily: FONTS.mono, fontSize: 11, color: t.textMuted,
          letterSpacing: "0.04em", whiteSpace: "nowrap",
        }}>
          {title}
        </span>
      </AppHeaderGroup>
      <AppHeaderGroup>
        <ThemeToggle />
      </AppHeaderGroup>
    </AppHeader>
  );
}

export function SiteHeader({
  site, page, pages, onSiteChange, onPageChange, hideHome = false,
  lastRefreshed, refreshCount, onRefresh, isLoading, refreshIntervalMs,
  showRefresh = true,
}: SiteHeaderProps) {
  const { theme: t } = useTheme();
  const { goHome } = useRoute();
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
    <AppHeader>
      {/* Brand + site picker */}
      <AppHeaderGroup>
        <Brand onHome={homeHandler} />
        <SitePicker value={site} onChange={onSiteChange} />
      </AppHeaderGroup>

      {/* Nav + compare + refresh + theme */}
      <AppHeaderGroup>
        {pages.map((p) => navBtn(p, PAGE_LABEL[p]))}
        <CompareLink />
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
      </AppHeaderGroup>
    </AppHeader>
  );
}
