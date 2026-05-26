import { createContext, type ReactNode } from "react";
import { useDatabaseRuAirAttacks } from "@/hooks/useDatabaseRuAirAttacks";

type RuAirAttacksDatabaseContextValue = ReturnType<typeof useDatabaseRuAirAttacks>;

export const RuAirAttacksDatabaseContext = createContext<RuAirAttacksDatabaseContextValue | null>(null);

export function RuAirAttacksDatabaseProvider({ children }: { children: ReactNode }) {
  const db = useDatabaseRuAirAttacks();
  return <RuAirAttacksDatabaseContext.Provider value={db}>{children}</RuAirAttacksDatabaseContext.Provider>;
}
