import { useContext } from "react";
import { DatabaseContext } from "@/context/DatabaseContext";
import { useDatabase } from "@/hooks/useDatabase";

type DatabaseContextValue = ReturnType<typeof useDatabase>;

export function useDatabaseContext(): DatabaseContextValue {
  const ctx = useContext(DatabaseContext);
  if (!ctx) throw new Error("useDatabaseContext must be used inside <DatabaseProvider>");
  return ctx;
}
