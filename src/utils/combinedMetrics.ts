// Cross-source metric registry for the homepage's configurable chart.
//
// Each metric is identified by a URL-safe `id` of the shape `<source>.<key>`.
// `key` matches the column name in the source's daily/monthly row, so the
// fetcher can project `row[key]` without translation tables. Labels are
// composed from existing per-source label maps — no new translation needed.

import {
  ATTACK_CATEGORY_KEYS,
  ATTACK_CATEGORY_LABELS,
  GSUA_METRIC_KEYS,
  GSUA_METRIC_LABELS,
  MEDIAZONA_ROLE_GROUP_KEYS,
  MEDIAZONA_ROLE_GROUPS,
  RU_LOSSES_METRIC_KEYS,
  RU_LOSSES_METRIC_LABELS,
  UA_LOSSES_METRIC_KEYS,
  UA_LOSSES_METRIC_LABELS,
  SBU_ALFA_CATEGORY_KEYS,
  SBU_ALFA_CATEGORY_LABELS,
  RUBIKON_CATEGORY_KEYS,
  RUBIKON_CATEGORY_LABELS,
  TARGET_IDS,
  TARGET_LABELS,
} from "@/types";

export type MetricSource =
  | "sbs"
  // One SBS sub-unit. Unlike every other source this one is not a single
  // dataset: which rows it yields depends on WHICH unit the metric names, so
  // its metrics carry a `unit` and its ids have three parts. See makeUnitMetric.
  | "sbs-unit"
  | "gsua"
  | "ru-losses"
  | "ua-losses"
  | "ru-airdef-mod"
  | "ru-air-attacks"
  | "sbu-alfa"
  | "rubikon"
  // Mediazona's two underlying tables are released on different cadences —
  // role composition runs weekly through "now", the probate-registry estimate
  // series only refreshes when Meduza/Mediazona publish a new modelling
  // update (so it lags ~6 months). They're split here so the MetricPicker
  // groups them separately, making the gap visible in the UI.
  | "mediazona-roles"
  | "mediazona-estimate";

// Which underlying DB hook each source talks to. Two MetricSource values can
// share the same hook (Mediazona today). Used by HomePage to decide which
// `useDatabase*` hook needs to be `enabled` for a given source set.
export type MetricDbHook =
  | "sbs"
  | "sbs-units"
  | "gsua"
  | "ru-losses"
  | "ua-losses"
  | "ru-airdef-mod"
  | "ru-air-attacks"
  | "sbu-alfa"
  | "rubikon"
  | "mediazona";

export const SOURCE_TO_DB: Record<MetricSource, MetricDbHook> = {
  "sbs": "sbs",
  "sbs-unit": "sbs-units",
  "gsua": "gsua",
  "ru-losses": "ru-losses",
  "ua-losses": "ua-losses",
  "ru-airdef-mod": "ru-airdef-mod",
  "ru-air-attacks": "ru-air-attacks",
  "sbu-alfa": "sbu-alfa",
  "rubikon": "rubikon",
  "mediazona-roles": "mediazona",
  "mediazona-estimate": "mediazona",
};

export type MetricView = "daily" | "monthly";

export interface CombinedMetric {
  id: string;
  source: MetricSource;
  // Set only for `sbs-unit`: the sub-unit slug whose rows this metric reads.
  // The fetcher groups by it, because one query per source isn't enough when
  // the source is parameterised.
  unit?: string;
  // Column name in the source's daily/monthly row (the fetcher reads
  // `row[key]`). For paired sources like RU air attacks this is the
  // pivoted column (e.g. `drone_launched`).
  key: string;
  sourceLabel: string;
  metricLabel: string;
  label: string;             // `${sourceLabel} · ${metricLabel}`
  views: MetricView[];
}

export const SOURCE_LABELS: Record<MetricSource, string> = {
  "sbs": "SBS",
  "sbs-unit": "SBS Unit",
  "gsua": "GSUA",
  "ru-losses": "RU Losses",
  "ua-losses": "UA Personnel Losses",
  "ru-airdef-mod": "RU MoD AD",
  "ru-air-attacks": "RU Strikes",
  "sbu-alfa": "SBU Alfa",
  "rubikon": "Rubikon",
  "mediazona-roles": "Mediazona — Roles",
  "mediazona-estimate": "Mediazona — Estimate",
};

