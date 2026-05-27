import { createContext, useContext } from "react";
import { useDatabaseRuLosses } from "@/hooks/useDatabaseRuLosses";

type RuLossesDatabaseContextValue = ReturnType<typeof useDatabaseRuLosses>;

// Context + its consumer hook live together here (no component export) so the
// provider .tsx stays Fast-Refresh-clean (react-refresh/only-export-components).
export const RuLossesDatabaseContext = createContext<RuLossesDatabaseContextValue | null>(null);

export function useRuLossesDatabaseContext() {
  const ctx = useContext(RuLossesDatabaseContext);
  if (!ctx) throw new Error("useRuLossesDatabaseContext must be used inside <RuLossesDatabaseProvider>");
  return ctx;
}
