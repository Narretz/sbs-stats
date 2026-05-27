// ─── Target classification IDs ────────────────────────────────────────────────
export const TARGET_IDS = [1, 3, 32, 9, 2, 5, 7, 18, 21, 22, 24, 25, 30] as const;
export type TargetId = (typeof TARGET_IDS)[number];

export const TARGET_LABELS: Record<TargetId, string> = {
  1: "Tanks",
  2: "APCs / IFVs / ACVs",
  3: "Cannons, Howitzers",
  5: "MLRS (+ SAM / AA Guns until 2026-03)",
  7: "Vehicles",
  9: 'Radars (Vehicles)',
  18: "Motorcycles & Buggies",
  21: "Shelters",
  22: "Dugouts",
  24: 'Copter UAVs',
  25: "Fixed-wing UAVs",
  30: 'Shaheds',
  32: "SAM",
};

// ─── Base numeric stat keys ───────────────────────────────────────────────────
export type BaseStatKey =
  | "personnel_killed"
  | "personnel_wounded"
  | "total_targets_hit"
  | "total_targets_destroyed"
  | "total_personnel_casualties"
  | "flights_strike"
  | "flights_recon";

export type HitKey = `hit_${TargetId}`;
export type DestroyedKey = `destroyed_${TargetId}`;
export type TargetStatKey = HitKey | DestroyedKey;
export type StatKey = BaseStatKey | TargetStatKey;

// ─── DB row shapes ────────────────────────────────────────────────────────────
export type DailyRow = {
  date: string;   // "YYYY-MM-DD"
  hour: number;
  is_today: boolean;
} & Record<StatKey, number | null>;

export type ProjectedKey = `${StatKey}_projected`;

export type MonthlyRow = {
  date: string;   // "YYYY-MM"
  is_current_month: boolean;
  projection_day: number | null;
  projection_days_in_month: number | null;
} & Record<StatKey, number> & Partial<Record<ProjectedKey, number>>;

// ─── Daily chart (one value per day) ─────────────────────────────────────────
export interface DailyDataPoint {
  date: string;
  value: number | null;
  is_today: boolean;
}

// End-of-day projection for the current (still incomplete) day, derived from the
// historical intraday completion curve. Only meaningful for "today".
export interface EodEstimate {
  projected: number; // estimated settled end-of-day value
  fraction: number;  // 0..1 — share of the day's total already reported by `asOf`
  asOf: string;      // intraday checkpoint label, e.g. "14:00"
}

// ─── Hourly chart (one line per day, x-axis = hours) ─────────────────────────
export interface HourPoint {
  hour: number;
  value: number | null;
}

export interface DailyDaySeries {
  date: string;
  is_today: boolean;
  points: HourPoint[];
}

// ─── Monthly chart ────────────────────────────────────────────────────────────
export interface MonthlyDataPoint {
  date: string;
  value: number | null;
  gap?: number;
  projected?: number;
  projection_day?: number;
  projection_days_in_month?: number;
  note?: string; // optional caveat (e.g. possible double-count); shown in tooltip + flags the bar
}

// ─── Metric descriptor ────────────────────────────────────────────────────────
export type PairMode = "subset" | "sum";

export interface Metric {
  key: StatKey;
  label: string;
  wfull?: boolean;
  pairedKey?: StatKey;
  pairedLabel?: string;
  primaryLabel?: string;
  pairMode?: PairMode;
}

// ─── App state ────────────────────────────────────────────────────────────────
export type Page = "daily" | "hourly" | "monthly";
export type Site = "sbs" | "ru-attacks-gsua" | "ru-losses-gsua" | "ru-airdef-mod" | "ru-air-attacks-gsua" | "mediazona";
export const SITE_LABELS: Record<Site, string> = {
  sbs: "UA SBS STATISTICS - SBS",
  "ru-attacks-gsua": "RU ATTACKS - GSUA",
  "ru-losses-gsua": "RU LOSSES - GSUA",
  "ru-air-attacks-gsua": "RU MISSILE & UAV ATTACKS - GSUA",
  "ru-airdef-mod": "UA UAV ATTACKS - RU MoD",
  mediazona: "RU DEATHS - MEDIAZONA",
};
export const SITES: Site[] = Object.keys(SITE_LABELS) as Site[];
export type LoadState = "idle" | "loading" | "ready" | "error";

// ─── Global stats (max + median across all data) ──────────────────────────────
export type GlobalStats = Record<StatKey, { max: number; median: number }>;

// ─── GSUA (General Staff UA) ──────────────────────────────────────────────────
// Schema mirrors scripts/gsua/schema.sql. `posts` carries the aggregate
// metrics (one row per snapshot); `directions` carries per-direction attacks
// keyed by (source, source_id).
export const GSUA_METRIC_KEYS = [
  "combat_engagements",
  "kabs_dropped",
  "air_strikes",
  "missile_strikes",
  "missiles_used",
  "kamikaze_drones",
  "shellings",
  "mlrs_shellings",
] as const;
export type GsuaMetricKey = (typeof GSUA_METRIC_KEYS)[number];

