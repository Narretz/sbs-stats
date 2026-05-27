import { type ReactNode } from "react";
import { RuAirAttacksDatabaseContext } from "@/context/useRuAirAttacksDatabaseContext";
import { useDatabaseRuAirAttacks } from "@/hooks/useDatabaseRuAirAttacks";

export function RuAirAttacksDatabaseProvider({ children }: { children: ReactNode }) {
  const db = useDatabaseRuAirAttacks();
  return <RuAirAttacksDatabaseContext.Provider value={db}>{children}</RuAirAttacksDatabaseContext.Provider>;
}
