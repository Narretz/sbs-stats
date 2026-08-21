// Categorical palette for the multi-type missile charts (grid + stacked bar),
// grouped by weapon family so related categories visibly cluster:
//   • Cruise (warm: reds → oranges → yellows)
//   • Ballistic (cool: blue / green / violet / teal)
//   • Other (greys) — air-defence pool, SAM-derived strike, tactical Kh-family
// Within a family colours stay distinct enough to tell members apart while the
// overall hue family signals what kind of weapon you're looking at.

export type MissileCategory = "cruise" | "lowcost_cruise" | "ballistic" | "other" | "drone";

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
  banderol: "lowcost_cruise",
  oniks: "cruise",
  zircon: "cruise",
  iskander_m: "ballistic",
  kinzhal: "ballistic",
  kn23: "ballistic",
  oreshnik: "ballistic",
  rm48u: "ballistic",
  s300_s400_ad: "other",
  kh_tactical: "other",
  geran45: "lowcost_cruise",
  geran2: "drone",
};

export const MISSILE_CATEGORY_LABEL: Record<MissileCategory, string> = {
  cruise: "Cruise Missiles",
  lowcost_cruise: "Low-Cost Cruise Missiles",
  ballistic: "Ballistic Missiles",
  other: "Other / Air Defense",
  drone: "Strike Drones",
};

export const MISSILE_CATEGORY_ORDER: MissileCategory[] = ["cruise", "lowcost_cruise", "ballistic", "other", "drone"];

// Types whose checkbox starts off. The "other" bucket (AD pool ~11k, and the
// Kh-29/31/35/58/59 5-way lump) is a different quantity from strike missiles;
// the "drone" bucket (Geran-2 ~thousands/month) is ~30x the missiles; and
// Geran-4/5 (a low-cost-cruise but also ~3000/month) is the same scale problem —
// so all of those start hidden and are opt-in. Banderol (~80/mo) stays shown.
export const MISSILE_HIDDEN_DEFAULT: string[] = [
  ...Object.keys(MISSILE_CATEGORY).filter(
    (k) => MISSILE_CATEGORY[k] === "other" || MISSILE_CATEGORY[k] === "drone",
  ),
  "geran45",
];

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
  // gold + rust — extra tones so all 10 cruise types stay distinct (fixes the
  // old zircon/iskander_k colour collision from a 9-colour palette).
  "#f4b942",
  "#9c4722",
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

// Low-cost cruise (jet-powered): Banderol + the jet Geran-4/5. A distinct
// orange/rust so they read apart from the classic cruise reds.
const LOWCOST_CRUISE_COLORS = [
  "#ff7a1a", // banderol
  "#8a4b10", // geran45
];

// Distinct magenta for the (hidden-by-default) strike-drone bucket (Geran-2),
// so it doesn't read as either the warm cruise or cool ballistic families.
const DRONE_COLORS = [
  "#d81b9a", // geran2
];

const CATEGORY_COLORS: Record<MissileCategory, string[]> = {
  cruise: CRUISE_COLORS,
  lowcost_cruise: LOWCOST_CRUISE_COLORS,
  ballistic: BALLISTIC_COLORS,
  other: OTHER_COLORS,
  drone: DRONE_COLORS,
};

// Assign each input key a colour from its category's palette in the order keys
// of that category appear in `keys`. Stable: a given key list always yields the
// same map, and the family hue is determined by MISSILE_CATEGORY (no risk of a
// cruise type bleeding into the ballistic palette as the type list grows).
export function colorMap(keys: string[]): Map<string, string> {
  const counters: Record<MissileCategory, number> = { cruise: 0, lowcost_cruise: 0, ballistic: 0, other: 0, drone: 0 };
  const m = new Map<string, string>();
  for (const k of keys) {
    const cat = MISSILE_CATEGORY[k] ?? "other";
    const palette = CATEGORY_COLORS[cat];
    const idx = counters[cat]++;
    m.set(k, palette[idx % palette.length]);
  }
  return m;
}
