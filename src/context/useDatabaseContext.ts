import { createContext, useContext } from "react";
import { useDatabase } from "@/hooks/useDatabase";

type DatabaseContextValue = ReturnType<typeof useDatabase>;

// Context + its consumer hook live together here (no component export) so the
// provider .tsx stays Fast-Refresh-clean (react-refresh/only-export-components).
export const DatabaseContext = createContext<DatabaseContextValue | null>(null);

export function useDatabaseContext(): DatabaseContextValue {
  const ctx = useContext(DatabaseContext);
  if (!ctx) throw new Error("useDatabaseContext must be used inside <DatabaseProvider>");
  return ctx;
}
