import { describe, expect, it } from "vitest";
import { siteInfo, siteMenuLabel, siteTitle } from "@/types";
import { SOURCE_LABELS, findMetric } from "@/utils/combinedMetrics";

// Every name of a site is built from its topic and reporter (types/index.ts SITES).
describe("site names", () => {
  it("upper-cases the topic in the picker, never the reporter", () => {
    expect(siteMenuLabel(siteInfo("sbs"))).toBe("RU LOSSES & UA COMBAT STATS - SBS");
    expect(siteMenuLabel(siteInfo("ru-airdef-mod"))).toBe("UA UAV ATTACKS AD REPORTS - RU MoD");
    expect(siteMenuLabel(siteInfo("ua-losses"))).toBe("UA PERSONNEL LOSSES - ualosses.org");
  });

  it("leads a page title with the cadence, and ends it with what the page is narrowed to", () => {
    expect(siteTitle("sbs", "Daily")).toBe("Daily RU Losses & UA Combat Stats - SBS");
    expect(siteTitle("ru-attacks-gsua", "Monthly", "Pokrovsk")).toBe("Monthly RU Attacks & UA Combat Stats - GSUA — Pokrovsk");
    expect(siteTitle("pow-exchanges")).toBe("UA+RU POW Exchanges - Koord. HQ / RU MoD");
  });

  it("names a combined-chart metric after its site, and which of the site's sources it is", () => {
    expect(findMetric("sbs.hit_7")?.label).toBe("RU Losses & UA Combat Stats (SBS) · Vehicles — Hit");
    expect(SOURCE_LABELS["mediazona-roles"]).toBe("RU Personnel Losses (Mediazona — Roles)");
    expect(SOURCE_LABELS["sbs-unit"]).toBe("RU Losses & UA Combat Stats (SBS — Sub-unit)");
  });
});