function make(
  source: MetricSource,
  key: string,
  metricLabel: string,
  views: MetricView[],
): CombinedMetric {
  const sourceLabel = SOURCE_LABELS[source];
  return {
    id: `${source}.${key}`,
    source,
    key,
    sourceLabel,
    metricLabel,
    label: `${sourceLabel} · ${metricLabel}`,
    views,
  };
}

const BOTH: MetricView[] = ["daily", "monthly"];
const MONTHLY_ONLY: MetricView[] = ["monthly"];

// SBS — 7 base metrics + 16 targets × {hit, destroyed}.
const SBS_BASE: Array<[string, string]> = [
  ["personnel_killed", "Personnel Killed"],
  ["personnel_wounded", "Personnel Wounded"],
  ["total_personnel_casualties", "Personnel Casualties"],
  ["total_targets_hit", "Targets Hit"],
  ["total_targets_destroyed", "Targets Destroyed"],
  ["flights_strike", "Strike Sorties"],
  ["flights_recon", "Recon Sorties"],
];

const SBS_METRICS: CombinedMetric[] = [
  ...SBS_BASE.map(([k, l]) => make("sbs", k, l, BOTH)),
  ...TARGET_IDS.flatMap((id) => [
    make("sbs", `hit_${id}`, `${TARGET_LABELS[id]} — Hit`, BOTH),
    make("sbs", `destroyed_${id}`, `${TARGET_LABELS[id]} — Destroyed`, BOTH),
  ]),
];

const GSUA_METRICS: CombinedMetric[] = GSUA_METRIC_KEYS.map((k) =>
  make("gsua", k, GSUA_METRIC_LABELS[k], BOTH),
);

const RU_LOSSES_METRICS: CombinedMetric[] = RU_LOSSES_METRIC_KEYS.map((k) =>
  make("ru-losses", k, RU_LOSSES_METRIC_LABELS[k], BOTH),
);

// UA losses (ualosses.org) — daily-capable like RU losses.
const UA_LOSSES_METRICS: CombinedMetric[] = UA_LOSSES_METRIC_KEYS.map((k) =>
  make("ua-losses", k, UA_LOSSES_METRIC_LABELS[k], BOTH),
);

// RU MoD has no exported label map — three fixed metrics.
const RU_MOD_METRICS: CombinedMetric[] = [
  make("ru-airdef-mod", "total", "UAVs Downed (Total)", BOTH),
  make("ru-airdef-mod", "night", "UAVs Downed (Overnight)", BOTH),
  make("ru-airdef-mod", "day", "UAVs Downed (Daytime)", BOTH),
];

// RU air attacks: 4 categories × {launched, intercepted}.
const RU_AIR_ATTACKS_METRICS: CombinedMetric[] = ATTACK_CATEGORY_KEYS.flatMap((c) => [
  make("ru-air-attacks", `${c}_launched`, `${ATTACK_CATEGORY_LABELS[c]} — Launched`, BOTH),
  make("ru-air-attacks", `${c}_intercepted`, `${ATTACK_CATEGORY_LABELS[c]} — Intercepted`, BOTH),
]);

// SBU Alfa — monthly only.
const SBU_ALFA_METRICS: CombinedMetric[] = SBU_ALFA_CATEGORY_KEYS.map((k) =>
  make("sbu-alfa", k, SBU_ALFA_CATEGORY_LABELS[k], MONTHLY_ONLY),
);

// Rubikon — monthly only. Includes the two non-target counters (combat
// sorties, EW-suppressed drones); their labels say so, since the homepage
// chart has no room for the caveat notes the dataset page shows.
const RUBIKON_METRICS: CombinedMetric[] = RUBIKON_CATEGORY_KEYS.map((k) =>
  make("rubikon", k, RUBIKON_CATEGORY_LABELS[k], MONTHLY_ONLY),
);

