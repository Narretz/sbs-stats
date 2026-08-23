// One context per dataset, all instantiated from the shared factory. Providers
// and consumer hooks keep the names the rest of the app already imports, so this
// module is a drop-in for the former per-dataset context files. Pages import
// their consumer hook from here; the site registry (src/sites) wires the
// providers into the app shell.
import { makeDatabaseContext } from "@/context/makeDatabaseContext";
import { useDatabase } from "@/hooks/useDatabase";
import { useDatabaseGsua } from "@/hooks/useDatabaseGsua";
import { useDatabaseRuLosses } from "@/hooks/useDatabaseRuLosses";
import { useDatabaseRuMod } from "@/hooks/useDatabaseRuMod";
import { useDatabaseRuAirAttacks } from "@/hooks/useDatabaseRuAirAttacks";
import { useDatabaseSbuAlfa } from "@/hooks/useDatabaseSbuAlfa";
import { useDatabaseUaLosses } from "@/hooks/useDatabaseUaLosses";
import { useDatabaseMediazona } from "@/hooks/useDatabaseMediazona";

export const { Provider: DatabaseProvider, useDbContext: useDatabaseContext } =
  makeDatabaseContext(useDatabase, "SBS");

export const { Provider: GsuaDatabaseProvider, useDbContext: useGsuaDatabaseContext } =
  makeDatabaseContext(useDatabaseGsua, "GSUA");

export const { Provider: RuLossesDatabaseProvider, useDbContext: useRuLossesDatabaseContext } =
  makeDatabaseContext(useDatabaseRuLosses, "RU losses");

export const { Provider: RuModDatabaseProvider, useDbContext: useRuModDatabaseContext } =
  makeDatabaseContext(useDatabaseRuMod, "RU air-defense");

export const { Provider: RuAirAttacksDatabaseProvider, useDbContext: useRuAirAttacksDatabaseContext } =
  makeDatabaseContext(useDatabaseRuAirAttacks, "RU air-attacks");

export const { Provider: SbuAlfaDatabaseProvider, useDbContext: useSbuAlfaDatabaseContext } =
  makeDatabaseContext(useDatabaseSbuAlfa, "SBU Alfa");

export const { Provider: UaLossesDatabaseProvider, useDbContext: useUaLossesDatabaseContext } =
  makeDatabaseContext(useDatabaseUaLosses, "UA losses");

export const { Provider: MediazonaDatabaseProvider, useDbContext: useMediazonaDatabaseContext } =
  makeDatabaseContext(useDatabaseMediazona, "Mediazona");
