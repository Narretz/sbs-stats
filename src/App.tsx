import { useTheme } from "@/hooks/useTheme";
import { ThemeProvider } from "@/hooks/ThemeProvider";
import { StatScopeProvider } from "@/hooks/StatScopeProvider";
import { DatabaseProvider, SbuAlfaDatabaseProvider } from "@/context/databases";
import { SITE_REGISTRY, type SiteConfig } from "@/sites/registry";
import { useAppRoute } from "@/hooks/useAppRoute";
import { RouteProvider } from "@/hooks/RouteContext";
import { SiteHeader } from "@/components/SiteHeader";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ErrorScreen } from "@/components/Layout";
import { SbsVsSbuAlfaPage } from "@/pages/SbsVsSbuAlfaPage";
import { MissilesPage } from "@/pages/MissilesPage";
import { HomePage } from "@/pages/HomePage";
import type { Page, Site } from "@/types";
import { GLOBAL_CSS } from "@/theme";

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <main style={{ maxWidth: 1400, margin: "0 auto", padding: "32px 20px 64px" }}>
      {children}
    </main>
  );
}

function ErrorShell({ children }: { children: React.ReactNode }) {
  return (
    <ErrorBoundary fallback={(e) => <PageShell><ErrorScreen message={e.message} /></PageShell>}>
      {children}
    </ErrorBoundary>
  );
}

// Header + active page for one DB-backed site. Reads the site's refresh/load
// state from its consumer hook (so it must render inside the site's provider).
function SiteShell({
  entry, page, pages, site, setSite, setPage,
}: {
  entry: SiteConfig;
  page: Page; pages: Page[]; site: Site;
  setSite: (s: Site) => void; setPage: (p: Page) => void;
}) {
  const { loadState, refresh, lastRefreshed, refreshCount, refreshIntervalMs } = entry.useDbContext();
  const PageComponent = entry.pages[page];
  return (
    <>
      <SiteHeader
        site={site} page={page} pages={pages}
        onSiteChange={setSite} onPageChange={setPage}
        lastRefreshed={lastRefreshed} refreshCount={refreshCount}
        onRefresh={refresh} isLoading={loadState === "loading"}
        refreshIntervalMs={refreshIntervalMs}
      />
      <PageShell>
        {PageComponent && <PageComponent refreshKey={refreshCount} />}
      </PageShell>
    </>
  );
}

// Generic replacement for the former per-site *Root components: wraps the
// registry entry's provider and renders its shell. Adding a site needs no
// changes here — only a new SITE_REGISTRY entry.
function SiteRoot({
  entry, page, pages, site, setSite, setPage,
}: {
  entry: SiteConfig;
  page: Page; pages: Page[]; site: Site;
  setSite: (s: Site) => void; setPage: (p: Page) => void;
}) {
  const Provider = entry.provider;
  return (
    <ErrorShell>
      <Provider>
        <SiteShell entry={entry} site={site} page={page} pages={pages} setSite={setSite} setPage={setPage} />
      </Provider>
    </ErrorShell>
  );
}

// JSON-backed prototype: no DB provider, no page nav (the page has its own
// Production/Stockpile toggle), no refresh indicator. Not in SITE_REGISTRY.
function MissilesRoot({
  site, setSite, setPage,
}: {
  site: Site; setSite: (s: Site) => void; setPage: (p: Page) => void;
}) {
  return (
    <>
      <SiteHeader
        site={site} page="daily" pages={[]}
        onSiteChange={setSite} onPageChange={setPage}
        lastRefreshed={null} refreshCount={0}
        onRefresh={() => {}} isLoading={false}
        refreshIntervalMs={0} showRefresh={false}
      />
      <PageShell>
        <MissilesPage />
      </PageShell>
    </>
  );
}

function AppInner() {
  const { theme: t } = useTheme();
  const routeValue = useAppRoute();
  const { route, goSite, setSite, setPage, pagesFor } = routeValue;
  const site = route.kind === "site" ? route.site : "sbs";
  const page = route.kind === "site" ? route.page : "daily";
  const pages = pagesFor(site);
  const siteEntry = route.kind === "site" ? SITE_REGISTRY[route.site] : undefined;

  return (
    <RouteProvider value={routeValue}>
      <style>
        {GLOBAL_CSS(t)}
        {`@keyframes spin { from { stroke-dashoffset: 0; } to { stroke-dashoffset: -${2 * Math.PI * 11}px; } }`}
      </style>
      <div style={{ minHeight: "100vh", background: t.bg }}>
        {route.kind === "home" && (
          <ErrorShell>
            <HomePage onGoToSite={(s) => goSite(s)} />
          </ErrorShell>
        )}
        {route.kind === "site" && siteEntry && (
          <SiteRoot
            entry={siteEntry} site={site} page={page} pages={pages}
            setSite={setSite} setPage={setPage}
          />
        )}
        {route.kind === "site" && route.site === "ru-missiles-hur" && (
          <ErrorShell>
            <MissilesRoot site={site} setSite={setSite} setPage={setPage} />
          </ErrorShell>
        )}
        {route.kind === "special" && route.view === "sbs-vs-sbu-alfa" && (
          <ErrorShell>
            <DatabaseProvider>
              <SbuAlfaDatabaseProvider>
                <PageShell><SbsVsSbuAlfaPage /></PageShell>
              </SbuAlfaDatabaseProvider>
            </DatabaseProvider>
          </ErrorShell>
        )}
      </div>
    </RouteProvider>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <StatScopeProvider>
        <AppInner />
      </StatScopeProvider>
    </ThemeProvider>
  );
}
