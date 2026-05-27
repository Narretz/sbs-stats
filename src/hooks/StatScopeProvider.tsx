import { useState, useCallback, type ReactNode } from "react";
import { StatScopeContext, type StatScope } from "@/hooks/useStatScope";

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