// Mediazona — monthly only. Two underlying tables published on different
// cadences (the estimate series lags by ~6 months) — modelled as two separate
// sources so the picker groups them apart and the cadence gap is visible.
const MEDIAZONA_METRICS: CombinedMetric[] = [
  make("mediazona-roles", "total", "Personnel Confirmed Deaths (Total)", MONTHLY_ONLY),
  ...MEDIAZONA_ROLE_GROUP_KEYS.map((k) =>
    make("mediazona-roles", k, MEDIAZONA_ROLE_GROUPS[k].label, MONTHLY_ONLY),
  ),
  make("mediazona-estimate", "documented", "Personnel Documented Deaths (Total)", MONTHLY_ONLY),
  make("mediazona-estimate", "estimate", "Personnel Probate-Registry Deaths Estimate", MONTHLY_ONLY),
];

export const COMBINED_METRICS: CombinedMetric[] = [
  ...SBS_METRICS,
  ...GSUA_METRICS,
  ...RU_LOSSES_METRICS,
  ...UA_LOSSES_METRICS,
  ...RU_MOD_METRICS,
  ...RU_AIR_ATTACKS_METRICS,
  ...SBU_ALFA_METRICS,
  ...RUBIKON_METRICS,
  ...MEDIAZONA_METRICS,
];

// ─── SBS sub-units ───────────────────────────────────────────────────────────
// Deliberately NOT expanded into COMBINED_METRICS. 15 units x 89 metrics is
// 1,335 entries, and the picker renders its whole list into the DOM — once per
// chart on the page. Instead the metrics are synthesised on demand: the picker
// shows one unit <select> plus the shared SBS metric list, so its DOM grows by
// ~90 rows once rather than 1,335 per instance.
//
// The counters are exactly SBS's, because a unit publishes exactly what the
// grouping does. Same reason the compare page needed no new row mappings.
export const SBS_UNIT_METRIC_KEYS: Array<[string, string]> = [
  ...SBS_BASE,
  ...TARGET_IDS.flatMap((id): Array<[string, string]> => [
    [`hit_${id}`, `${TARGET_LABELS[id]} — Hit`],
    [`destroyed_${id}`, `${TARGET_LABELS[id]} — Destroyed`],
  ]),
];

const UNIT_METRIC_LABELS = new Map(SBS_UNIT_METRIC_KEYS);

// Slug → display name, populated by the page once sbs-units.db has loaded.
// A mutable module map rather than a parameter because `findMetric(id)` has to
// work from an id alone — it is called on ids restored from the URL, before
// any unit list exists. Unknown slugs fall back to the slug itself, which is
// readable enough ("fenix") and self-corrects on the next render.
const UNIT_NAMES = new Map<string, string>();

export function setSbsUnitNames(units: Array<{ slug: string; name: string }>): void {
  for (const u of units) UNIT_NAMES.set(u.slug, u.name);
}

export function sbsUnitMetricId(unit: string, key: string): string {
  return `sbs-unit.${unit}.${key}`;
}

// Monthly only for now. The per-unit daily series exists in the DB but starts
// from the day the ingest was switched on (only `daily`/`prev_day` are
// addressable — there is no backfill), so charting it today would draw a
// near-empty line. Flip to BOTH once it has history.
export function makeUnitMetric(unit: string, key: string): CombinedMetric | undefined {
  const metricLabel = UNIT_METRIC_LABELS.get(key);
  if (!metricLabel) return undefined;
  const sourceLabel = `SBS · ${UNIT_NAMES.get(unit) ?? unit}`;
  return {
    id: sbsUnitMetricId(unit, key),
    source: "sbs-unit",
    unit,
    key,
    sourceLabel,
    metricLabel,
    label: `${sourceLabel} · ${metricLabel}`,
    views: MONTHLY_ONLY,
  };
}

const BY_ID = new Map(COMBINED_METRICS.map((m) => [m.id, m]));

export function findMetric(id: string): CombinedMetric | undefined {
  const known = BY_ID.get(id);
  if (known) return known;
  // `sbs-unit.<slug>.<key>` — three parts, and the key itself never contains a
  // dot (they are column names like `hit_24`), so a plain split is safe.
  if (id.startsWith("sbs-unit.")) {
    const [, unit, ...rest] = id.split(".");
    if (unit && rest.length) return makeUnitMetric(unit, rest.join("."));
  }
  return undefined;
}

export function metricsForView(view: MetricView): CombinedMetric[] {
  return COMBINED_METRICS.filter((m) => m.views.includes(view));
}
