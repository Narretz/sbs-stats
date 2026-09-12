import {
  RUBIKON_CATEGORY_KEYS,
  RUBIKON_CATEGORY_LABELS,
  SBU_ALFA_CATEGORY_KEYS,
  SBU_ALFA_CATEGORY_LABELS,
  TARGET_LABELS,
  type HitKey,
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

// ─── Native keys ─────────────────────────────────────────────────────────────
// The vocabulary each entity can be asked for, as a type. This is what makes a
// row's `map` autocomplete and — more to the point — makes a wrong key a
// compile error instead of a cell that silently renders "—".
//
// SBS is the odd one out: its source columns are numbered target ids
// (`hit_24`), not names, so a mapping written against them is unreadable and
// unverifiable by eye. These slugs are the vocabulary rows are written in;
// `SBS_COLUMNS` below is the only place the numbers appear. Ordered by target
// id, which is also the order the "only in SBS" section lists them.
export const SBS_TARGETS = {
  tanks: 1,
  apcs_ifvs: 2,
  cannons_howitzers: 3,
  spg: 4,
  mlrs: 5,
  mortars: 6,
  vehicles: 7,
  radar_vehicles: 9,
  ew_trench: 10,
  ew_vehicle: 12,
  motorcycles: 18,
  buggies: 19,
  shelters: 21,
  dugouts: 22,
  // Retired in 2026-03 when SBS moved launch points to id 37.
  drone_launch_points_legacy: 23,
  copter_uav: 24,
  fixed_wing_uav: 25,
  ugv: 26,
  helicopters: 29,
  shahed: 30,
  gerbera: 31,
  sam: 32,
  aa_guns: 33,
  anti_drone_uav: 35,
  drone_launch_points: 37,
  planes: 41,
  fleet: 42,
  energy_nodes: 43,
  radar_trench: 8,
  ew_equipment: 11,
  antennas: 13,
  network_equipment: 14,
  strategic_infrastructure: 16,
  tactical_infrastructure: 17,
  depots: 20,
  cameras: 27,
  other: 28,
  mlrs_portable: 36,
  depot_ammo: 38,
  depot_fuel: 39,
  depot_supplies: 40,
  // 15 ("ОС РОВ") and 34 ("ППО") are commented out of TARGET_IDS — see the note
  // there. Restore a slug here alongside re-enabling the id, or the
  // exhaustiveness check below will flag it.
} as const satisfies Record<string, TargetId>;

// `satisfies` above catches a slug pointing at an id that doesn't exist. This
// catches the other direction: a new target id added to TARGET_LABELS that
// nothing here names, which would otherwise silently drop out of the table.
type _AssertNever<T extends never> = T;
export type _UnnamedTargetIds = _AssertNever<
  Exclude<TargetId, (typeof SBS_TARGETS)[keyof typeof SBS_TARGETS]>
>;

// SBS is those slugs plus its three personnel counters and its own targets
// total. `destroyed_*` and `total_targets_destroyed` are excluded by
// construction (see SBS_NATIVES).
// `total_personnel_casualties` is the one aggregate that IS included: it is
// exactly killed + wounded in every month on record, and it is the only SBS
// figure commensurable with what the other two units publish.
// `total_targets_hit` is SBS's published «Targets Hit» figure — exactly the sum
// of every `hit_*` column in every month on record, so it must stay out of the
// native list (SBS_NATIVES) and out of any row a `hit_*` key also feeds, or it
// double-counts. The roll-up row is the one place it is read.
type SbsPersonnelKey = "personnel_killed" | "personnel_wounded" | "total_personnel_casualties";
type SbsFlightKey = "flights_strike" | "flights_recon";
type SbsTotalKey = "total_targets_hit";
export type SbsNativeKey = SbsPersonnelKey | SbsFlightKey | SbsTotalKey | keyof typeof SBS_TARGETS;

// Slug → the column the SBS monthly row actually carries.
export const SBS_COLUMNS: Record<
  SbsNativeKey, SbsPersonnelKey | SbsFlightKey | SbsTotalKey | HitKey
> = {
  personnel_killed: "personnel_killed",
  personnel_wounded: "personnel_wounded",
  total_personnel_casualties: "total_personnel_casualties",
  total_targets_hit: "total_targets_hit",
  flights_strike: "flights_strike",
  flights_recon: "flights_recon",
  ...(Object.fromEntries(
    Object.entries(SBS_TARGETS).map(([slug, id]) => [slug, `hit_${id}` as HitKey]),
  ) as Record<keyof typeof SBS_TARGETS, HitKey>),
};

export interface EntityNativeKey {
  sbs: SbsNativeKey;
  "sbu-alfa": SbuAlfaCategoryKey;
  rubikon: RubikonCategoryKey;
}

// Any entity's key. Used where a value is looked up after the entity is only
// known as a union (the table cells), so narrowing has already served its
// purpose at the point the mapping was written.
export type AnyNativeKey = EntityNativeKey[CompareEntityId];

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
  get(month: string, nativeKey: AnyNativeKey): CompareValue | null;
}

