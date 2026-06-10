import { useTheme } from "@/hooks/useTheme";
import { ThemeProvider } from "@/hooks/ThemeProvider";
import { StatScopeProvider } from "@/hooks/StatScopeProvider";
import { DatabaseProvider } from "@/context/DatabaseContext";
import { useDatabaseContext } from "@/context/useDatabaseContext";
import { GsuaDatabaseProvider } from "@/context/GsuaDatabaseContext";
import { useGsuaDatabaseContext } from "@/context/useGsuaDatabaseContext";
import { RuLossesDatabaseProvider } from "@/context/RuLossesDatabaseContext";
import { useRuLossesDatabaseContext } from "@/context/useRuLossesDatabaseContext";
import { RuModDatabaseProvider } from "@/context/RuModDatabaseContext";
import { useRuModDatabaseContext } from "@/context/useRuModDatabaseContext";
import { RuAirAttacksDatabaseProvider } from "@/context/RuAirAttacksDatabaseContext";
import { useRuAirAttacksDatabaseContext } from "@/context/useRuAirAttacksDatabaseContext";
import { SbuAlfaDatabaseProvider } from "@/context/SbuAlfaDatabaseContext";
import { useSbuAlfaDatabaseContext } from "@/context/useSbuAlfaDatabaseContext";
import { useAppRoute } from "@/hooks/useAppRoute";
import { SiteHeader } from "@/components/SiteHeader";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ErrorScreen } from "@/components/Layout";
import { GsuaDailyPage } from "@/pages/GsuaDailyPage";
import { GsuaHourlyPage } from "@/pages/GsuaHourlyPage";
import { GsuaMonthlyPage } from "@/pages/GsuaMonthlyPage";
import { RuLossesDailyPage } from "@/pages/RuLossesDailyPage";
import { RuLossesMonthlyPage } from "@/pages/RuLossesMonthlyPage";
import { RuModDailyPage } from "@/pages/RuModDailyPage";
import { RuAirAttacksDailyPage } from "@/pages/RuAirAttacksDailyPage";
import { RuAirAttacksMonthlyPage } from "@/pages/RuAirAttacksMonthlyPage";
import { RuModMonthlyPage } from "@/pages/RuModMonthlyPage";
import { SbuAlfaMonthlyPage } from "@/pages/SbuAlfaMonthlyPage";
import { SbsDailyPage } from "@/pages/SbsDailyPage";
import { SbsHourlyPage } from "@/pages/SbsHourlyPage";
import { SbsMonthlyPage } from "@/pages/SbsMonthlyPage";
import type { Page, Site } from "@/types";
import { GLOBAL_CSS } from "@/theme";

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <main style={{ maxWidth: 1400, margin: "0 auto", padding: "32px 20px 64px" }}>
      {children}
    </main>
  );
}

function SbsRoot({
  page, pages, site, setSite, setPage,
}: {
  page: Page; pages: Page[]; site: Site;
  setSite: (s: Site) => void; setPage: (p: Page) => void;
}) {
  const { loadState, refresh, lastRefreshed, refreshCount, refreshIntervalMs } = useDatabaseContext();
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
        {page === "daily"   && <SbsDailyPage refreshKey={refreshCount} />}
        {page === "hourly"  && <SbsHourlyPage refreshKey={refreshCount} />}
        {page === "monthly" && <SbsMonthlyPage refreshKey={refreshCount} />}
      </PageShell>
    </>
  );
}

function GsuaRoot({
  page, pages, site, setSite, setPage,
}: {
  page: Page; pages: Page[]; site: Site;
  setSite: (s: Site) => void; setPage: (p: Page) => void;
}) {
  const { loadState, refresh, lastRefreshed, refreshCount, refreshIntervalMs } = useGsuaDatabaseContext();
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
        {page === "daily"   && <GsuaDailyPage refreshKey={refreshCount} />}
        {page === "hourly"  && <GsuaHourlyPage refreshKey={refreshCount} />}
        {page === "monthly" && <GsuaMonthlyPage refreshKey={refreshCount} />}
      </PageShell>
    </>
  );
}

function RuLossesRoot({
  page, pages, site, setSite, setPage,
}: {
  page: Page; pages: Page[]; site: Site;
  setSite: (s: Site) => void; setPage: (p: Page) => void;
}) {
  const { loadState, refresh, lastRefreshed, refreshCount, refreshIntervalMs } = useRuLossesDatabaseContext();
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
        {page === "daily"   && <RuLossesDailyPage refreshKey={refreshCount} />}
        {page === "monthly" && <RuLossesMonthlyPage refreshKey={refreshCount} />}
      </PageShell>
    </>
  );
}

