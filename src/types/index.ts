// ─── Target classification IDs ────────────────────────────────────────────────
// Around 2026-03-20 SBS migrated drone-launch tracking from targetClassId 23
// ("Точки вильоту дронів") to targetClassId 37 ("ПУ БпЛА") on the live daily
// endpoint, but their previous-month rollup endpoint still folds the total
// back into 23 — so id 23 reads ~0 on daily charts but big monthly numbers on
// the monthly chart. Both ids are charted so the discrepancy is visible.
export const TARGET_IDS = [1, 2, 32, 9, 7, 18, 19, 3, 4, 5, 6, 21, 22, 24, 25, 30, 31, 37, 23, 33, 35, 26, 29, 10, 12, 41, 42, 43] as const;
export type TargetId = (typeof TARGET_IDS)[number];

export const TARGET_LABELS: Record<TargetId, string> = {
  1: "Tanks",
  2: "APCs / IFVs / ACVs",
  3: "Cannons, Howitzers",
  4: "Self Propelled Artillery",
  5: "MLRS (+ SAM / AA Guns until 2026-03)",
  6: 'Mortars',
  7: "Vehicles",
  9: 'Radars (Vehicles)',
  18: "Motorcycles",
  19: "Military buggies",
  21: "Shelters",
  22: "Dugouts",
  23: "Drone Launch Points (until 2026-03)",
  24: 'Copter UAVs',
  25: "Fixed-wing UAVs",
  26: "UGVs",
  29: 'Helicopters',
  30: 'Shaheds',
  31: "Gerberas",
  32: "SAM",
  33: 'AA guns',
  35: 'Anti-drone: UAV systems',
  37: "Drone Launch Points",
  10: "EW, trench",
  12: "EW, vehicle",
  41: "Fixed-wing planes",
  42: "Fleet",
  43: "Energy Nodes"
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
  // Optional caveat: when set, the chart highlights this point (warning-styled
  // dot) and shows the text under the tooltip's standard rows. Used today by
  // the RU MoD daily charts to surface the same "possible double-count" flag
  // that the monthly chart already shows on overlap-flagged months.
  note?: string;
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
  subsetLabel?: string;
}

// ─── App state ────────────────────────────────────────────────────────────────
export type Page = "daily" | "hourly" | "monthly" | "weekly";
export type Site = "sbs" | "ru-attacks-gsua" | "ru-losses-gsua" | "ru-airdef-mod" | "ru-air-attacks-gsua" | "sbu-alfa" | "rubikon" | "mediazona" | "ru-missiles-hur" | "ua-losses";
export const SITE_LABELS: Record<Site, string> = {
  sbs: "UA SBS STATISTICS - SBS",
  "ru-attacks-gsua": "COMBAT STATS - GSUA",
  "ru-losses-gsua": "RU LOSSES - GSUA",
  "ru-air-attacks-gsua": "RU MISSILE & UAV ATTACKS - GSUA",
  "sbu-alfa": "UA SBU ALFA MONTHLY RECAP - SBU",
  rubikon: "RU RUBIKON MONTHLY RECAP - RUBIKON",
  "ru-airdef-mod": "UA UAV ATTACKS - RU MoD",
  mediazona: "RU DEATHS - MEDIAZONA",
  "ru-missiles-hur": "RU MISSILE STOCKS - HUR",
  "ua-losses": "UA PERSONNEL LOSSES - UALOSSES.ORG",
};
export const SITES: Site[] = Object.keys(SITE_LABELS) as Site[];
export type LoadState = "idle" | "loading" | "ready" | "error";

// ─── Global stats (max + median + total across all data) ─────────────────────
export type Stat = { max: number; median: number; total: number };
export type GlobalStats = Record<StatKey, Stat>;

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
  "targets_destroyed",
] as const;
export type GsuaMetricKey = (typeof GSUA_METRIC_KEYS)[number];

