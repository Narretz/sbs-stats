import {
  RUBIKON_CATEGORY_KEYS,
  RUBIKON_CATEGORY_LABELS,
  SBU_ALFA_CATEGORY_KEYS,
  SBU_ALFA_CATEGORY_LABELS,
  TARGET_LABELS,
  type RubikonCategoryKey,
  type SbuAlfaBound,
  type SbuAlfaCategoryKey,
  type TargetId,
} from "@/types";

// ─── Entities ────────────────────────────────────────────────────────────────
// An "entity" is one reporting unit whose monthly self-reports we can put in a
// column. Adding a dataset here means: an id, a label, a native-key vocabulary
// (below), and a snapshot builder in ComparePage that reads its hook.
export const COMPARE_ENTITIES = ["sbs", "sbu-alfa", "rubikon"] as const;
export type CompareEntityId = (typeof COMPARE_ENTITIES)[number];

export const ENTITY_LABELS: Record<CompareEntityId, string> = {
  sbs: "SBS (USF)",
  "sbu-alfa": "SBU «Альфа»",
  rubikon: "«Рубикон»",
};

// ─── Values ──────────────────────────────────────────────────────────────────
// What a cell knows. `bound` mirrors the SBU chart tooltips ("понад N" → a
// floor); `derived` marks a number this app computed rather than the source
// stating it.
export interface CompareValue {
  value: number;
  bound: SbuAlfaBound;
  derived: boolean;
  note?: string;      // source phrasing / derivation note, shown on hover
}

// One entity's data for the whole page, built once from its DB hook. The table
// then only ever asks it for (month, nativeKey) — no entity-specific branching
// in the rendering code.
export interface EntitySnapshot {
  id: CompareEntityId;
  months: string[];                                  // ascending, "YYYY-MM"
  get(month: string, nativeKey: string): CompareValue | null;
}

// The sum is only as precise as its least precise part — same rule the SBU
// hook uses when it rolls categories up.
const BOUND_PRECEDENCE: SbuAlfaBound[] = ["range", "up_to", "at_least", "approx", "exact"];

// Sum several native keys into one cell. Null only when the entity has none of
// them for that month — a present-but-zero counter stays a zero.
export function sumNatives(
  snap: EntitySnapshot,
  month: string,
  keys: readonly string[] | undefined,
): CompareValue | null {
  if (!keys?.length) return null;
  const parts = keys.map((k) => snap.get(month, k)).filter((p): p is CompareValue => p != null);
  if (!parts.length) return null;
  const bound =
    BOUND_PRECEDENCE.find((b) => parts.some((p) => p.bound === b)) ?? "exact";
  return {
    value: parts.reduce((s, p) => s + p.value, 0),
    bound,
    derived: parts.some((p) => p.derived),
    note: parts.length === 1 ? parts[0].note : undefined,
  };
}

// ─── Canonical rows ──────────────────────────────────────────────────────────
// The shared measurement axes. `map` lists the native keys each entity
// contributes (summed); an entity absent from `map` has no equivalent and its
// cell reads "—". `scope` carries the per-entity caveat about what is actually
// in the bucket — the reason these comparisons are readable at all.
//
// Groups exist because the two axes are not the same measurement: personnel are
// "killed" (no hit/damaged split anywhere), equipment is "struck" (уражено /
// «поражены» — hit, damage unspecified).
export type CompareGroup = "killed" | "struck";

export interface CompareRow {
  group: CompareGroup;
  key: string;                                        // stable id (URL/tests)
  label: string;
  indent?: boolean;
  map: Partial<Record<CompareEntityId, string[]>>;
  scope?: Partial<Record<CompareEntityId, string>>;
}

export const GROUP_LABELS: Record<CompareGroup, string> = {
  killed: "Killed",
  struck: "Hit / struck (уражено / поражены)",
};

