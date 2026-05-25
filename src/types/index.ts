// ─── Target classification IDs ────────────────────────────────────────────────
export const TARGET_IDS = [1, 32, 3, 2, 5, 7, 18, 21, 22, 24, 25, 30] as const;
export type TargetId = (typeof TARGET_IDS)[number];

export const TARGET_LABELS: Record<TargetId, string> = {
  1: "Tanks",
  32: "SAM",
  3: "Cannons, Howitzers",
  2: "APCs / IFVs / ACVs",
  5: "MLRS (+ SAM / AA Guns until 2026-03)",
  7: "Vehicles",
  18: "Motorcycles & Buggies",
  21: "Shelters",
  22: "Dugouts",
  24: 'Copter UAVs',
  25: "Fixed-wing UAVs",
  30: 'Shaheds'
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
export type Site = "sbs" | "gsua";
export const SITES: Site[] = ["sbs", "gsua"];
export const SITE_LABELS: Record<Site, string> = {
  sbs: "SBS STATISTICS",
  gsua: "RU ATTACKS - GSUA",
};
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