export const GSUA_METRIC_LABELS: Record<GsuaMetricKey, string> = {
  combat_engagements: "Combat Engagements",
  kabs_dropped: "RU KABs Dropped",
  air_strikes: "RU Air Strikes",
  missile_strikes: "RU Missile Strikes",
  missiles_used: "RU Missiles Used",
  kamikaze_drones: "RU Kamikaze Drone Attacks",
  shellings: "RU Artillery Shellings",
  mlrs_shellings: "RU MLRS Shellings",
  // UA forces' combined (aviation + missile troops + artillery) targets hit,
  // from the GS "Сили оборони уразили …" line. Targets destroyed, not sorties.
  targets_destroyed: "UA Targets Hit",
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

// Directions the General Staff folded into an existing line, mapped to the
// axis whose series the merged reports continue.
//
// From 2025-06-16 the GS reports "На Північно-Слобожанському і Курському
// напрямках" as one line with one figure. Because the figure is shared, the DB
// stores it on both rows with `attacks_group_size = 2`, and the fair-share
// divisor then charts half an assault each — 55% of those rows don't divide
// evenly, and a shared count of 1 (the single commonest value) becomes 0.5.
//
// The pair is the Kursk series continued rather than two series merging:
// Kursk was reported alone from 2024-09-23 to 2025-06-15, and
// N-Slobozhanshchyna has no independent history at all (1,295 paired reports,
// one lone appearance). So both rows fold back onto `Kursk` and the halves
// re-add to the integer the General Staff actually published.
//
// This is a judgement about what the sectors ARE, not something derivable from
// a report, which is why it lives here rather than in the ingest. Everything
// else maps to itself; the other always-paired lines (Volyn+Polissia,
// Chernihiv+Sumy) are "no offensive groupings" boilerplate that essentially
// never carries a count, so they never produce a fraction.
export const DIRECTION_AXIS: Record<string, string> = {
  "N-Slobozhanshchyna": "Kursk",
};

// Display name for an axis while it IS a joint line. The key stays `Kursk` so
// the series stays continuous across the merge, but the label is chosen per
// window from the data (see `mergedAxes`): a window entirely before the merge
// reads "Kursk", one entirely after reads the joint name, and one that spans
// the changeover says so with the month it happened. Nothing here hardcodes
// that date — it is read off the reports.
export const DIRECTION_AXIS_JOINT_LABEL: Record<string, string> = {
  Kursk: "Kursk / Pn. Slobozhanshchyna",
};

export function directionAxis(direction: string): string {
  return DIRECTION_AXIS[direction] ?? direction;
}

// Per-date breakdown of the day's `combat_engagements` count by direction.
// `attributed` is the sum of `byDirection`; `unattributed` = max(0, total -
// attributed). All fields come from the SAME canonical post per date so the
// delta is an honest per-report gap, not a cross-report subtraction.
export interface GsuaDirectionCoverageRow {
  date: string;
  total: number | null;                    // combat_engagements from canonical post
  attributed: number;                      // SUM(byDirection)
  unattributed: number;                    // total - attributed, clamped to 0
  byDirection: Record<string, number>;     // AXIS → attacks (>0 only), see DIRECTION_AXIS
  // Axes whose figure on THIS date came from a jointly-reported line — i.e. a
  // direction was folded into them by DIRECTION_AXIS. Lets a chart name the
  // axis for the window it is actually showing instead of assuming the
  // composition it has today.
  mergedAxes?: string[];
  // `snapshot_at` of the report this bucket was built from, daily only. When
  // its date equals the bucket's, the day's wrap-up report (posted the next
  // morning) isn't in yet, so the figures are an interim reading.
  snapshot_at?: string | null;
  is_today: boolean;
}

export type GsuaGlobalStats = Record<GsuaMetricKey, Stat>;

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

export type RuLossesGlobalStats = Record<RuLossesMetricKey, Stat>;

export type RuLossesMonthlyRow = {
  date: string; // "YYYY-MM"
  is_current_month: boolean;
  projection_day: number | null;
  projection_days_in_month: number | null;
} & Record<RuLossesMetricKey, number> & Partial<Record<`${RuLossesMetricKey}_projected`, number>>;

// ─── UA Losses (ualosses.org daily personnel losses → ua-losses.db) ───────────
// Confirmed, named Ukrainian military losses aggregated per day, broken out by
// status. The raw daily total (`number`) is stored in the DB but deliberately
// NOT charted — it lumps together fundamentally different outcomes (killed,
// missing, captured, released), which is misleading as a single "losses" line.
// Chart the status split instead. (`number` = dead + missing + prisoner +
// released, so the total is still recoverable by stacking these.)
export const UA_LOSSES_METRIC_KEYS = [
  "dead",
  "missing",
  "prisoner",
  "released",
] as const;
export type UaLossesMetricKey = (typeof UA_LOSSES_METRIC_KEYS)[number];

export const UA_LOSSES_METRIC_LABELS: Record<UaLossesMetricKey, string> = {
  dead: "Deaths",
  missing: "Missing",
  prisoner: "POW (Captured)",
  released: "POW (Released)",
};

export type UaLossesDailyRow = {
  date: string;        // YYYY-MM-DD
  is_today: boolean;
} & Record<UaLossesMetricKey, number | null>;

export type UaLossesGlobalStats = Record<UaLossesMetricKey, Stat>;

export type UaLossesMonthlyRow = {
  date: string; // "YYYY-MM"
  is_current_month: boolean;
  projection_day: number | null;
  projection_days_in_month: number | null;
} & Record<UaLossesMetricKey, number> & Partial<Record<`${UaLossesMetricKey}_projected`, number>>;

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

// Ukraine's Air Force stopped publishing exact ballistic-missile launched /
// intercepted figures on 2026-08-13, citing operational security. piterfm marks
// those rows `status_data='hidden'` and carries a placeholder 0, so anything
// that SUMs the raw column reads a withheld attack as "nothing was launched".
// The hook maps them to null; this is the caveat the charts show in their place.
export const UNDISCLOSED_NOTE =
  "Ukrainian Air Force stopped publishing ballistic missile counts on 11.08.2026.";
export const UNDISCLOSED_PARTIAL_NOTE =
  "Excludes attacks reported without figures (UA stopped publishing ballistic missile counts on 11.08.2026) — a lower bound.";

// Featured weapon models charted individually on the air-attacks pages.
// Listed in the same `model` string the DB stores; the page renders a chart per
// entry alongside the per-category charts. Extend as needed — purely additive,
// no other code references the slugs directly.
// Iskander-M is the only standalone model that's both currently active and
// reported as its own row in piterfm's data (Shahed-136/131 ≈ the "drone"
// category, and X-101/Kalibr increasingly land inside "X and Y" bundle rows
// from late 2025 onward — see makeModelPairDataset comment).
export const FEATURED_MODELS = ["Iskander-M"] as const;
export type FeaturedModel = (typeof FEATURED_MODELS)[number];

export type RuAirAttacksModelDailyRow = {
  date: string; // YYYY-MM-DD
  is_today: boolean;
  // null when this model's only rows for the date were withheld upstream
  // (see UNDISCLOSED_NOTE) — charted as a gap, not as 0.
  launched: number | null;
  intercepted: number | null;
};

// One model's contribution to a single (date, category) cell, used to render
// the per-model breakdown tooltip on the daily category charts.
export type ModelBreakdownEntry = {
  model: string;
  launched: number;
  intercepted: number;
  // True when every row behind this entry was flagged `status_data='hidden'`
  // upstream — the attack was reported but its counts were withheld, so
  // `launched`/`intercepted` are placeholders. Rendered as "not disclosed"
  // rather than as the 0 the CSV carries. See UNDISCLOSED_NOTE.
  undisclosed?: boolean;
};

export type RuAirAttacksModelMonthlyRow = {
  date: string; // YYYY-MM
  is_current_month: boolean;
  projection_day: number | null;
  projection_days_in_month: number | null;
  launched: number;
  intercepted: number;
  launched_projected?: number;
  intercepted_projected?: number;
};

export type RuAirAttacksDailyRow = {
  date: string;        // YYYY-MM-DD (date of attack window start)
  is_today: boolean;
  // Categories whose counts UA withheld on this date (see UNDISCLOSED_NOTE).
  // Their `${cat}_launched` / `${cat}_intercepted` cells are null when nothing
  // was disclosed at all, so the chart draws a gap instead of dropping to 0.
  // `all_*` stays a number — the sum of what *was* disclosed, i.e. a lower
  // bound — and this list is what tells the tooltip to say so.
  undisclosed?: AttackDbCategory[];
} & Record<AttackMetricCol, number | null>;

export type RuAirAttacksGlobalStats = Record<
  AttackCategoryKey,
  { launched: Stat; intercepted: Stat }
>;

// Monthly = launched + intercepted sums per category. Bare category key holds
// the launched sum (legacy); `${c}_intercepted` holds the destroyed sum.
export type RuAirAttacksMonthlyRow = {
  date: string; // "YYYY-MM"
  is_current_month: boolean;
  projection_day: number | null;
  projection_days_in_month: number | null;
  // Categories with at least one withheld day this month. Unlike the daily
  // row these stay numbers: a month with some days disclosed still has a real
  // partial sum, which this flags as a lower bound rather than blanking.
  undisclosed?: AttackDbCategory[];
} & Record<AttackCategoryKey, number>
  & Record<`${AttackCategoryKey}_intercepted`, number>
  & Partial<Record<`${AttackCategoryKey}_projected` | `${AttackCategoryKey}_intercepted_projected`, number>>;

// ─── RU Air Defense (MoD Telegram → ru-mod-ad.db) ─────────────────────────────
// Russian MoD claims of Ukrainian UAVs intercepted/downed over Russia, parsed
// from @mod_russia (scripts/ru_mod/ingest.py). Each `ad_reports` row is one ПВО
// post; we aggregate per "drone-day" (MSK date of the report window's end), and
// split by reporting window: overnight vs daytime. Unverified claims; "downed"
// is a floor for "launched". Stats mirror the {max, median} shape used elsewhere.
export type RuAdStat = Stat;

export type RuAdDailyRow = {
  date: string;        // YYYY-MM-DD (MSK drone-day)
  is_today: boolean;
  total: number | null;
  night: number | null;
  day: number | null;
  reports: number;
  // Counts of posts on this day flagged with an overlap caveat (possible
  // double-count), split by which series they roll up into so the daily
  // chart can mark night/day independently. `overlap_total` = total flagged
  // reports (== night + day).
  overlap_total: number;
  overlap_night: number;
  overlap_day: number;
  // Part of `total` that came from a report the MoD phrased as «воздушных целей»
  // (air targets — a superset of UAVs that can include missiles), so it isn't a
  // pure drone count. 0 on a normal day; see ad_reports.unit / scripts/ru_mod.
  air_target_drones: number;
  // Newline-joined "HH:MM→HH:MM: <caveat>" lines for each flagged report —
  // overlap notes and air-target wording alike. Null when nothing on this
  // day/series is flagged. The chart renders each line verbatim so the reader
  // knows exactly which window(s) carry the caveat.
  caveat_note_total: string | null;
  caveat_note_night: string | null;
  caveat_note_day: string | null;
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
  // count of reports in the month phrased as «воздушных целей» (air targets,
  // not a pure drone count) and the drones they contributed — see ad_reports.unit.
  air_target_reports: number;
  air_target_drones: number;
} & Partial<Record<"total_projected" | "night_projected" | "day_projected", number>>;

// ─── SBU Alfa (ssu.gov.ua monthly recap → sbu-alfa.db) ─────────────────────────
// SBU's "TOP-1 серед підрозділів Сил оборони" monthly recap (running since
// 2026-03). Numbers are unit self-reports — destroyed/damaged enemy assets — so
// frame them in the UI as claims, not verified counts. KIA is always phrased as
// "понад N" (at_least); other counters are bare numbers (exact). See
// scripts/sbu_alfa/parse.py for the bound model (mirrors HUR's reports.json).
export const SBU_ALFA_CATEGORY_KEYS = [
  "enemy_kia",
  // Synthesised by useDatabaseSbuAlfa, not stated by SBU: the sum of the
  // enumerated equipment categories below. A LOWER BOUND on `targets_total`,
  // not a replacement for it — SBU frames its bullets as "серед" ("among") the
  // objects hit, and where both exist the sum lands ~90% of the stated total
  // (2026-03: 6 681 vs 7 346; 2026-04: 9 451 vs 10 518). Excludes `enemy_kia`,
  // which SBU itself counts apart from the "N інших цілей" ("N OTHER targets")
  // figure.
  "targets_enumerated",
  "targets_total",
  "targets_destroyed",
  "targets_damaged",
  "drones",
  "drone_crews",
  "comms",
  "fortifications",
  "vehicles_auto_total",
  "artillery",
  "armored_total",
  "tanks",
  "ifvs",
  "air_defense",
  "radar",
  "mlrs",
  "aircraft",
  "watercraft",
  "depots",
  "vehicles_light",
  "vehicles_moto",
  "vehicles_trucks",
] as const;
export type SbuAlfaCategoryKey = (typeof SBU_ALFA_CATEGORY_KEYS)[number];

export const SBU_ALFA_CATEGORY_LABELS: Record<SbuAlfaCategoryKey, string> = {
  enemy_kia: "Personnel Killed",
  targets_enumerated: "All targets — sum of listed categories",
  targets_total: "Other targets — total",
  targets_destroyed: "Other targets — destroyed",
  targets_damaged: "Other targets — damaged",
  drones: "Drones (UAVs)",
  drone_crews: "UAV crews",
  comms: "Comms / surveillance",
  fortifications: "Fortifications / engineering",
  vehicles_auto_total: "Vehicles (combined)",
  vehicles_light: "Vehicles — light",
  vehicles_moto: "Vehicles — motorcycles",
  vehicles_trucks: "Vehicles — trucks",
  artillery: "Artillery / SPGs",
  armored_total: "Armored vehicles (total)",
  tanks: "Tanks",
  ifvs: "IFVs / combat armored",
  air_defense: "Air defense systems",
  radar: "Radars",
  mlrs: "MLRS",
  aircraft: "Aircraft",
  watercraft: "Watercraft",
  depots: "Ammo / supply depots",
};

export type SbuAlfaBound = "exact" | "at_least" | "approx" | "up_to" | "range";

// One row per (period, category) — what the chart consumes. `period` is YYYY-MM
// for monthly recaps. `bound` lets the UI prefix "≥" for at_least, "~" for
// approx, etc., and `raw_label` carries the verbatim Ukrainian phrasing for the
// tooltip (audit / credibility).
//
// `derived` is true for rows the hook computes from other rows (e.g. summing
// vehicles_light + vehicles_moto + vehicles_trucks into vehicles_auto_total
// for months SBU's press release split into three buckets). The page uses
// this to flag the value in the tooltip — it's our arithmetic, not SBU's.
export interface SbuAlfaCounterRow {
  period: string;
  category: SbuAlfaCategoryKey;
  value: number;
  value_max: number | null;
  bound: SbuAlfaBound;
  raw_label: string | null;
  url: string;
  published_at: string | null;
  derived: boolean;
  derivation_note?: string;
}

// ─── Rubikon (Telegram monthly recap → rubikon.db) ────────────────────────────
// Центр «Рубикон» is a Russian UAV unit; its Telegram channel posts one recap
// of the previous month on the 3rd–4th (running since 2026-01). Numbers are
// unit self-reports — frame them in the UI as claims, not verified counts.
//
// The unit says «Поражены» — *engaged* — with NO destroyed/damaged split, so
// unlike SBS there is one number per category. Two of the post's numbers are
// NOT targets engaged, which is what RubikonKind encodes:
//   sorties        — "боевых вылетов": unit activity, not damage.
//   engaged        — the "Поражены:" list.
//   ew_suppressed  — drones JAMMED by electronic warfare, not struck. Charted
//                    in its own section with a caveat note on every bar so it
//                    can never be read as part of the engaged total.
// See scripts/rubikon/parse.py — the keys below mirror its CATEGORY_ORDER.
export const RUBIKON_CATEGORY_KEYS = [
  "combat_sorties",
  // Synthesised by useDatabaseRubikon, not stated by Rubikon: the sum of every
  // «Поражены» category. Clean to total because the unit's categories are
  // disjoint lines with no parent/child nesting. Deliberately excludes combat
  // sorties (activity, not damage) and EW-suppressed drones (jammed, not
  // struck) — the two counters that aren't targets engaged.
  "targets_engaged_all",
  "personnel",
  "tanks",
  "afv_ifv",
  "apc",
  "spg",
  "towed_artillery",
  "mlrs",
  "radar_ew",
  "comms",
  "uav_control_points",
  "engineering_vehicles",
  "motorcycles",
  "vehicles",
  "uav",
  "ugv",
  "baba_yaga",
  "fire_weapons",
  "mortars",
  "deployment_points",
  "engineering_structures",
  "fortifications",
  "depots",
  "life_support",
  "decoys",
  "sam",
  "aa_guns",
  "command_posts",
  "atgm",
  "fixed_wing_uav",
  "uav_ew_suppressed",
] as const;
export type RubikonCategoryKey = (typeof RUBIKON_CATEGORY_KEYS)[number];

// English labels follow Rubikon's own terminology, EXCEPT where a category is
// semantically identical to one this app already charts — then it reuses that
// existing wording so the same thing reads the same everywhere:
//   towed_artillery    ← TARGET_LABELS[3]  "Cannons, Howitzers"
//   spg                ← TARGET_LABELS[4]  "Self Propelled Artillery"
//   uav_control_points ← TARGET_LABELS[37] "Drone Launch Points" (same term,
//                        "ПУ БпЛА" / "Пункты управления БПЛА")
//   sam / aa_guns      ← TARGET_LABELS[32] / [33]
//   motorcycles / vehicles / mortars ← TARGET_LABELS[18] / [7] / [6]
//   fixed_wing_uav     ← TARGET_LABELS[25], ugv ← TARGET_LABELS[26]
//   personnel          ← RU_LOSSES_METRIC_LABELS.personnel
export const RUBIKON_CATEGORY_LABELS: Record<RubikonCategoryKey, string> = {
  combat_sorties: "Combat Sorties",
  targets_engaged_all: "All targets engaged — sum of categories",
  personnel: "Personnel",
  tanks: "Tanks",
  // Rubikon counts "ББМ, БМП" and "Бронетранспортеры" as two separate lines,
  // so we can't collapse them into SBS's combined "APCs / IFVs / ACVs".
  afv_ifv: "IFVs / Armoured Combat Vehicles",
  apc: "APCs",
  spg: "Self Propelled Artillery",
  towed_artillery: "Cannons, Howitzers",
  mlrs: "MLRS",
  mortars: "Mortars",
  atgm: "ATGMs",
  // «Огневые средства» — "fire assets", anything that delivers fire. The same
  // list counts mortars, towed guns, SPGs, MLRS, ATGMs, SAMs and AA guns on
  // their own lines, so this is the residual: crew-served infantry weapons
  // and unclassified firing points. Our reading of the term, not a translation
  // — see scripts/rubikon/README.md.
  fire_weapons: "Crew-Served Weapons",
  sam: "SAM",
  aa_guns: "AA guns",
  // "РЛС, РЭР, РЭБ" is ONE line in the source — radar, SIGINT and EW counted
  // together. Not split here because the source doesn't split it.
  radar_ew: "Radar / SIGINT / EW",
  comms: "Communication Systems",
  uav_control_points: "Drone Launch Points",
  command_posts: "Command Posts",
  // "ПВД / ОП" — пункт временной дислокации / опорный пункт.
  deployment_points: "Deployment Points / Strongpoints",
  engineering_structures: "Engineering Structures",
  fortifications: "Fortifications",
  depots: "Ammo / Fuel Depots",
  life_support: "Life-Support Equipment",
  engineering_vehicles: "Engineering Vehicles",
  motorcycles: "Motorcycles",
  vehicles: "Vehicles",
  decoys: "Decoys / Mockups",
  uav: "UAVs",
  // Russian nickname for Ukraine's heavy multirotor night-bomber drones.
  baba_yaga: "«Baba Yaga» Heavy UAVs",
  fixed_wing_uav: "Fixed-wing UAVs",
  ugv: "UGVs",
  uav_ew_suppressed: "UAVs Suppressed by EW",
};

export type RubikonKind = "sorties" | "engaged" | "ew_suppressed";

// The two categories that are NOT part of the "Поражены" (engaged) list. The
// page charts them outside the targets grid; `combat_sorties` is activity and
// `uav_ew_suppressed` is jamming, and neither belongs in a targets total.
export const RUBIKON_SORTIES_KEY = "combat_sorties" satisfies RubikonCategoryKey;
export const RUBIKON_EW_KEY = "uav_ew_suppressed" satisfies RubikonCategoryKey;
// Synthetic roll-up of the «Поражены» list; charted on its own, never inside
// the per-category grid (it would be its own parent there).
export const RUBIKON_TARGETS_TOTAL_KEY = "targets_engaged_all" satisfies RubikonCategoryKey;

// One row per (period, category) — what the charts consume. `period` is YYYY-MM.
// `raw_label` is the verbatim Russian phrasing, shown in tooltips for audit.
export interface RubikonCounterRow {
  period: string;
  category: RubikonCategoryKey;
  kind: RubikonKind;
  value: number;
  raw_label: string | null;
  url: string;
  posted_at: string;
  // True for rows the hook computes rather than the parser storing — today
  // just `targets_engaged_all`. The page turns this into a tooltip note so a
  // reader can tell our arithmetic from Rubikon's own figures.
  derived?: boolean;
  derivation_note?: string;
}

// ─── Rubikon published strike episodes («Итоги <месяца>» → rubikon.db) ────────
// INGESTED BUT NOT SURFACED. The types below describe rows that
// scripts/rubikon/parse_digest.py stores under report_type='monthly_digest';
// no page reads them today. Kept so the shape is documented next to the data
// and re-adding a view is a small change, not a re-derivation.
//
// Why there's no page: these are counts of the strike videos the channel
// PUBLISHED, tallied by category — the same tally Lostarmour maintains from
// those videos (every post footer links «Статистика «Рубикона» на Lostarmour»),
// which is where the coarser, unfamiliar category set comes from. If we want
// this measure it should come from Lostarmour's own data, not from
// transcribing Rubikon's monthly summary of it: the summary is spotty
// (13 months, one missing, per-category detail only for 6 of them, three
// headline figures that are floors).
//
// It is also NOT a coarser version of the recap above. Both exist for
// Jan/Feb/Mar 2026, posted days apart, and disagree by ~4×:
//
//   recap   «Применение … по плану начальника Генерального Штаба»
//           — targets the unit CLAIMS to have engaged.   Jan 2026:  8 470
//   digest  «Количество ОПУБЛИКОВАННЫХ эпизодов … официальным каналом»
//           — strike videos the channel PUBLISHED.        Jan 2026:  2 152
//
// Published share is ~20–25% overall but ranges ~0.10 (dugouts) to ~0.95
// (tanks) within a single month — publication selection, not a coarser count.
// So it must never share an axis with the recap. Post 2551 prints both totals
// side by side: 280 000 targets hit vs 45 000 published episodes.
//
// Categories are COARSER aggregates of the recap's and live in their own
// namespace: `radar_comms` merges the recap's radar_ew + comms, `positions`
// merges deployment_points + fortifications + engineering_structures, `armour`
// merges afv_ifv + apc, `uav` merges uav + baba_yaga + fixed_wing_uav.
// Keys mirror scripts/rubikon/parse_digest.py's CATEGORY_ORDER.
export const RUBIKON_EPISODE_CATEGORY_KEYS = [
  "episodes_total",
  "uav",
  "ugv",
  "radar_comms",
  "personnel",
  "vehicles",
  "positions",
  "artillery",
  "towed_artillery",
  "spg",
  "armour",
  "tanks",
  "infrastructure",
  "vks_joint",
  "other",
] as const;
export type RubikonEpisodeCategoryKey = (typeof RUBIKON_EPISODE_CATEGORY_KEYS)[number];

export const RUBIKON_EPISODE_CATEGORY_LABELS: Record<RubikonEpisodeCategoryKey, string> = {
  episodes_total: "Published Episodes — Total",
  uav: "UAVs",
  ugv: "UGVs",
  radar_comms: "Radar / Comms / Surveillance",
  personnel: "Personnel",
  vehicles: "Vehicles",
  positions: "Deployment Points / Field Fortifications",
  artillery: "Artillery Systems",
  // Sep + Oct 2025 only — from Nov the unit reports one merged `artillery`
  // line, so these two stop rather than going to zero.
  towed_artillery: "Cannons, Howitzers",
  spg: "Self Propelled Artillery",
  armour: "Armoured Combat Vehicles",
  tanks: "Tanks",
  infrastructure: "Infrastructure",
  // Strikes flown jointly with the Russian Aerospace Forces — first broken
  // out in March 2026, and counted inside that month's headline total.
  vks_joint: "Joint Strikes with VKS",
  other: "Other Targets",
};

// The headline count; every other key is one line of the structure list, and
// where a breakdown exists its parts sum exactly to this.
export const RUBIKON_EPISODES_TOTAL_KEY = "episodes_total" satisfies RubikonEpisodeCategoryKey;

export type RubikonEpisodeKind = "published_total" | "published_episodes";

// One row per (period, category). `bound` is 'at_least' where the source says
// «превысило N» (a floor) rather than «составило N».
export interface RubikonEpisodeRow {
  period: string;
  category: RubikonEpisodeCategoryKey;
  kind: RubikonEpisodeKind;
  value: number;
  bound: "exact" | "at_least";
  raw_label: string | null;
  url: string;
  posted_at: string;
}

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

// ─── RU Missile stocks (HUR/GUR disclosures → scripts/missile_stockpile/reports.json)
// Hand-curated, irregular (~2×/yr) Ukrainian-intelligence estimates of Russian
// missile stockpiles and monthly production. Read directly from JSON (prototype,
// no DB). Mirrors the shape of reports.json — see that file's _doc block.
// "derived" = a monthly figure WE computed from the source (e.g. an annual
// target ÷ months elapsed, or a % of a known target), not a number HUR stated
// directly — rendered with its own glyph so it's never mistaken for a disclosure.
// "suspended" = a source-stated production halt: a real 0/month (distinct from an
// absent type, which is a gap). value must be 0; on a log axis the marker is
// pinned to the floor since 0 has no position there.
export type MissileBound = "up_to" | "at_least" | "approx" | "exact" | "range" | "planned" | "derived" | "suspended";

export interface MissileMeasurement {
  type?: string;        // single canonical key …
  types?: string[];     // … or several, when one number lumps them (combined)
  combined?: boolean;
  raw_label: string;
  value: number;        // for bound=range this is the LOW end
  value_max?: number;   // high end when bound=range
  bound: MissileBound;
}

export interface MissileTypeMeta {
  name: string;
  designation: string;
  class: string;
  launch: string;
}

export interface MissileReport {
  as_of: string;        // date the figures describe
  as_of_precision: "day" | "mid_month" | "month";
  reported_at: string;  // date the estimate was disclosed
  source: {
    org: string;
    via: string;
    url?: string;
    local_file?: string;
    paywalled?: boolean; // primary url is behind a paywall — see secondary[] for the open re-reports carrying the figures
    secondary?: { via: string; url: string; covers?: string }[]; // outlets that re-reported the same disclosure; `covers` notes which part (e.g. "stockpiles" / "production")
    infographic?: string; // URL of a source infographic that carries the figures (kept for audit)
  };
  note?: string;
  stockpile: MissileMeasurement[];
  production_monthly: MissileMeasurement[];
}

export interface MissileDataset {
  missile_types: Record<string, MissileTypeMeta>;
  reports: MissileReport[];
}
