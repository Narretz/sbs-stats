import { type ReactNode } from "react";
import { MediazonaDatabaseContext } from "@/context/useMediazonaDatabaseContext";
import { useDatabaseMediazona } from "@/hooks/useDatabaseMediazona";

export function MediazonaDatabaseProvider({ children }: { children: ReactNode }) {
  const db = useDatabaseMediazona();
  return <MediazonaDatabaseContext.Provider value={db}>{children}</MediazonaDatabaseContext.Provider>;
}