// The sum is only as precise as its least precise part — same rule the SBU
// hook uses when it rolls categories up.
const BOUND_PRECEDENCE: SbuAlfaBound[] = ["range", "up_to", "at_least", "approx", "exact"];

// Sum several native keys into one cell. Null only when the entity has none of
// them for that month — a present-but-zero counter stays a zero.
export function sumNatives(
  snap: EntitySnapshot,
  month: string,
  keys: readonly AnyNativeKey[] | undefined,
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

// ─── Unit size ───────────────────────────────────────────────────────────────
// Headcount is the one thing in this table the units do NOT publish, so these
// are outside estimates with all the softness that implies. Each entry is dated
// and the row resolves the newest estimate at or before the column's month —
// so a 2025 column shows what «Рубикон» was in 2025, not what it is now.
//
// Read them as orders of magnitude. SBS's is a factor-of-two range, «Альфа»'s
// is a statutory ceiling rather than a headcount, and only «Рубикон» has
// anything resembling a series.
export interface UnitSizeEstimate {
  asOf: string;          // "YYYY-MM" the figure describes
  value: number;
  bound: SbuAlfaBound;
  scope: string;         // caption under the number
  note: string;          // hover: what the figure covers
  sources: string[];     // where it came from — see the note above on `read`
}

// Gathered 2026-09-08. Two of these could not be fetched directly (403), so
// their figures come from search-result extracts of the same articles rather
// than from reading them end to end: hvylya.net and nv.ua. Everything else was
// read in full. Flagged because the «Рубикон» series — the only real time
// series in this table — leans on the hvylya piece for the 1,450 -> 5,000 and
// 9,000-authorised numbers, corroborated by FPRI/Two Marines.
const SOURCE = {
  sbsWiki: "https://en.wikipedia.org/wiki/Unmanned_Systems_Forces_(Ukraine)",
  sbsBrigade446:
    "https://euromaidanpress.com/2026/09/01/second-drone-brigade-in-two-months-ukraine-is-forming-the-446th-unmanned-systems-brigade/",
  alfaLaw: "https://en.ukrmilitary.com/2025/06/sbus-alpha-unit-to-be-renamed-and.html",
  alfaEmpr:
    "https://empr.media/news/ukraine/verkhovna-rada-significantly-expands-sbus-elite-alpha-special-forces-unit/",
  alfaWiki: "https://en.wikipedia.org/wiki/Alpha_Group_(Ukraine)",
  rubikonWiki:
    "https://ru.wikipedia.org/wiki/%D0%A0%D1%83%D0%B1%D0%B8%D0%BA%D0%BE%D0%BD_(%D1%86%D0%B5%D0%BD%D1%82%D1%80_%D0%B1%D0%B5%D1%81%D0%BF%D0%B8%D0%BB%D0%BE%D1%82%D0%BD%D1%8B%D1%85_%D1%81%D0%B8%D1%81%D1%82%D0%B5%D0%BC)",
  rubikonHvylya:  // not fetchable (403) — figures via search extract
    "https://help.hvylya.net/327464-rubikon-vyros-do-5-tysyach-chelovek-chto-izvestno-ob-elitnyh-dronovyh-silah-rf",
  rubikonFpri:
    "https://www.fpri.org/article/2026/06/inside-rubicon-the-structure-of-russias-elite-drone-center/",
  rubikonTwoMarines: "https://twomarines.substack.com/p/rubicon-structure",
} as const;

const UNIT_SIZE: Record<CompareEntityId, UnitSizeEstimate[]> = {
  // Ascending by asOf.
  sbs: [
    {
      asOf: "2024-06", value: 3000, bound: "approx",
      scope: "at founding (11 Jun 2024) — a new branch, not a unit",
      note: "Unmanned Systems Forces stood up 11 Jun 2024 under Col. Vadym Sukharevsky.",
      sources: [SOURCE.sbsWiki],
    },
    {
      asOf: "2026-01", value: 60000, bound: "approx",
      scope: "estimates span 40,000–80,000 · whole branch incl. support · ~2.2% of the AFU",
      note: "A service branch of 8+ unmanned systems brigades plus regiments, battalions, training and logistics — the headcount includes everyone, not just operators. Still growing: the 445th and 446th brigades formed during 2026.",
      sources: [SOURCE.sbsWiki, SOURCE.sbsBrigade446],
    },
  ],
  "sbu-alfa": [
    {
      asOf: "2025-06", value: 10000, bound: "up_to",
      scope: "STATUTORY CEILING, not a headcount · actual never published, reported as \"a few thousand\"",
      note: "Draft law No. 13353 (9 Jun 2025) set Alfa at no fewer than 10,000 in peace and wartime and renamed it Centre of Special Operations «А»; the same law raised the whole SBU cap to 37,000/41,000. The figure is what the unit was authorised to grow into, not what it fields.",
      sources: [SOURCE.alfaLaw, SOURCE.alfaEmpr, SOURCE.alfaWiki],
    },
  ],
  rubikon: [
    {
      asOf: "2025-04", value: 1450, bound: "approx",
      scope: "7–8 detachments of 100–150",
      note: "7–8 detachments of 100–150 in spring 2025.",
      sources: [SOURCE.rubikonFpri, SOURCE.rubikonTwoMarines, SOURCE.rubikonWiki],
    },
    {
      asOf: "2025-11", value: 5000, bound: "approx",
      scope: "~3.5x in a year · authorised strength 9,000",
      note: "Roughly 3.5x in a year, against an authorised establishment of 9,000.",
      sources: [SOURCE.rubikonHvylya, SOURCE.rubikonWiki, SOURCE.rubikonFpri],
    },
    {
      asOf: "2026-06", value: 5000, bound: "approx",
      scope: "authorised 9,000 · 17 detachments + 2 battalions + 6 companies · detachment establishment 149 → 474",
      note: "Detachments became self-contained formations with their own FPV, recon, EW and counter-UAV elements rather than pure drone teams. Subordinate to Russia's Unmanned Systems Troops; commander Col. Sergey Budnikov.",
      sources: [SOURCE.rubikonFpri, SOURCE.rubikonTwoMarines, SOURCE.rubikonHvylya],
    },
  ],
};

// Newest estimate at or before `month`. Null before the first one — better an
// empty cell than a figure predating the column it sits in.
export function unitSizeAt(entity: CompareEntityId, month: string): ResolvedCell | null {
  const applicable = UNIT_SIZE[entity].filter((e) => e.asOf <= month);
  const e = applicable[applicable.length - 1];
  if (!e) return null;
  const stale = e.asOf !== month ? ` (as of ${e.asOf})` : "";
  // Hosts rather than full URLs: the tooltip is a plain `title`, so a reader
  // can't copy a link out of it anyway — the URLs are in SOURCE for auditing.
  return {
    value: {
      value: e.value,
      bound: e.bound,
      derived: false,
      note: e.note,
    },
    scope: `${e.scope}${stale}`,
  };
}

// ─── Canonical rows ──────────────────────────────────────────────────────────
// The shared measurement axes. `map` lists the native keys each entity
// contributes (summed); an entity absent from `map` has no equivalent and its
// cell reads "—". `scope` carries the per-entity caveat about what is actually
// in the bucket — the reason these comparisons are readable at all.
//
// Groups exist because the two axes are not the same measurement. They are NOT
// "killed" vs "struck": only SBS says killed. «Альфа» says «знешкодили» /
// «відмінусували» (neutralised) and «Рубикон» files personnel under «Поражены»
// (engaged) using the same verb it uses for tanks. Each column's verb is in its
// scope caption, because the header can't be true of all three at once.
export type CompareGroup = "context" | "activity" | "totals" | "personnel" | "struck";

// What every row has, parent or child. Children reuse this shape, which is
// also what makes a child structurally unable to have children of its own.
// A cell whose value doesn't come from a dataset — see UNIT_SIZE. Returns its
// own caption too, because unlike a static scope note the wording changes with
// the column's month.
export interface ResolvedCell {
  value: CompareValue;
  scope: string;
}

export interface CompareRowBase {
  key: string;                                        // stable id (URL/tests)
  label: string;
  // Per-entity native keys, summed into one cell. Typed against that entity's
  // own vocabulary, so `"sbu-alfa": ["uav_crews"]` fails to compile — the key
  // is `drone_crews`.
  map: { [E in CompareEntityId]?: EntityNativeKey[E][] };
  // Rendered as a caption under the value — and ONLY when there is a value:
  // an entity with nothing to show gets a bare "—", since a caption explaining
  // an absence is noise on every row that has one.
  scope?: Partial<Record<CompareEntityId, string>>;
  // Supplies the cell directly instead of summing native keys. `map` is then
  // empty and the row is always shown.
  resolve?: (entity: CompareEntityId, month: string) => ResolvedCell | null;
  // Flags every cell of this row as this app's arithmetic, even where the parts
  // are published figures. Only the roll-up row sets it: it is the row a reader
  // is likeliest to quote as "the unit's monthly figure", and two of its three
  // columns already arrive flagged from their hooks — SBS's sum sitting bare
  // beside them would read as SBS having published that number.
  derivedSum?: boolean;
}

export interface CompareRow extends CompareRowBase {
  group: CompareGroup;
  // A breakdown of this row, rendered indented directly beneath it. Nesting is
  // the structure: a child can't drift away from its parent when CANONICAL_ROWS
  // is reordered, the way two adjacent flat rows could.
  //
  // Children are NOT summed into the parent and never subtracted from it — the
  // table only displays values, so a child appearing next to the parent that
  // contains it double-counts nothing. (Contrast useDatabaseSbuAlfa's
  // PARENT_CHILDREN, which does sum and therefore has to skip children.)
  children?: CompareRowBase[];
}

// One rendered line: a parent, or a child flattened out with the group it
// inherits and the indent that shows the relationship.
export interface FlatRow extends CompareRowBase {
  group: CompareGroup;
  indent: boolean;
  // Unique across the whole table, which `key` is not: a child's key only has
  // to be unique among its siblings, so "Vehicles" can sit under "Vehicles
  // (autos)" with both keyed `vehicles`. Namespacing children by their parent
  // keeps React's key space clean — a collision there silently drops rows.
  id: string;
}

// The rows worth rendering for the entities currently in columns, already
// flattened in display order.
//
// A subtree survives if the parent OR any child has a mapping — dropping a
// parent whose children still have data would hide those rows entirely, so the
// parent stays even when it can only render dashes.
export function visibleRowsFor(entities: CompareEntityId[]): FlatRow[] {
  const mapped = (r: CompareRowBase) => entities.some((e) => r.map[e]?.length);
  const out: FlatRow[] = [];
  for (const row of CANONICAL_ROWS) {
    const children = (row.children ?? []).filter(mapped);
    if (!row.resolve && !mapped(row) && !children.length) continue;
    out.push({ ...row, indent: false, id: row.key });
    for (const child of children) {
      out.push({ ...child, group: row.group, indent: true, id: `${row.key}/${child.key}` });
    }
  }
  return out;
}

export const GROUP_LABELS: Record<CompareGroup, string> = {
  // The one group that is NOT a unit self-report — outside estimates, so that
  // everything below it can be read per capita. Kept first because it is the
  // denominator for the rest of the table.
  context: "Unit size — outside estimates, not reported by the units",
  // Sorties are what the unit did, not what it destroyed — a separate axis
  // from everything below, and the denominator for it. Ordered first because
  // «Рубикон»'s own recap opens with the sortie count before «Поражены:».
  activity: "Activity — sorties flown",
  // The headline figure, and the one group whose numbers are arithmetic rather
  // than a quoted counter: no unit publishes a total of everything it reports
  // (SBS publishes one for targets, but with personnel outside it). It is NOT
  // the sum of the rows below — those are only the categories that map across
  // units, and each unit reports counters that never reach one.
  totals: "All reported categories — summed by this app, not published as a total",
  personnel: "Personnel",
  struck: "Hit / struck (уражено / поражены)",
};

// SBS scopes are transcribed from TARGET_LABELS, SBU's from the parser regexes
// and raw press-release phrasing, Rubikon's from its own «Поражены» line
// labels. Only rows whose scope is non-obvious carry a note.
export const CANONICAL_ROWS: CompareRow[] = [
  {
    group: "context", key: "unit_size", label: "Unit size (personnel)",
    map: {},
    resolve: unitSizeAt,
  },
  {
    // «Боевой вылет» covers any operational sortie, reconnaissance included,
    // and «Рубикон» publishes one figure — so SBS's two counters are summed to
    // match, with its split nested below. «Альфа» publishes no sortie count;
    // it is not a drone-flying unit in the way the other two are.
    group: "activity", key: "sorties", label: "Combat sorties",
    map: {
      sbs: ["flights_strike", "flights_recon"],
      rubikon: ["combat_sorties"],
    },
    scope: {
      rubikon: "«Выполнено N боевых вылетов»",
    },
    children: [
      {
        key: "flights_strike", label: "strike",
        map: { sbs: ["flights_strike"] },
      },
      {
        key: "flights_recon", label: "recon",
        map: { sbs: ["flights_recon"] },
      },
    ],
  },
  {
    // The one figure a reader looks for first, and the one none of the three
    // publishes: «Альфа» and «Рубикон» state no total at all (their hooks sum
    // the recap's own lines into `targets_enumerated` / `targets_engaged_all`,
    // flagged derived), and SBS's published «Targets Hit» total counts target
    // classes only — personnel sit outside it. So personnel are added back on
    // the SBS side, because the other two totals have them baked in: «Рубикон»
    // files «Живая сила» under «Поражены» and «Альфа»'s sum includes its KIA
    // line. Leaving them out of SBS alone understated it by ~20% (2026-08:
    // 57,482 against a comparable 68,492).
    //
    // Not a sum of the rows below it: it is each unit's whole reported output,
    // including the counters that never reach a shared row and land in "only
    // in <entity>". The unit-size row above is the denominator that makes the
    // three comparable at all — «Рубикон»'s 17,485 comes off ~5,000 people.
    group: "totals", key: "targets_all", label: "All targets engaged — sum of categories",
    derivedSum: true,
    map: {
      sbs: ["total_targets_hit", "total_personnel_casualties"],
      "sbu-alfa": ["targets_enumerated"],
      rubikon: ["targets_engaged_all"],
    },
    scope: {
      sbs: "«Targets Hit» (all target classes, SBS's own total) + personnel casualties, added here",
      "sbu-alfa": "every category the recap lists, personnel included — a floor: the list is «серед» («among») what was hit, and the KIA line is itself qualified",
      rubikon: "every «Поражены» line, «Живая сила» included; EW-suppressed drones excluded (jammed, not struck)",
    },
  },
  {
    // Matched on the BROADEST reading, which is the only one all three support.
    // «Рубикон» files personnel under «Поражены» (engaged) and «Альфа» says
    // «знешкодили» (neutralised) — neither is killed-only, and neither
    // publishes a killed/wounded split. SBS does, so pairing its killed figure
    // against them understated it roughly 2x (2026-07: 5,483 against a real
    // 11,609). Its casualties total is the like-for-like; the split it alone
    // publishes is nested below.
    group: "personnel", key: "personnel", label: "Personnel engaged / casualties",
    map: {
      sbs: ["total_personnel_casualties"],
      "sbu-alfa": ["enemy_kia"],
      rubikon: ["personnel"],
    },
    scope: {
      "sbu-alfa": "«знешкодили» / «відмінусували» — neutralised; always qualified («понад» = over, «майже» = almost)",
      rubikon: "«Живая сила» under «Поражены» — engaged",
    },
    children: [
      {
        key: "personnel_killed", label: "killed",
        map: { sbs: ["personnel_killed"] },
      },
      {
        key: "personnel_wounded", label: "wounded",
        map: { sbs: ["personnel_wounded"] },
      },
    ],
  },
  {
    group: "struck", key: "drones", label: "Unmanned Systems (UAVs + UGVs)",
    map: {
      // `ugv` (id 26, "Ворожі НРК") is summed in so both sides count the
      // same "БпЛА + наземних роботизованих комплексів" bucket SBU's recap uses.
      sbs: ["copter_uav", "fixed_wing_uav", "shahed", "gerbera", "ugv"],
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
    // Rotary / fixed-wing / ground is as deep as both sources can go together.
    // SBS splits fixed-wing three ways (fixed-wing, Shahed, Gerbera) and
    // «Рубикон» has specific rotary («Баба-Яга») and technically has fixed-wing,
    // but that hasn't been populated since March 2026, so «БпЛА» must include small
    // rotary drones as well as ISR and long range one-way fixed wing drones.
    //
    // «Альфа» publishes «БпЛА та НРК» as a single line and can't be split at all.
    //
    // The three children sum back to the parent on both sides.
    children: [
      {
        key: "uav_generic", label: "UAVs generic",
        map: { rubikon: ["uav"] },
        scope: {
          rubikon: "«БпЛА» (includes small copter drones, and fixed-wing since April 2026)",
        },
      },
      {
        key: "copters", label: "Copters",
        map: { sbs: ["copter_uav"], rubikon: ["baba_yaga"] },
        scope: {
          sbs: "Ворожі коптери",
          rubikon: "«Баба-Яга» (heavy copter drones)",
        },
      },
      {
        key: "fixed_wing", label: "Fixed-wing",
        map: { sbs: ["fixed_wing_uav", "shahed", "gerbera"], rubikon: ["fixed_wing_uav"] },
        scope: {
          // Shahed and Gerbera are fixed-wing airframes, and «Рубикон» has no
          // separate long-range one-way line — so folding them in makes the
          // two buckets more alike, not less.
          sbs: "Fixed-wing + Shahed + Gerbera",
          rubikon: "самолётного типа (not tracked since March 2026)",
        },
      },
      {
        key: "ugv", label: "UGVs",
        map: { sbs: ["ugv"], rubikon: ["ugv"] },
        scope: { sbs: "Ворожі НРК", rubikon: "НРК" },
      },
    ],
  },
  {
    group: "struck", key: "vehicles", label: "Vehicles (autos)",
    map: { sbs: ["vehicles", "buggies", "motorcycles"], "sbu-alfa": ["vehicles_auto_total"], rubikon: ["vehicles", "motorcycles"] },
    scope: {
      sbs: "Vehicles + motorcycles + military buggies",
      "sbu-alfa": "одиниць автомобільної техніки; may bundle motorcycles",
    },
    children: [{key: 'vehicles', 'label': 'Vehicles', map: {sbs: ['vehicles'], rubikon: ["vehicles", "engineering_vehicles"] }, scope: {
      sbs: 'Logistics, Engr. & special vehicles, refuelers etc.',
      rubikon: 'Vehicles, including engineering vehicles'
    } }, {
      key: "motorcycles", label: "Motorcycles",
      map: { sbs: ["motorcycles"], rubikon: ["motorcycles"] },
    }]
  },
  {
    group: "struck", key: "artillery", label: "Artillery",
    map: { sbs: ["cannons_howitzers", "spg"], "sbu-alfa": ["artillery"], rubikon: ["towed_artillery", "spg"] },
    scope: {
      sbs: "Cannons/Howitzers + Self-Propelled Artillery",
      "sbu-alfa": "артилерійських систем і САУ",
      rubikon: "Орудия/гаубицы + САУ — mortars counted separately",
    },
    children: [{
      key: 'spg', label: 'SPG', map: {sbs: ['spg'], "rubikon": ['spg']}}, {
      key: 'howitzer', label: 'Howitzers', map: {sbs: ['cannons_howitzers'], "rubikon": ['towed_artillery']}
    }]
  },
  {
    group: "struck", key: "armored", label: "Armored (total)",
    map: {
      sbs: ["tanks", "apcs_ifvs"], "sbu-alfa": ["armored_total"],
      rubikon: ["tanks", "afv_ifv", "apc"],
    },
    scope: {
      sbs: "Tanks + APCs / IFVs / ACVs",
      "sbu-alfa": "одиниць броньованої техніки (танки + ББМ)",
      rubikon: "Танки + ББМ/БМП + БТР",
    },
    children: [
      {
        key: "tanks", label: "Tanks",
        map: { sbs: ["tanks"], "sbu-alfa": ["tanks"], rubikon: ["tanks"] },
      },
      {
        key: "ifvs", label: "IFVs / APCs",
        map: { sbs: ["apcs_ifvs"], "sbu-alfa": ["ifvs"], rubikon: ["afv_ifv", "apc"] },
        scope: {
          sbs: "APCs / IFVs / ACVs",
          "sbu-alfa": "бойових броньованих машин",
          rubikon: "ББМ, БМП + Бронетранспортеры (two source lines)",
        },
      },
    ],
  },
  {
    group: "struck", key: "air_defense", label: "Air defense",
    map: { sbs: ["sam", "aa_guns"], "sbu-alfa": ["air_defense"], rubikon: ["sam", "aa_guns"] },
    scope: {
      sbs: "SAM + AA guns",
      "sbu-alfa": "засобів ППО / протиповітряної оборони",
      rubikon: "ЗРК + зенитные орудия",
    },
  },
  {
    group: "struck", key: "mlrs", label: "MLRS",
    map: { sbs: ["mlrs"], "sbu-alfa": ["mlrs"], rubikon: ["mlrs"] },
    scope: {
      sbs: "MLRS (bundled SAM / AA guns until 2026-03)",
      "sbu-alfa": "РСЗВ",
      rubikon: "РСЗО",
    },
  },
  {
    // Rubikon publishes «РЛС, РЭР, РЭБ» as ONE line and SBU bundles РЕБ into
    // its radar counter from June, so the row is radar + SIGINT + EW whether we
    // like it or not. SBS is the only source that splits EW onto its own
    // counters — mapping it to id 9 alone made it read 18 against Rubikon's 210
    // in 2026-06, a ~12x gap that was our mapping, not the war. Its EW counters
    // are summed in to match, and nested below so the split stays visible.
    //
    // id 8 (РЛС та ЗС, trench) is included even though it also carries зв'язок:
    // the Comms row is built from Антени / мережеве обладнання / камери, none
    // of which is id 8, so the two rows don't overlap on any counter.
    group: "struck", key: "radar", label: "Radar / SIGINT / EW",
    map: {
      sbs: ["radar_vehicles", "radar_trench", "ew_trench", "ew_vehicle", "ew_equipment"],
      "sbu-alfa": ["radar"],
      rubikon: ["radar_ew"],
    },
    scope: {
      sbs: "РЛС complexes + trench РЛС/ЗС + all three РЕБ counters",
      "sbu-alfa": "bare РЛС until May — narrower than this row; bundles РЕБ from Jun",
      rubikon: "«РЛС, РЭР, РЭБ» — one line, radar + SIGINT + EW together",
    },
    children: [
      {
        key: "radars", label: "Radars", map: {sbs: ["radar_vehicles", "radar_trench"], "sbu-alfa": ['radar']},
        scope: {sbs: 'Vehicles and trench'}
      },
      {
        key: "ew", label: "EW",
        map: { sbs: ["ew_trench", "ew_vehicle", "ew_equipment"] },
        scope: { sbs: "РЕБ (окопні, авто, техніка)" },
      }
    ],
  },
  {
    // Not in the old hardcoded table, which only ever had two columns and no
    // row for a counter SBU doesn't publish. Rubikon does publish it and SBS
    // has a matching target id, so it earns a shared row — otherwise the same
    // category would appear twice, once in each unit's "only in" section.
    group: "struck", key: "mortars", label: "Mortars",
    map: { sbs: ["mortars"], rubikon: ["mortars"] },
    scope: { "sbu-alfa": "not broken out — «Альфа» reports артилерійських систем і САУ only" },
  },
  {
    // SBS renumbered its launch-point counter in 2026-03; summing the
    // current one and the retired one keeps a continuous series across it.
    group: "struck", key: "uav_launch_points", label: "Drone launch / control points",
    map: {
      sbs: ["drone_launch_points", "drone_launch_points_legacy"],
      "sbu-alfa": ["drone_crews"],
      rubikon: ["uav_control_points"],
    },
    scope: {
      sbs: "Drone Launch Points, plus the counter it replaced in 2026-03",
      // Not the same object as the other two: «Альфа» counts розрахунків —
      // the crews — where SBS and Rubikon count the sites they operate from.
      // Kept on this row as the nearest equivalent, flagged so the difference
      // is on screen rather than only here.
      "sbu-alfa": "розрахунків БпЛА — crews (teams), not the sites they fly from",
      rubikon: "«Пункты управления БПЛА»",
    },
  },
  {
    // SBU's line is "засобів зв'язку та спостереження" — comms AND surveillance
    // — so SBS's cameras belong here rather than on their own. This is one of
    // the few rows where the three sources land within the same order of
    // magnitude, SBS being a whole branch.
    group: "struck", key: "comms", label: "Communication systems",
    map: {
      sbs: ["antennas", "network_equipment", "cameras"],
      "sbu-alfa": ["comms"],
      rubikon: ["comms"],
    },
    scope: {
      sbs: "Антени + мережеве обладнання + камери",
      "sbu-alfa": "засобів зв'язку та спостереження",
    },
  },
  {
    // Depots of ANY kind — the union, because no two sources scope the counter
    // the same way and none of them can be split to match another:
    //   SBS      generic Склади + ammunition + fuel + supplies (four counters)
    //   «Альфа»  ammunition and supplies, one counter, fuel never mentioned
    //   «Рубикон» ammunition and fuel, one counter, supplies never mentioned
    // So «Альфа» and «Рубикон» each omit a category the other includes, and
    // the row can only be read as "depots, however each unit counts them".
    // Labelled "Depots" rather than the old "Ammo / fuel depots", which was
    // «Рубикон»'s scope applied to all three columns.
    group: "struck", key: "depots", label: "Depots",
    // The three "ОТ Склад" counters start 2026-07 and run alongside Склади
    // rather than replacing it. They are DISJOINT from it, not a breakdown of
    // it: on 2026-07-08 Склади is 0 while ОТ Склад БК is 1, and on eight other
    // days a sub-depot exceeds Склади in the same snapshot — a subset can't do
    // that. So they are summed in (leaving them out would understate SBS) and
    // also listed as children, purely so the split stays visible.
    map: {
      sbs: ["depots", "depot_ammo", "depot_fuel", "depot_supplies"],
      "sbu-alfa": ["depots"],
      rubikon: ["depots"],
    },
    scope: {
      sbs: "Склади + ОТ Склад БК / ПММ / майно — ammunition, fuel and supplies (the ОТ counters from 2026-07)",
      "sbu-alfa": "«склади з боєприпасами та військовим майном» — ammunition and supplies",
      rubikon: "«Склады БК / ГСМ» — ammunition and fuel",
    },
    children: [
      {
        key: "depot_ammo", label: "Depot: Ammunition",
        map: { sbs: ["depot_ammo"] },
        scope: { sbs: "ОТ Склад БК — from 2026-07" },
      },
      {
        key: "depot_fuel", label: "Depot: Fuel",
        map: { sbs: ["depot_fuel"] },
        scope: { sbs: "ОТ Склад ПММ — from 2026-07" },
      },
      {
        key: "depot_supplies", label: "Depot: Supplies",
        map: { sbs: ["depot_supplies"] },
        scope: { sbs: "ОТ Склад майна — from 2026-07" },
      },
    ],
  },
  {
    // SBS contributes dugouts only. Shelters (id 21) stay out even though the
    // old page lumped the two together as "fortifications": they run ~2x
    // dugouts and read as temporary cover rather than built works, which is
    // what pushed the combined SBS figure to ~10x «Альфа»'s. They remain in
    // the SBS "only in" section.
    group: "struck", key: "fortifications", label: "Fortifications / engineering / strongpoints",
    map: {
      sbs: ["dugouts"],
      "sbu-alfa": ["fortifications"],
      rubikon: ["fortifications", "engineering_structures", "deployment_points"],
    },
    scope: {
      sbs: "assumes dugouts are fortified, and shelters are temporary hideouts, basements etc. (see below)",
      "sbu-alfa": "укріплень та інженерних споруд",
      rubikon: "Фортификационные + инженерные сооружения, strongpoints (three source lines)",
    },
  },
  {
    // Rubikon has published no aircraft or naval line — a UAV unit operating
    // over the line of contact. Absent, not zero.
    group: "struck", key: "aircraft", label: "Aircraft",
    map: { sbs: ["helicopters", "planes"], "sbu-alfa": ["aircraft"] },
    scope: { sbs: "Helicopters + Fixed-wing planes", "sbu-alfa": "літак / одиниць авіаційної техніки" },
  },
  {
    group: "struck", key: "watercraft", label: "Fleet / watercraft",
    map: { sbs: ["fleet"], "sbu-alfa": ["watercraft"] },
    scope: { sbs: "Флот — naval targets", "sbu-alfa": "одиниць водного транспорту" },
  },
];

// ─── Native vocabularies ─────────────────────────────────────────────────────
// Every key an entity can produce, in display order, with its label. Anything
// here that no canonical row consumes becomes an "only in <entity>" row.
export interface NativeKey {
  key: AnyNativeKey;
  label: string;
}

// Aggregates and parents are held out of the native lists: they restate other
// rows in the same column, so as standalone "unmapped" rows they'd read as
// extra targets. `targets_enumerated` / `targets_engaged_all` are this app's
// own roll-ups, consumed by the `targets_all` row above (which makes these two
// entries belt-and-braces — a mapped key never reaches the "only in" section
// anyway); `targets_*` are SBU's aggregate of the very bullets it lists; the
// three vehicle children are already inside the mapped parent.
const SBU_NOT_NATIVE = new Set<SbuAlfaCategoryKey>([
  "targets_enumerated", "targets_total", "targets_destroyed", "targets_damaged",
  "vehicles_light", "vehicles_moto", "vehicles_trucks",
]);
const RUBIKON_NOT_NATIVE = new Set<RubikonCategoryKey>(["targets_engaged_all"]);

// Empty today: SBS's one restating counter (id 15, "ОС РОВ" — the personnel
// figures repeated as a target class) is commented out of TARGET_IDS entirely,
// so it never reaches here. Kept as the hook for the next counter that restates
// another, which would otherwise show up twice in the "only in" section.
const SBS_NOT_NATIVE = new Set<SbsNativeKey>([]);

// SBS: the `hit_*` columns only. `destroyed_*` is a subset of `hit_*` (the
// source reports both), and `total_targets_hit` sums the lot — either would
// double-count against the hit-based canonical rows. (`total_targets_hit` is
// still a native KEY, so the `targets_all` roll-up can read it; it just isn't
// a native COUNTER anything else may pick up.)
const SBS_NATIVES: NativeKey[] = [
  { key: "personnel_killed", label: "Personnel Killed" },
  { key: "personnel_wounded", label: "Personnel Wounded" },
  { key: "total_personnel_casualties", label: "Personnel Casualties" },
  { key: "flights_strike", label: "Strike Sorties" },
  { key: "flights_recon", label: "Recon Sorties" },
  ...Object.entries(SBS_TARGETS)
    .filter(([slug]) => !SBS_NOT_NATIVE.has(slug as SbsNativeKey))
    .map(([slug, id]) => ({ key: slug as SbsNativeKey, label: TARGET_LABELS[id] })),
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
  for (const r of [row, ...(row.children ?? [])]) {
    for (const [entity, keys] of Object.entries(r.map)) {
      for (const k of keys ?? []) MAPPED_NATIVES[entity as CompareEntityId].add(k);
    }
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

// Caveats for native counters that appear outside a canonical row — whether in
// an "only in" section or, for a single-entity view, appended to the table
// proper. A counter that does not mean what the group header says needs to say
// so wherever it is rendered.
export const NATIVE_NOTES: Partial<Record<CompareEntityId, Record<string, string>>> = {
  rubikon: {
    // «подавлено системами РЭБ» — jammed, not hit, and excluded from every
    // «Поражены» line. Under a "Hit / struck" header it would read as the
    // unit's largest kill count.
    uav_ew_suppressed: "SUPPRESSED, not struck — jammed by EW and counted apart from «Поражены»",
  },
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
