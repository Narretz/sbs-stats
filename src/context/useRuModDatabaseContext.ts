import { useContext } from "react";
import { RuModDatabaseContext } from "./RuModDatabaseContext";

export function useRuModDatabaseContext() {
  const ctx = useContext(RuModDatabaseContext);
  if (!ctx) throw new Error("useRuModDatabaseContext must be used inside <RuModDatabaseProvider>");
  return ctx;
}