export const GSUA_METRIC_LABELS: Record<GsuaMetricKey, string> = {
  combat_engagements: "Combat Engagements",
  kabs_dropped: "KABs Dropped",
  air_strikes: "Air Strikes",
  missile_strikes: "Missile Strikes",
  missiles_used: "Missiles Used",
  kamikaze_drones: "Kamikaze Drones",
  shellings: "Shellings",
  mlrs_shellings: "MLRS Shellings",
};

export type GsuaDailyRow = {
  date: string;          // YYYY-MM-DD
  snapshot_at: string;   // ISO local Kyiv
  is_today: boolean;
  source: string;
} & Record<GsuaMetricKey, number | null>;

export interface GsuaDirectionRow {
  date: string;
  snapshot_at: string;
  direction: string;
  attacks: number | null;
  ongoing: number | null;
  is_today: boolean;
}

export type GsuaGlobalStats = Record<GsuaMetricKey, { max: number; median: number }>;

export type GsuaMonthlyRow = {
  date: string; // "YYYY-MM"
  is_current_month: boolean;
  projection_day: number | null;
  projection_days_in_month: number | null;
} & Record<GsuaMetricKey, number> & Partial<Record<`${GsuaMetricKey}_projected`, number>>;

// ─── RU Losses (PetroIvaniuk dataset → ru-losses-gsua-petroivaniuk.db) ─────────
// Daily Russian losses (personnel + equipment) as reported by the Ukrainian
// General Staff, via PetroIvaniuk's machine-readable mirror. The ingest diffs
// the source's cumulative totals into per-day increments, so each `daily_losses`
// row is one day. Keys/order mirror scripts/ru_losses/ingest.py.
export const RU_LOSSES_METRIC_KEYS = [
  "personnel",
  "tanks",
  "apv",
  "artillery",
  "mlrs",
  "aaws",
  "aircraft",
  "helicopters",
  "uav",
  "vehicles",
  "boats",
  "se",
  "missiles",
  "ugs",
  "captive",
] as const;
export type RuLossesMetricKey = (typeof RU_LOSSES_METRIC_KEYS)[number];

export const RU_LOSSES_METRIC_LABELS: Record<RuLossesMetricKey, string> = {
  personnel: "Personnel",
  tanks: "Tanks",
  apv: "Armoured Vehicles",
  artillery: "Artillery Systems",
  mlrs: "MLRS",
  aaws: "Anti-Aircraft Systems",
  aircraft: "Aircraft",
  helicopters: "Helicopters",
  uav: "UAV",
  vehicles: "Vehicles & Fuel Tanks",
  boats: "Boats",
  se: "Special Equipment",
  missiles: "Cruise Missiles",
  ugs: "Unmanned Ground Systems",
  captive: "POW (Captured)",
};

export type RuLossesDailyRow = {
  date: string;        // YYYY-MM-DD
  is_today: boolean;
} & Record<RuLossesMetricKey, number | null>;

export type RuLossesGlobalStats = Record<RuLossesMetricKey, { max: number; median: number }>;

export type RuLossesMonthlyRow = {
  date: string; // "YYYY-MM"
  is_current_month: boolean;
  projection_day: number | null;
  projection_days_in_month: number | null;
} & Record<RuLossesMetricKey, number> & Partial<Record<`${RuLossesMetricKey}_projected`, number>>;

// ─── RU Air Attacks (piterfm Kaggle → ru-air-attacks-gsua.db) ─────────────────
// Russian missile/UAV strikes on Ukraine, digitized by piterfm from the UA Air
// Force + General Staff reports. Each source row is launched/destroyed per weapon
// model; scripts/missile_attacks/ingest.py derives a `category`
// (drone/cruise/ballistic/other) and the frontend reads the `daily_by_category`
// view. "all" = sum across every category (including the small "other" bucket).
// "intercepted" is the source's `destroyed` count.
export const ATTACK_CATEGORY_KEYS = ["all", "drone", "cruise", "ballistic"] as const;
export type AttackCategoryKey = (typeof ATTACK_CATEGORY_KEYS)[number];
// The three real DB categories charted as launched-vs-intercepted (no "all", no
// "other"); "all" is computed, "other" is folded into "all" only.
export const ATTACK_DB_CATEGORIES = ["drone", "cruise", "ballistic"] as const;
export type AttackDbCategory = (typeof ATTACK_DB_CATEGORIES)[number];

export const ATTACK_CATEGORY_LABELS: Record<AttackCategoryKey, string> = {
  all: "All — Drones + Missiles",
  drone: "Drones",
  cruise: "Cruise Missiles",
  ballistic: "Ballistic Missiles",
};

export type AttackMetricCol = `${AttackCategoryKey}_launched` | `${AttackCategoryKey}_intercepted`;

