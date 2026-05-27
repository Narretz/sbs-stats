import { type ReactNode } from "react";
import { RuLossesDatabaseContext } from "@/context/useRuLossesDatabaseContext";
import { useDatabaseRuLosses } from "@/hooks/useDatabaseRuLosses";

export function RuLossesDatabaseProvider({ children }: { children: ReactNode }) {
  const db = useDatabaseRuLosses();
  return <RuLossesDatabaseContext.Provider value={db}>{children}</RuLossesDatabaseContext.Provider>;
}
