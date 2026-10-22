import type { RuLossesMetricKey } from "@/types";

// Days whose stored figure is not that day's losses. The daily value is the
// diff of the General Staff's war-to-date totals, which is right for every sum
// but folds anything the GS added in one go into a single day. Keyed by loss
// day (report day − 1, scripts/ru_losses/README.md).
//
// The figures stay as they are: changing one would leave every sum short of
// the GS's own total. The corrections come from PetroIvaniuk's
// russia_losses_equipment_correction.json, which the ingest deliberately never
// applies.
const NOTES: Record<string, Partial<Record<RuLossesMetricKey, string>>> = {
  "2022-02-24": {
    personnel: "First General Staff report (25 Feb): losses since the invasion began, not one day's.",
  },
  "2022-03-02": {
    personnel:
      "Early-war catch-up: the GS's rough running total jumped from about 5,840 to 9,000 in one report, so this is not one day's losses.",
  },
  "2025-02-27": {
    personnel: "Includes a +1,650 correction for earlier days; the day itself was about 1,060.",
  },
  "2025-04-21": {
    personnel: "Includes a +160 correction for earlier days; the day itself was about 1,130.",
  },
};

export function ruLossesNote(date: string, key: RuLossesMetricKey): string | undefined {
  return NOTES[date]?.[key];
}
