import { createContext, useContext, type ReactNode } from "react";
import type { useAppRoute } from "@/hooks/useAppRoute";

// Surface for components nested under <RouteProvider> to navigate without
// prop-drilling. SiteHeader uses it to wire the "home" link without each
// per-site Root component having to pass `onHome` down.
export type RouteValue = ReturnType<typeof useAppRoute>;

const RouteContext = createContext<RouteValue | null>(null);

export function RouteProvider({ value, children }: { value: RouteValue; children: ReactNode }) {
  return <RouteContext.Provider value={value}>{children}</RouteContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components -- hook + provider colocated; the trade-off is fine for this small surface
export function useRoute(): RouteValue {
  const v = useContext(RouteContext);
  if (!v) throw new Error("useRoute must be used inside <RouteProvider>");
  return v;
}
