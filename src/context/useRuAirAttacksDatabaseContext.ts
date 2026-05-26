import { useContext } from "react";
import { RuAirAttacksDatabaseContext } from "./RuAirAttacksDatabaseContext";

export function useRuAirAttacksDatabaseContext() {
  const ctx = useContext(RuAirAttacksDatabaseContext);
  if (!ctx) throw new Error("useRuAirAttacksDatabaseContext must be used inside <RuAirAttacksDatabaseProvider>");
  return ctx;
}
