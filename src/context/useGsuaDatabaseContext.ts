import { createContext, useContext } from "react";
import { useDatabaseGsua } from "@/hooks/useDatabaseGsua";

type GsuaDatabaseContextValue = ReturnType<typeof useDatabaseGsua>;

// Context + its consumer hook live together here (no component export) so the
// provider .tsx stays Fast-Refresh-clean (react-refresh/only-export-components).
export const GsuaDatabaseContext = createContext<GsuaDatabaseContextValue | null>(null);

export function useGsuaDatabaseContext() {
  const ctx = useContext(GsuaDatabaseContext);
  if (!ctx) throw new Error("useGsuaDatabaseContext must be used inside <GsuaDatabaseProvider>");
  return ctx;
}
