// Shared vocabulary for the `subsetLabel` prop on chart tooltips (see
// TooltipTable). Kept in one place so a rename ("Interc" → "Down", say) is
// a single-file change instead of hunting through every page.
export const SUBSET_LABEL = {
  /** Hit / Destroyed pairs (SBS, per-target). */
  destroyed: "Dest",
  /** Personnel casualties / killed pair. */
  killed: "Killed",
  /** Launched / intercepted pairs (RU air-attacks). */
  intercepted: "Interc",
} as const;
