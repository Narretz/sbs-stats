import { createContext, useContext } from "react";
import { useDatabaseMediazona } from "@/hooks/useDatabaseMediazona";

type MediazonaDatabaseContextValue = ReturnType<typeof useDatabaseMediazona>;

// Context + its consumer hook live together here (no component export) so the
// provider .tsx stays Fast-Refresh-clean (react-refresh/only-export-components).
export const MediazonaDatabaseContext = createContext<MediazonaDatabaseContextValue | null>(null);

export function useMediazonaDatabaseContext() {
  const ctx = useContext(MediazonaDatabaseContext);
  if (!ctx) throw new Error("useMediazonaDatabaseContext must be used inside <MediazonaDatabaseProvider>");
  return ctx;
}
