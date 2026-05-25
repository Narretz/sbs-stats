import { createContext, type ReactNode } from "react";
import { useDatabaseRuMod } from "@/hooks/useDatabaseRuMod";

type RuModDatabaseContextValue = ReturnType<typeof useDatabaseRuMod>;

export const RuModDatabaseContext = createContext<RuModDatabaseContextValue | null>(null);

export function RuModDatabaseProvider({ children }: { children: ReactNode }) {
  const db = useDatabaseRuMod();
  return <RuModDatabaseContext.Provider value={db}>{children}</RuModDatabaseContext.Provider>;
}
