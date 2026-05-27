import { type ReactNode } from "react";
import { RuModDatabaseContext } from "@/context/useRuModDatabaseContext";
import { useDatabaseRuMod } from "@/hooks/useDatabaseRuMod";

export function RuModDatabaseProvider({ children }: { children: ReactNode }) {
  const db = useDatabaseRuMod();
  return <RuModDatabaseContext.Provider value={db}>{children}</RuModDatabaseContext.Provider>;
}
