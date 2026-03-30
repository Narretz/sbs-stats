import type { Metric } from "@/types";
import { TARGET_IDS, TARGET_LABELS } from "@/types";

export function buildMetrics(): Metric[] {
  const base: Metric[] = [
    { key: "total_personnel_casualties", label: "Personnel Casualties", wfull: true },
    { key: "personnel_killed", label: "Personnel Killed" },
    { key: "personnel_wounded", label: "Personnel Wounded" },
    { key: "flights_strike", label: "Strike Sorties" },
    { key: "flights_recon", label: "Recon Sorties" },
    { key: "total_targets_hit", label: "Targets Hit" },
    { key: "total_targets_destroyed", label: "Targets Destroyed" },
  ];

  const targetMetrics: Metric[] = TARGET_IDS.flatMap((id) => [
    { key: `hit_${id}` as Metric["key"], label: `${TARGET_LABELS[id]} — Hit` },
    { key: `destroyed_${id}` as Metric["key"], label: `${TARGET_LABELS[id]} — Destroyed` },
  ]);

  return [...base, ...targetMetrics];
}
