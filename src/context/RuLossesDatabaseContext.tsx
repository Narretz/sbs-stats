import { createContext, type ReactNode } from "react";
import { useDatabaseRuLosses } from "@/hooks/useDatabaseRuLosses";

type RuLossesDatabaseContextValue = ReturnType<typeof useDatabaseRuLosses>;

export const RuLossesDatabaseContext = createContext<RuLossesDatabaseContextValue | null>(null);

export function RuLossesDatabaseProvider({ children }: { children: ReactNode }) {
  const db = useDatabaseRuLosses();
  return <RuLossesDatabaseContext.Provider value={db}>{children}</RuLossesDatabaseContext.Provider>;
}
