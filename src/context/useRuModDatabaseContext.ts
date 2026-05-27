import { createContext, useContext } from "react";
import { useDatabaseRuMod } from "@/hooks/useDatabaseRuMod";

type RuModDatabaseContextValue = ReturnType<typeof useDatabaseRuMod>;

// Context + its consumer hook live together here (no component export) so the
// provider .tsx stays Fast-Refresh-clean (react-refresh/only-export-components).
export const RuModDatabaseContext = createContext<RuModDatabaseContextValue | null>(null);

export function useRuModDatabaseContext() {
  const ctx = useContext(RuModDatabaseContext);
  if (!ctx) throw new Error("useRuModDatabaseContext must be used inside <RuModDatabaseProvider>");
  return ctx;
}
