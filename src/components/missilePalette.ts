// Categorical palette for the multi-type missile charts (grid + stacked bar),
// grouped by weapon family so related categories visibly cluster:
//   • Cruise (warm: reds → oranges → yellows)
//   • Ballistic (cool: blue / green / violet / teal)
//   • Other (greys) — air-defence pool, SAM-derived strike, tactical Kh-family
// Within a family colours stay distinct enough to tell members apart while the
// overall hue family signals what kind of weapon you're looking at.

export type MissileCategory = "cruise" | "ballistic" | "other";

// Canonical-key → category. Source-faithful classifications get nudged so the
// user-facing buckets read intuitively: Zircon (hypersonic anti-ship) is shown
// alongside cruise; Kinzhal (aeroballistic) and Oreshnik (MRBM) sit with the
// ballistic systems.
export const MISSILE_CATEGORY: Record<string, MissileCategory> = {
  iskander_k: "cruise",
  kalibr: "cruise",
  kh101: "cruise",
  kh55: "cruise",
  kh555: "cruise",
  kh22_32: "cruise",
  kh69: "cruise",
  kh35: "cruise",
  oniks: "cruise",
  zircon: "cruise",
  iskander_m: "ballistic",
  kinzhal: "ballistic",
  kn23: "ballistic",
  oreshnik: "ballistic",
  rm48u: "ballistic",
  s300_s400_ad: "other",
  kh_tactical: "other",
};

export const MISSILE_CATEGORY_LABEL: Record<MissileCategory, string> = {
  cruise: "Cruise Missiles",
  ballistic: "Ballistic Missiles",
  other: "Other / Air Defense",
};

export const MISSILE_CATEGORY_ORDER: MissileCategory[] = ["cruise", "ballistic", "other"];

// Types whose checkbox starts off — currently the whole "other" bucket. AD pool
// is a different quantity from strike missiles (full SAM count, ~11k), and the
// Kh-29/31/35/58/59 entry is itself a 5-way lump, so neither belongs in a
// default by-type comparison.
export const MISSILE_HIDDEN_DEFAULT: string[] = Object.keys(MISSILE_CATEGORY).filter(
  (k) => MISSILE_CATEGORY[k] === "other",
);

// Reds → oranges → violets. 10 cruise types; ordering goes "anti-ship" specials
// at the ends, primary mass (Kalibr, Kh-101) up front in the brightest reds.
const CRUISE_COLORS = [
  // canonical red
  "#db2c18",
  "#E8796E",
  // deep red
  "#a82b1f",
  "#cf6b1e",
  "#e08a1e",
  "#f0a445",
  // violet
  "#8617D4",
  // pink
  "#F64EF0",
  // brown
  "#A16123",
];

// rgb(224, 120, 102)

// Blue / green / teal for the ballistic systems.
const BALLISTIC_COLORS = [
  "#2b7bd1", // blue
  "#18C2C8", // teal
  "#352AC1", // dark blue
  "#2AA936", // light blue
  "#3D705D", // dark green
];

const OTHER_COLORS = [
  "#5a5a5a", // s300_s400_ad (AD pool, darkest)
  "#9a9a9a", // kh_tactical
];

const CATEGORY_COLORS: Record<MissileCategory, string[]> = {
  cruise: CRUISE_COLORS,
  ballistic: BALLISTIC_COLORS,
  other: OTHER_COLORS,
};

// Assign each input key a colour from its category's palette in the order keys
// of that category appear in `keys`. Stable: a given key list always yields the
// same map, and the family hue is determined by MISSILE_CATEGORY (no risk of a
// cruise type bleeding into the ballistic palette as the type list grows).
export function colorMap(keys: string[]): Map<string, string> {
  const counters: Record<MissileCategory, number> = { cruise: 0, ballistic: 0, other: 0 };
  const m = new Map<string, string>();
  for (const k of keys) {
    const cat = MISSILE_CATEGORY[k] ?? "other";
    const palette = CATEGORY_COLORS[cat];
    const idx = counters[cat]++;
    m.set(k, palette[idx % palette.length]);
  }
  return m;
}
