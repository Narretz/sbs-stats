import { type ReactNode } from "react";
import { DatabaseContext } from "@/context/useDatabaseContext";
import { useDatabase } from "@/hooks/useDatabase";

export function DatabaseProvider({ children }: { children: ReactNode }) {
  const db = useDatabase();
  return <DatabaseContext.Provider value={db}>{children}</DatabaseContext.Provider>;
}
