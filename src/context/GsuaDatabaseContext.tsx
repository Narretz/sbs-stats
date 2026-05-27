import { type ReactNode } from "react";
import { GsuaDatabaseContext } from "@/context/useGsuaDatabaseContext";
import { useDatabaseGsua } from "@/hooks/useDatabaseGsua";

export function GsuaDatabaseProvider({ children }: { children: ReactNode }) {
  const db = useDatabaseGsua();
  return <GsuaDatabaseContext.Provider value={db}>{children}</GsuaDatabaseContext.Provider>;
}
