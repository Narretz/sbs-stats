import type { ReactNode } from "react";
import { SbsDatabaseProvider, SbsUnitsDatabaseProvider } from "@/context/databases";
import { useRoute } from "@/hooks/RouteContext";

/**
 * SBS is the one site backed by two DBs: the grouping total in `sbs.db`, and
 * the per-unit tables in `sbs-units.db`. The second is mounted only on the
 * monthly page — the only page with unit data to show, since the hourly and
 * daily SBS pages read the grouping's intraday curve and there is no per-unit
 * equivalent of it.
 *
 * Conditional mounting rather than an `enabled` flag threaded through
 * `makeDatabaseContext`: the hook caches its Database at module scope, so
 * navigating monthly → daily → monthly re-mounts the provider without
 * re-fetching. The cost of getting the condition wrong is that consumers
 * outside the monthly page throw, which is the intended contract — an empty
 * unit registry returned silently would be worse.
 *
 * Its own file because `src/sites/registry.tsx` exports data, and a component
 * living alongside non-component exports breaks Fast Refresh.
 */
export function SbsProviders({ children }: { children: ReactNode }) {
  const { route } = useRoute();
  const onMonthly = route.kind === "site" && route.site === "sbs" && route.page === "monthly";
  return (
    <SbsDatabaseProvider>
      {onMonthly ? <SbsUnitsDatabaseProvider>{children}</SbsUnitsDatabaseProvider> : children}
    </SbsDatabaseProvider>
  );
}
