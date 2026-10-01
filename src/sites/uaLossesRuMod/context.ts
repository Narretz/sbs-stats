// The dataset's DB context. Here rather than in src/context/databases.ts so
// that nothing outside this directory references the hook — see index.tsx.
import { makeDatabaseContext } from "@/context/makeDatabaseContext";
import { useDatabaseUaLossesRuMod } from "@/hooks/useDatabaseUaLossesRuMod";

export const { Provider: UaLossesRuModDatabaseProvider, useDbContext: useUaLossesRuModDatabaseContext } =
  makeDatabaseContext(useDatabaseUaLossesRuMod, "UA losses (RU MoD)");
