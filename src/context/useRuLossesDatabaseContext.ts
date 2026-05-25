import { useContext } from "react";
import { RuLossesDatabaseContext } from "./RuLossesDatabaseContext";

export function useRuLossesDatabaseContext() {
  const ctx = useContext(RuLossesDatabaseContext);
  if (!ctx) throw new Error("useRuLossesDatabaseContext must be used inside <RuLossesDatabaseProvider>");
  return ctx;
}
