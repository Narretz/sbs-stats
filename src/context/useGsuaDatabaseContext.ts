import { useContext } from "react";
import { GsuaDatabaseContext } from "./GsuaDatabaseContext";

export function useGsuaDatabaseContext() {
  const ctx = useContext(GsuaDatabaseContext);
  if (!ctx) throw new Error("useGsuaDatabaseContext must be used inside <GsuaDatabaseProvider>");
  return ctx;
}
