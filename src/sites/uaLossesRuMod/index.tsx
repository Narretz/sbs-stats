// UA LOSSES - RU MoD (John Felix's sheet) — everything the app needs to show
// it, behind one import.
//
// The sheet has no licence. CI backs it up to R2, but displaying it is a
// build-time decision: `@/sites/uaLossesRuMod` resolves to this module only
// when SHOW_UA_LOSSES_RU_MOD=true (vite.config.ts), and to ./off.ts — the same
// exports, empty — otherwise. So a build without the flag doesn't merely hide
// the site: the hook, the pages and the context are not in the bundle at all.
// Keep it that way by importing the dataset's code only through here.
import type { SiteConfig } from "@/sites/registry";
import { useDatabaseUaLossesRuMod } from "@/hooks/useDatabaseUaLossesRuMod";
import { UaLossesRuModDailyPage } from "@/pages/UaLossesRuModDailyPage";
import { UaLossesRuModMonthlyPage } from "@/pages/UaLossesRuModMonthlyPage";
import { UA_LOSSES_RU_MOD_METRIC_KEYS, UA_LOSSES_RU_MOD_METRIC_LABELS } from "@/types";
import { UaLossesRuModDatabaseProvider, useUaLossesRuModDatabaseContext } from "./context";

export type UaLossesRuModDb = ReturnType<typeof useDatabaseUaLossesRuMod>;

export const uaLossesRuModSite: SiteConfig | null = {
  provider: UaLossesRuModDatabaseProvider,
  useDbContext: useUaLossesRuModDatabaseContext,
  pages: { daily: UaLossesRuModDailyPage, monthly: UaLossesRuModMonthlyPage },
};

// (key, label) per metric, for the homepage's combined charts.
export const uaLossesRuModMetrics: ReadonlyArray<readonly [string, string]> =
  UA_LOSSES_RU_MOD_METRIC_KEYS.map((k) => [k, UA_LOSSES_RU_MOD_METRIC_LABELS[k]] as const);

// For the homepage, which needs the DB without the site's provider.
export const useUaLossesRuModDb: (opts?: { enabled?: boolean }) => UaLossesRuModDb = useDatabaseUaLossesRuMod;
