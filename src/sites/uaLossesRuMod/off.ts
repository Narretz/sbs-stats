// What `@/sites/uaLossesRuMod` resolves to in a build without
// SHOW_UA_LOSSES_RU_MOD=true (see index.tsx): the same exports, empty. Type
// imports only — anything else here would put the dataset's code back into
// the bundle this file exists to keep it out of.
import type { SiteConfig } from "@/sites/registry";
import type { UaLossesRuModDb } from "./index";

export type { UaLossesRuModDb };

export const uaLossesRuModSite: SiteConfig | null = null;

export const uaLossesRuModMetrics: ReadonlyArray<readonly [string, string]> = [];

// The homepage calls this unconditionally (it's a hook); with no site it is
// never `enabled`, so an idle handle whose queries return nothing will do.
const IDLE = {
  loadState: "idle",
  error: null,
  queryDaily: () => [],
  queryGlobalStats: () => ({}),
  queryMonthly: () => [],
  queryDataWindow: () => ({ minDate: null, maxDate: null }),
  refresh: () => {},
  lastRefreshed: null,
  refreshCount: 0,
  refreshIntervalMs: 0,
} as unknown as UaLossesRuModDb;

export const useUaLossesRuModDb = (opts?: { enabled?: boolean }): UaLossesRuModDb => {
  void opts;
  return IDLE;
};