// SBS scopes are transcribed from TARGET_LABELS, SBU's from the parser regexes
// and raw press-release phrasing, Rubikon's from its own «Поражены» line
// labels. Only rows whose scope is non-obvious carry a note.
export const CANONICAL_ROWS: CompareRow[] = [
  {
    group: "killed", key: "personnel", label: "Personnel",
    map: { sbs: ["personnel_killed"], "sbu-alfa": ["enemy_kia"], rubikon: ["personnel"] },
    scope: {
      sbs: "personnel_killed",
      "sbu-alfa": 'always phrased "понад N" (floor)',
      rubikon: "«Живая сила»",
    },
  },
  {
    group: "struck", key: "drones", label: "Drones (UAVs + UGVs)",
    map: {
      // id 26 = "Ворожі НРК" (enemy UGVs). Summed in so both sides count the
      // same "БпЛА + наземних роботизованих комплексів" bucket SBU's recap uses.
      sbs: ["hit_24", "hit_25", "hit_30", "hit_31", "hit_26"],
      "sbu-alfa": ["drones"],
      // Rubikon lists four drone lines separately; summed to reach the same
      // bucket. «Баба-Яга» is a heavy multirotor, so it belongs with the UAVs.
      rubikon: ["uav", "baba_yaga", "fixed_wing_uav", "ugv"],
    },
    scope: {
      sbs: "Copters + Fixed-wing + Shahed + Gerbera + UGVs",
      "sbu-alfa": "БпЛА та наземних роботизованих комплексів різного типу (НРК)",
      rubikon: "БпЛА + «Баба-Яга» + самолётного типа + НРК",
    },
  },
  {
    group: "struck", key: "vehicles", label: "Vehicles (autos)",
    map: { sbs: ["hit_7", "hit_19"], "sbu-alfa": ["vehicles_auto_total"], rubikon: ["vehicles"] },
    scope: {
      sbs: "Vehicles + Military buggies — excludes motorcycles",
      "sbu-alfa": "одиниць автомобільної техніки; may bundle motorcycles",
      rubikon: "«Автомобили» — motorcycles counted on their own line",
    },
  },
  {
    group: "struck", key: "artillery", label: "Artillery / SPGs",
    map: { sbs: ["hit_3", "hit_4"], "sbu-alfa": ["artillery"], rubikon: ["towed_artillery", "spg"] },
    scope: {
      sbs: "Cannons/Howitzers + Self-Propelled Artillery",
      "sbu-alfa": "артилерійських систем і САУ",
      rubikon: "Орудия/гаубицы + САУ — mortars counted separately",
    },
  },
  {
    group: "struck", key: "armored", label: "Armored (total)",
    map: {
      sbs: ["hit_1", "hit_2"], "sbu-alfa": ["armored_total"],
      rubikon: ["tanks", "afv_ifv", "apc"],
    },
    scope: {
      sbs: "Tanks + APCs / IFVs / ACVs",
      "sbu-alfa": "одиниць броньованої техніки (танки + ББМ)",
      rubikon: "Танки + ББМ/БМП + БТР",
    },
  },
  {
    group: "struck", key: "tanks", label: "Tanks", indent: true,
    map: { sbs: ["hit_1"], "sbu-alfa": ["tanks"], rubikon: ["tanks"] },
  },
  {
    group: "struck", key: "ifvs", label: "IFVs / APCs", indent: true,
    map: { sbs: ["hit_2"], "sbu-alfa": ["ifvs"], rubikon: ["afv_ifv", "apc"] },
    scope: {
      sbs: "APCs / IFVs / ACVs",
      "sbu-alfa": "бойових броньованих машин",
      rubikon: "ББМ, БМП + Бронетранспортеры (two source lines)",
    },
  },
  {
    group: "struck", key: "air_defense", label: "Air defense",
    map: { sbs: ["hit_32", "hit_33"], "sbu-alfa": ["air_defense"], rubikon: ["sam", "aa_guns"] },
    scope: {
      sbs: "SAM + AA guns",
      "sbu-alfa": "засобів ППО / протиповітряної оборони",
      rubikon: "ЗРК + зенитные орудия",
    },
  },
  {
    group: "struck", key: "mlrs", label: "MLRS",
    map: { sbs: ["hit_5"], "sbu-alfa": ["mlrs"], rubikon: ["mlrs"] },
    scope: {
      sbs: "MLRS (bundled SAM / AA guns until 2026-03)",
      "sbu-alfa": "РСЗВ",
      rubikon: "РСЗО",
    },
  },
  {
    // SBU switched from bare "N РЛС" (Apr/May) to "N засоби РЛС та РЕБ" (Jun);
    // the parser stores both under `radar`. SBS's closest bucket is id 9
    // (vehicle-mounted radar/ELINT/comms) — broader than pure РЛС but the
    // tightest match. hit_8/hit_10 (trench radar & EW) stay out: static
    // installations SBU wouldn't be counting. Rubikon's single «РЛС, РЭР, РЭБ»
    // line is the widest of the three — it is the source that doesn't split.
    group: "struck", key: "radar", label: "Radars",
    map: { sbs: ["hit_9"], "sbu-alfa": ["radar"], rubikon: ["radar_ew"] },
    scope: {
      sbs: "РЛС, РЕР та зв'язок (комплекси) — vehicle-mounted",
      "sbu-alfa": "РЛС (Apr/May); від Jun bundles РЕБ (EW)",
      rubikon: "«РЛС, РЭР, РЭБ» — one line, radar + SIGINT + EW together",
    },
  },
  {
    // Not in the old hardcoded table, which only ever had two columns and no
    // row for a counter SBU doesn't publish. Rubikon does publish it and SBS
    // has a matching target id, so it earns a shared row — otherwise the same
    // category would appear twice, once in each unit's "only in" section.
    group: "struck", key: "mortars", label: "Mortars",
    map: { sbs: ["hit_6"], rubikon: ["mortars"] },
    scope: { "sbu-alfa": "not broken out — «Альфа» reports артилерійських систем і САУ only" },
  },
  {
    group: "struck", key: "motorcycles", label: "Motorcycles",
    map: { sbs: ["hit_18"], rubikon: ["motorcycles"] },
    scope: { "sbu-alfa": "folded into its автомобільної техніки line — see Vehicles (autos)" },
  },
  {
    // id 23 is the retired launch-point counter (SBS moved to id 37 in
    // 2026-03); summing both keeps one continuous series across the switch.
    group: "struck", key: "uav_launch_points", label: "Drone launch / control points",
    map: { sbs: ["hit_37", "hit_23"], rubikon: ["uav_control_points"] },
    scope: {
      sbs: "Drone Launch Points (ids 37 + 23, the pre-2026-03 counter)",
      rubikon: "«Пункты управления БПЛА»",
    },
  },
  {
    group: "struck", key: "comms", label: "Communication systems",
    map: { "sbu-alfa": ["comms"], rubikon: ["comms"] },
    scope: {
      sbs: "no separate counter — comms sit inside id 9, see Radars",
      "sbu-alfa": "засобів зв'язку та спостереження",
    },
  },
  {
    group: "struck", key: "depots", label: "Ammo / fuel depots",
    map: { "sbu-alfa": ["depots"], rubikon: ["depots"] },
    scope: { sbs: "no depot counter in the SBS target list" },
  },
  {
    // SBS is deliberately absent here, carried over from the old page: it
    // reports shelters and dugouts at roughly 10x «Альфа»'s fortification
    // count, which breaks the "same measurement" reading the row implies.
    // Those ids stay in the SBS "only in" section instead.
    group: "struck", key: "fortifications", label: "Fortifications / engineering",
    map: { "sbu-alfa": ["fortifications"], rubikon: ["fortifications", "engineering_structures"] },
    scope: {
      sbs: "excluded — SBS reports shelters/dugouts at ~10x this scale (listed separately below)",
      "sbu-alfa": "укріплень та інженерних споруд",
      rubikon: "Фортификационные + инженерные сооружения (two source lines)",
    },
  },
  {
    // Rubikon has published no aircraft or naval line — a UAV unit operating
    // over the line of contact. Absent, not zero.
    group: "struck", key: "aircraft", label: "Aircraft",
    map: { sbs: ["hit_29", "hit_41"], "sbu-alfa": ["aircraft"] },
    scope: { sbs: "Helicopters + Fixed-wing planes", "sbu-alfa": "літак / одиниць авіаційної техніки" },
  },
  {
    group: "struck", key: "watercraft", label: "Fleet / watercraft",
    map: { sbs: ["hit_42"], "sbu-alfa": ["watercraft"] },
    scope: { sbs: "Флот (id 42) — naval targets", "sbu-alfa": "одиниць водного транспорту" },
  },
];

