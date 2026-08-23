import { createContext, useContext } from "react";
import { useDatabaseUaLosses } from "@/hooks/useDatabaseUaLosses";

type UaLossesDatabaseContextValue = ReturnType<typeof useDatabaseUaLosses>;

// Context + its consumer hook live together here (no component export) so the
// provider .tsx stays Fast-Refresh-clean (react-refresh/only-export-components).
export const UaLossesDatabaseContext = createContext<UaLossesDatabaseContextValue | null>(null);

export function useUaLossesDatabaseContext() {
  const ctx = useContext(UaLossesDatabaseContext);
  if (!ctx) throw new Error("useUaLossesDatabaseContext must be used inside <UaLossesDatabaseProvider>");
  return ctx;
}
