import { SITES, type Site, type SiteInfo } from "@/types";
import { SITE_REGISTRY } from "@/sites/registry";

// The sites this build offers: a `gated` one only if its build included it
// (see src/sites/uaLossesRuMod).
export const LISTED_SITES: readonly SiteInfo[] = SITES.filter(
  (s: SiteInfo) => !s.gated || s.key in SITE_REGISTRY,
);

export const isSite = (s: string): s is Site => LISTED_SITES.some((x) => x.key === s);
