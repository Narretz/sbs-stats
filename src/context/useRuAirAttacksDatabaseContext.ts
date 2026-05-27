import { createContext, useContext } from "react";
import { useDatabaseRuAirAttacks } from "@/hooks/useDatabaseRuAirAttacks";

type RuAirAttacksDatabaseContextValue = ReturnType<typeof useDatabaseRuAirAttacks>;

// Context + its consumer hook live together here (no component export) so the
// provider .tsx stays Fast-Refresh-clean (react-refresh/only-export-components).
export const RuAirAttacksDatabaseContext = createContext<RuAirAttacksDatabaseContextValue | null>(null);

export function useRuAirAttacksDatabaseContext() {
  const ctx = useContext(RuAirAttacksDatabaseContext);
  if (!ctx) throw new Error("useRuAirAttacksDatabaseContext must be used inside <RuAirAttacksDatabaseProvider>");
  return ctx;
}
