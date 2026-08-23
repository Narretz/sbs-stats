import { type ReactNode } from "react";
import { UaLossesDatabaseContext } from "@/context/useUaLossesDatabaseContext";
import { useDatabaseUaLosses } from "@/hooks/useDatabaseUaLosses";

export function UaLossesDatabaseProvider({ children }: { children: ReactNode }) {
  const db = useDatabaseUaLosses();
  return <UaLossesDatabaseContext.Provider value={db}>{children}</UaLossesDatabaseContext.Provider>;
}
