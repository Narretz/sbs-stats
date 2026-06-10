import { createContext, useContext } from "react";
import { useDatabaseSbuAlfa } from "@/hooks/useDatabaseSbuAlfa";

type SbuAlfaDatabaseContextValue = ReturnType<typeof useDatabaseSbuAlfa>;

export const SbuAlfaDatabaseContext = createContext<SbuAlfaDatabaseContextValue | null>(null);

export function useSbuAlfaDatabaseContext() {
  const ctx = useContext(SbuAlfaDatabaseContext);
  if (!ctx) throw new Error("useSbuAlfaDatabaseContext must be used inside <SbuAlfaDatabaseProvider>");
  return ctx;
}
