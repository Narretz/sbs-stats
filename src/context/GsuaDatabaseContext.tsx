import { createContext, type ReactNode } from "react";
import { useDatabaseGsua } from "@/hooks/useDatabaseGsua";

type GsuaDatabaseContextValue = ReturnType<typeof useDatabaseGsua>;

export const GsuaDatabaseContext = createContext<GsuaDatabaseContextValue | null>(null);

export function GsuaDatabaseProvider({ children }: { children: ReactNode }) {
  const db = useDatabaseGsua();
  return <GsuaDatabaseContext.Provider value={db}>{children}</GsuaDatabaseContext.Provider>;
}
