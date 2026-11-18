import { useState, useCallback, useEffect, type ReactNode } from "react";
import { STAT_SCOPE_PARAM, StatScopeContext, readStatScope, type StatScope } from "@/hooks/useStatScope";

function writeStatScope(s: StatScope) {
  const p = new URLSearchParams(window.location.search);
  if (s === "all") p.set(STAT_SCOPE_PARAM, s);
  else p.delete(STAT_SCOPE_PARAM);
  if (p.get("scope") === "all" || p.get("scope") === "window") p.delete("scope");
  const qs = p.toString();
  window.history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`);
}

export function StatScopeProvider({ children }: { children: ReactNode }) {
  const [scope, setScopeState] = useState<StatScope>(() => readStatScope(window.location.search));
  // Back/forward lands on an entry with its own base.
  useEffect(() => {
    const onPop = () => setScopeState(readStatScope(window.location.search));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const setScope = useCallback((s: StatScope) => {
    setScopeState(s);
    writeStatScope(s);
  }, []);
  return <StatScopeContext.Provider value={{ scope, setScope }}>{children}</StatScopeContext.Provider>;
}
