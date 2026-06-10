import { type ReactNode } from "react";
import { SbuAlfaDatabaseContext } from "@/context/useSbuAlfaDatabaseContext";
import { useDatabaseSbuAlfa } from "@/hooks/useDatabaseSbuAlfa";

export function SbuAlfaDatabaseProvider({ children }: { children: ReactNode }) {
  const db = useDatabaseSbuAlfa();
  return <SbuAlfaDatabaseContext.Provider value={db}>{children}</SbuAlfaDatabaseContext.Provider>;
}