// ─── Native vocabularies ─────────────────────────────────────────────────────
// Every key an entity can produce, in display order, with its label. Anything
// here that no canonical row consumes becomes an "only in <entity>" row.
export interface NativeKey {
  key: string;
  label: string;
}

// Aggregates and parents are held out of the native lists: they restate other
// rows in the same column, so as standalone "unmapped" rows they'd read as
// extra targets. `targets_enumerated` / `targets_engaged_all` are this app's
// own roll-ups; `targets_*` are SBU's aggregate of the very bullets it lists;
// the three vehicle children are already inside the mapped parent.
const SBU_NOT_NATIVE = new Set<SbuAlfaCategoryKey>([
  "targets_enumerated", "targets_total", "targets_destroyed", "targets_damaged",
  "vehicles_light", "vehicles_moto", "vehicles_trucks",
]);
const RUBIKON_NOT_NATIVE = new Set<RubikonCategoryKey>(["targets_engaged_all"]);

// SBS: the `hit_*` columns only. `destroyed_*` is a subset of `hit_*` (the
// source reports both), and `total_*` sums the lot — either would double-count
// against the hit-based canonical rows.
const SBS_NATIVES: NativeKey[] = [
  { key: "personnel_killed", label: "Personnel Killed" },
  ...Object.keys(TARGET_LABELS).map((id) => ({
    key: `hit_${id}`,
    label: TARGET_LABELS[Number(id) as TargetId],
  })),
];

