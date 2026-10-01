import {
  UA_LOSSES_RU_MOD_ARMOUR_KEYS,
  UA_LOSSES_RU_MOD_ARMOUR_LABELS,
  type ModelBreakdownEntry,
  type UaLossesRuModArmourKey,
} from "@/types";

// The tooltip breakdown of the MoD's "tanks and other armoured vehicles" figure
// into Felix's itemised subgroups. The items are a reading of the report text,
// not the MoD's arithmetic: before 2025 they cover a fraction of the total, and
// now and then they overshoot it. So the remainder is always shown, signed —
// "Not itemised" going negative is the sheet itemising more than the MoD
// counted, which is worth seeing rather than clamping away.
export function armourBreakdown(
  total: number | null,
  parts: Partial<Record<UaLossesRuModArmourKey, number | null>>,
): ModelBreakdownEntry[] {
  if (total == null) return [];
  const entries: ModelBreakdownEntry[] = [];
  let itemised = 0;
  for (const k of UA_LOSSES_RU_MOD_ARMOUR_KEYS) {
    const v = parts[k];
    if (typeof v !== "number" || v === 0) continue;
    itemised += v;
    entries.push({ model: UA_LOSSES_RU_MOD_ARMOUR_LABELS[k], launched: v });
  }
  if (entries.length === 0) return [];
  const rest = total - itemised;
  if (rest !== 0) entries.push({ model: "Not itemised", launched: rest });
  return entries;
}
