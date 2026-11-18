import { createContext, useContext } from "react";

// Whether the chart MAX/MED reference lines are computed over the whole dataset
// ("all") or only the currently-visible window of points ("window"). A global
// display setting, kept in the URL as `base=` so a link reproduces the figures.
export type StatScope = "all" | "window";

export interface StatScopeValue {
  scope: StatScope;
  setScope: (s: StatScope) => void;
}

// Context + consumer hook only (no component export) so this stays
// Fast-Refresh-clean; the provider lives in StatScopeProvider.tsx.
export const StatScopeContext = createContext<StatScopeValue>({ scope: "all", setScope: () => {} });

export function useStatScope() {
  return useContext(StatScopeContext);
}

export const STAT_SCOPE_PARAM = "base";

// Default to "window" — most views are looked at over a short range, where the
// windowed MAX/MED is the more useful reference — so only "all" leaves a param.
// `scope=all|window` is the home page's older spelling, read so its links keep
// working; the compare page's own `scope=1` is neither value.
export function readStatScope(search: string): StatScope {
  const p = new URLSearchParams(search);
  const raw = p.get(STAT_SCOPE_PARAM) ?? p.get("scope");
  return raw === "all" ? "all" : "window";
}