export const NATIVE_KEYS: Record<CompareEntityId, NativeKey[]> = {
  sbs: SBS_NATIVES,
  "sbu-alfa": SBU_ALFA_CATEGORY_KEYS.filter((k) => !SBU_NOT_NATIVE.has(k)).map((k) => ({
    key: k, label: SBU_ALFA_CATEGORY_LABELS[k],
  })),
  rubikon: RUBIKON_CATEGORY_KEYS.filter((k) => !RUBIKON_NOT_NATIVE.has(k)).map((k) => ({
    key: k, label: RUBIKON_CATEGORY_LABELS[k],
  })),
};

// Native keys already accounted for by a canonical row, per entity.
const MAPPED_NATIVES: Record<CompareEntityId, Set<string>> = {
  sbs: new Set(), "sbu-alfa": new Set(), rubikon: new Set(),
};
for (const row of CANONICAL_ROWS) {
  for (const [entity, keys] of Object.entries(row.map)) {
    for (const k of keys ?? []) MAPPED_NATIVES[entity as CompareEntityId].add(k);
  }
}

// What each entity reports that the shared mapping has no row for. Rendered in
// its own "only in <entity>" section so the comparable part of the table stays
// scannable — these are real published counters, just not commensurable.
export const UNMAPPED_NATIVES: Record<CompareEntityId, NativeKey[]> = {
  sbs: NATIVE_KEYS.sbs.filter((n) => !MAPPED_NATIVES.sbs.has(n.key)),
  "sbu-alfa": NATIVE_KEYS["sbu-alfa"].filter((n) => !MAPPED_NATIVES["sbu-alfa"].has(n.key)),
  rubikon: NATIVE_KEYS.rubikon.filter((n) => !MAPPED_NATIVES.rubikon.has(n.key)),
};

// ─── Formatting ──────────────────────────────────────────────────────────────
export function fmtValue(v: CompareValue): string {
  const s = v.value.toLocaleString();
  if (v.bound === "at_least") return `≥ ${s}`;
  if (v.bound === "approx") return `~${s}`;
  if (v.bound === "up_to") return `≤ ${s}`;
  return s;
}

// Change against the leftmost column. Undefined when there is nothing to
// compare against, or when the baseline is zero (percentage undefined — the
// cell shows the bare value instead of a misleading "+∞").
export function pctChange(base: CompareValue | null, v: CompareValue | null): number | null {
  if (!base || !v || base.value === 0) return null;
  return ((v.value - base.value) / base.value) * 100;
}

export function fmtPct(p: number): string {
  const sign = p > 0 ? "+" : p < 0 ? "−" : "±";
  return `${sign}${Math.abs(p).toFixed(1)}%`;
}
