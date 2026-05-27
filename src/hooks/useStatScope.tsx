import { createContext, useContext } from "react";

// Whether the chart MAX/MED reference lines are computed over the whole dataset
// ("all") or only the currently-visible window of points ("window"). A global
// display preference (like the theme), persisted to localStorage.
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