function RuModRoot({
  page, pages, site, setSite, setPage,
}: {
  page: Page; pages: Page[]; site: Site;
  setSite: (s: Site) => void; setPage: (p: Page) => void;
}) {
  const { loadState, refresh, lastRefreshed, refreshCount, refreshIntervalMs } = useRuModDatabaseContext();
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
        {page === "daily" && <RuModDailyPage refreshKey={refreshCount} />}
        {page === "monthly" && <RuModMonthlyPage refreshKey={refreshCount} />}
      </PageShell>
    </>
  );
}

function RuAirAttacksRoot({
  page, pages, site, setSite, setPage,
}: {
  page: Page; pages: Page[]; site: Site;
  setSite: (s: Site) => void; setPage: (p: Page) => void;
}) {
  const { loadState, refresh, lastRefreshed, refreshCount, refreshIntervalMs } = useRuAirAttacksDatabaseContext();
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
        {page === "daily"   && <RuAirAttacksDailyPage refreshKey={refreshCount} />}
        {page === "monthly" && <RuAirAttacksMonthlyPage refreshKey={refreshCount} />}
      </PageShell>
    </>
  );
}

function SbuAlfaRoot({
  page, pages, site, setSite, setPage,
}: {
  page: Page; pages: Page[]; site: Site;
  setSite: (s: Site) => void; setPage: (p: Page) => void;
}) {
  const { loadState, refresh, lastRefreshed, refreshCount, refreshIntervalMs } = useSbuAlfaDatabaseContext();
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
        {page === "monthly" && <SbuAlfaMonthlyPage refreshKey={refreshCount} />}
      </PageShell>
    </>
  );
}

function AppInner() {
  const { theme: t } = useTheme();
  const { site, setSite, page, setPage, pagesFor } = useAppRoute();
  const pages = pagesFor(site);

  return (
    <>
      <style>
        {GLOBAL_CSS(t)}
        {`@keyframes spin { from { stroke-dashoffset: 0; } to { stroke-dashoffset: -${2 * Math.PI * 11}px; } }`}
      </style>
      <div style={{ minHeight: "100vh", background: t.bg }}>
        {site === "sbs" && (
          <ErrorBoundary fallback={(e) => <PageShell><ErrorScreen message={e.message} /></PageShell>}>
            <DatabaseProvider>
              <SbsRoot site={site} setSite={setSite} page={page} setPage={setPage} pages={pages} />
            </DatabaseProvider>
          </ErrorBoundary>
        )}
        {site === "ru-attacks-gsua" && (
          <ErrorBoundary fallback={(e) => <PageShell><ErrorScreen message={e.message} /></PageShell>}>
            <GsuaDatabaseProvider>
              <GsuaRoot site={site} setSite={setSite} page={page} setPage={setPage} pages={pages} />
            </GsuaDatabaseProvider>
          </ErrorBoundary>
        )}
        {site === "ru-losses-gsua" && (
          <ErrorBoundary fallback={(e) => <PageShell><ErrorScreen message={e.message} /></PageShell>}>
            <RuLossesDatabaseProvider>
              <RuLossesRoot site={site} setSite={setSite} page={page} setPage={setPage} pages={pages} />
            </RuLossesDatabaseProvider>
          </ErrorBoundary>
        )}
        {site === "ru-airdef-mod" && (
          <ErrorBoundary fallback={(e) => <PageShell><ErrorScreen message={e.message} /></PageShell>}>
            <RuModDatabaseProvider>
              <RuModRoot site={site} setSite={setSite} page={page} setPage={setPage} pages={pages} />
            </RuModDatabaseProvider>
          </ErrorBoundary>
        )}
        {site === "ru-air-attacks-gsua" && (
          <ErrorBoundary fallback={(e) => <PageShell><ErrorScreen message={e.message} /></PageShell>}>
            <RuAirAttacksDatabaseProvider>
              <RuAirAttacksRoot site={site} setSite={setSite} page={page} setPage={setPage} pages={pages} />
            </RuAirAttacksDatabaseProvider>
          </ErrorBoundary>
        )}
        {site === "sbu-alfa" && (
          <ErrorBoundary fallback={(e) => <PageShell><ErrorScreen message={e.message} /></PageShell>}>
            <SbuAlfaDatabaseProvider>
              <SbuAlfaRoot site={site} setSite={setSite} page={page} setPage={setPage} pages={pages} />
            </SbuAlfaDatabaseProvider>
          </ErrorBoundary>
        )}
      </div>
    </>
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
