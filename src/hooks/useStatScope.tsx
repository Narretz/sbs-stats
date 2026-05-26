import { createContext, useContext, useState, useCallback, type ReactNode } from "react";

// Whether the chart MAX/MED reference lines are computed over the whole dataset
// ("all") or only the currently-visible window of points ("window"). A global
// display preference (like the theme), persisted to localStorage.
export type StatScope = "all" | "window";

interface StatScopeValue {
  scope: StatScope;
  setScope: (s: StatScope) => void;
}

const StatScopeContext = createContext<StatScopeValue>({ scope: "all", setScope: () => {} });

export function StatScopeProvider({ children }: { children: ReactNode }) {
  const [scope, setScopeState] = useState<StatScope>(() => {
    try {
      // Default to "window" — most views are looked at over a short range, where
      // the windowed MAX/MED is the more useful reference. Only an explicit "all"
      // overrides it.
      return localStorage.getItem("statScope") === "all" ? "all" : "window";
    } catch {
      return "window";
    }
  });
  const setScope = useCallback((s: StatScope) => {
    setScopeState(s);
    try { localStorage.setItem("statScope", s); } catch { /* ignore */ }
  }, []);
  return <StatScopeContext.Provider value={{ scope, setScope }}>{children}</StatScopeContext.Provider>;
}

export function useStatScope() {
  return useContext(StatScopeContext);
}
