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
  RU_LOSSES_METRIC_KEYS,
  RU_LOSSES_METRIC_LABELS,
  SBU_ALFA_CATEGORY_KEYS,
  SBU_ALFA_CATEGORY_LABELS,
  TARGET_IDS,
  TARGET_LABELS,
} from "@/types";

export type MetricSource =
  | "sbs"
  | "gsua"
  | "ru-losses"
  | "ru-airdef-mod"
  | "ru-air-attacks"
  | "sbu-alfa";

export type MetricView = "daily" | "monthly";

export interface CombinedMetric {
  id: string;
  source: MetricSource;
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
  "gsua": "GSUA",
  "ru-losses": "RU Losses",
  "ru-airdef-mod": "RU MoD AD",
  "ru-air-attacks": "RU Strikes",
  "sbu-alfa": "SBU Alfa",
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

export const COMBINED_METRICS: CombinedMetric[] = [
  ...SBS_METRICS,
  ...GSUA_METRICS,
  ...RU_LOSSES_METRICS,
  ...RU_MOD_METRICS,
  ...RU_AIR_ATTACKS_METRICS,
  ...SBU_ALFA_METRICS,
];

const BY_ID = new Map(COMBINED_METRICS.map((m) => [m.id, m]));

export function findMetric(id: string): CombinedMetric | undefined {
  return BY_ID.get(id);
}

export function metricsForView(view: MetricView): CombinedMetric[] {
  return COMBINED_METRICS.filter((m) => m.views.includes(view));
}