export type RuAirAttacksDailyRow = {
  date: string;        // YYYY-MM-DD (date of attack window start)
  is_today: boolean;
} & Record<AttackMetricCol, number | null>;

export type RuAirAttacksGlobalStats = Record<
  AttackCategoryKey,
  { launched: { max: number; median: number }; intercepted: { max: number; median: number } }
>;

// Monthly = launched sums per category (interception is shown on the daily view).
export type RuAirAttacksMonthlyRow = {
  date: string; // "YYYY-MM"
  is_current_month: boolean;
  projection_day: number | null;
  projection_days_in_month: number | null;
} & Record<AttackCategoryKey, number> & Partial<Record<`${AttackCategoryKey}_projected`, number>>;

// ─── RU Air Defense (MoD Telegram → ru-mod-ad.db) ─────────────────────────────
// Russian MoD claims of Ukrainian UAVs intercepted/downed over Russia, parsed
// from @mod_russia (scripts/ru_mod/ingest.py). Each `ad_reports` row is one ПВО
// post; we aggregate per "drone-day" (MSK date of the report window's end), and
// split by reporting window: overnight vs daytime. Unverified claims; "downed"
// is a floor for "launched". Stats mirror the {max, median} shape used elsewhere.
export type RuAdStat = { max: number; median: number };

export type RuAdDailyRow = {
  date: string;        // YYYY-MM-DD (MSK drone-day)
  is_today: boolean;
  total: number | null;
  night: number | null;
  day: number | null;
  reports: number;
};

export type RuAdGlobalStats = { total: RuAdStat; night: RuAdStat; day: RuAdStat };

export type RuAdMonthlyRow = {
  date: string; // "YYYY-MM"
  is_current_month: boolean;
  projection_day: number | null;
  projection_days_in_month: number | null;
  total: number;
  night: number;
  day: number;
  // count of reports in the month flagged with an overlap caveat (possible
  // double-count) — see ad_reports.notes / scripts/ru_mod.
  overlap_reports: number;
} & Partial<Record<"total_projected" | "night_projected" | "day_projected", number>>;

// ─── Mediazona (confirmed named deaths + probate estimate → mediazona.db) ──────
// Two independent weekly series; see scripts/mediazona/README.md.
//  • weekly_roles    — confirmed, individually-NAMED deaths by branch/role,
//    bucketed by date of death (so recent weeks are right-censored: not yet
//    identified). The 21 source role columns are mutually exclusive and sum to
//    `total`; we group them into the buckets below for a 100%-normalised
//    composition chart. Grouping lives here so it can change without a re-ingest.
//  • weekly_estimate — documented (named) vs the probate-registry modelled total.
//    Two independent measures, NOT nested (estimate < documented in mid-2022).
export const MEDIAZONA_ROLE_GROUP_KEYS = [
  "infantry", "regular", "volunteers", "mobilized", "convicts", "pmc", "undetermined",
] as const;
export type MediazonaRoleGroupKey = (typeof MEDIAZONA_ROLE_GROUP_KEYS)[number];

// label + stack colour + the raw weekly_roles columns summed into the group.
// Order of MEDIAZONA_ROLE_GROUP_KEYS is the stack/legend order (bottom → top).
export const MEDIAZONA_ROLE_GROUPS: Record<
  MediazonaRoleGroupKey,
  { label: string; color: string; cols: string[] }
> = {
  infantry:     { label: "Riflemen / infantry",     color: "#4878d0", cols: ["rifle"] },
  regular:      { label: "Other regular forces",    color: "#55a868", cols: ["air", "marine", "special", "pilot", "tank", "art", "eng", "signal", "airdef", "chem", "seaman", "nguard", "groundavia", "fsb"] },
  volunteers:   { label: "Volunteers",              color: "#c8a14b", cols: ["vol"] },
  mobilized:    { label: "Mobilized",               color: "#dd8452", cols: ["mob"] },
  convicts:     { label: "Convicts",                color: "#c44e52", cols: ["inmates"] },
  pmc:          { label: "PMC (Wagner et al.)",     color: "#8172b3", cols: ["pmc"] },
  undetermined: { label: "Undetermined / other",    color: "#8c8c8c", cols: ["nd", "other"] },
};

// All raw role columns the ingest stores (mirrors ROLE_COLS in scripts/mediazona),
// minus `total`. Used to read + sum into groups.
export const MEDIAZONA_ROLE_COLS = [
  "nguard", "rifle", "air", "pilot", "seaman", "marine", "tank", "art", "eng",
  "other", "nd", "special", "vol", "mob", "signal", "airdef", "chem", "pmc",
  "fsb", "groundavia", "inmates",
] as const;

export type MediazonaRolesRow = { week: string; total: number } & Record<MediazonaRoleGroupKey, number>;

export type MediazonaEstimateRow = {
  week: string;            // YYYY-MM-DD (week start)
  documented: number | null; // CSV `real`  — named/confirmed deaths
  estimate: number | null;   // CSV `rnd`   — probate-registry modelled total
};
