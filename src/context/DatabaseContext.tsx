import { createContext, type ReactNode } from "react";
import { useDatabase } from "@/hooks/useDatabase";

type DatabaseContextValue = ReturnType<typeof useDatabase>;

export const DatabaseContext = createContext<DatabaseContextValue | null>(null);

export function DatabaseProvider({ children }: { children: ReactNode }) {
  const db = useDatabase();
  return <DatabaseContext.Provider value={db}>{children}</DatabaseContext.Provider>;
}
