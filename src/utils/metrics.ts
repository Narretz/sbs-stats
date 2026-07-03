import type { Metric } from "@/types";
import { TARGET_IDS, TARGET_LABELS } from "@/types";
import { SUBSET_LABEL } from "@/tooltipLabels";

export function buildMetrics(options?: { paired?: boolean }): Metric[] {
  const paired = options?.paired ?? false;

  const base: Metric[] = paired
    ? [
        { key: "total_personnel_casualties", label: "Personnel Casualties", wfull: true },
        {
          key: "total_targets_hit",
          label: "Targets Hit / Destroyed",
          pairedKey: "total_targets_destroyed",
          primaryLabel: "Hit",
          pairedLabel: "Destroyed",
          pairMode: "subset",
          subsetLabel: SUBSET_LABEL.destroyed,
        },
        {
          key: "total_personnel_casualties",
          label: "Personnel Hit / Killed",
          pairedKey: "personnel_killed",
          primaryLabel: "Hit",
          pairedLabel: "Killed",
          pairMode: "subset",
          subsetLabel: SUBSET_LABEL.killed,
        },
        { key: "flights_strike", label: "Strike Sorties" },
        { key: "flights_recon", label: "Recon Sorties" },
      ]
    : [
        { key: "total_personnel_casualties", label: "Personnel Casualties", wfull: true },
        { key: "personnel_killed", label: "Personnel Killed" },
        { key: "personnel_wounded", label: "Personnel Wounded" },
        { key: "flights_strike", label: "Strike Sorties" },
        { key: "flights_recon", label: "Recon Sorties" },
        { key: "total_targets_hit", label: "Targets Hit" },
        { key: "total_targets_destroyed", label: "Targets Destroyed" },
      ];

  const targetMetrics: Metric[] = paired
    ? TARGET_IDS.map((id) => ({
        key: `hit_${id}` as Metric["key"],
        label: `${TARGET_LABELS[id]} — Hit / Destroyed`,
        pairedKey: `destroyed_${id}` as Metric["key"],
        primaryLabel: "Hit",
        pairedLabel: "Destroyed",
        pairMode: "subset" as const,
        subsetLabel: SUBSET_LABEL.destroyed,
      }))
    : TARGET_IDS.flatMap((id) => [
        { key: `hit_${id}` as Metric["key"], label: `${TARGET_LABELS[id]} — Hit` },
        { key: `destroyed_${id}` as Metric["key"], label: `${TARGET_LABELS[id]} — Destroyed` },
      ]);

  return [...base, ...targetMetrics];
}
