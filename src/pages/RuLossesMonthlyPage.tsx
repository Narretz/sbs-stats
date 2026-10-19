import { useMemo } from "react";
import { useRuLossesDatabaseContext } from "@/context/databases";
import { useMonthlyMetricGrid } from "@/hooks/useMonthlyMetricGrid";
import { MonthlyBarChart } from "@/components/MonthlyBarChart";
import { DataWindow } from "@/components/DataWindow";
import { MoreControls } from "@/components/MoreControls";
import { StatScopeToggle } from "@/components/StatScopeToggle";
import { MonthWindowControls } from "@/components/MonthWindowControls";
import { PageScaffold } from "@/components/PageScaffold";
import { noDaysMonth, padTrailingMonthly } from "@/utils/padTrailing";
import { maxMedian } from "@/utils/windowStats";
import {
  RU_LOSSES_METRIC_KEYS,
  RU_LOSSES_TARGET_KEYS,
  RU_LOSSES_METRIC_LABELS,
  type RuLossesMetricKey,
  type MonthlyDataPoint,
} from "@/types";

interface Props {
  refreshKey?: number;
}

// Synthetic "all targets" total: every loss category except POWs (captured) —
// personnel casualties plus all equipment (per request; POW is the sole
// exclusion). Both are large: equipment (UAVs, vehicles) is typically the
// bigger share, so neither swamps the other.
const TARGETS_KEYS = RU_LOSSES_TARGET_KEYS;
const sumTargets = (r: Partial<Record<RuLossesMetricKey, number | null>>): number =>
  TARGETS_KEYS.reduce((s, k) => s + (typeof r[k] === "number" ? (r[k] as number) : 0), 0);

export function RuLossesMonthlyPage({ refreshKey }: Props) {
  const { loadState, error, queryMonthly, queryDataWindow } = useRuLossesDatabaseContext();
  const dataWindow = useMemo(() => queryDataWindow(), [queryDataWindow]);
  const { allRows, rows, hasData, yr, allStats } = useMonthlyMetricGrid({
    loadState, queryMonthly, refreshKey, keys: RU_LOSSES_METRIC_KEYS,
  });

  const endMonth = yr.endMonth;

  // Whole-dataset stats for the synthetic total (off the un-sliced rows, like
  // the per-metric stats the hook computes).
  const targetsStats = useMemo(() => maxMedian(allRows.map(sumTargets)), [allRows]);

  // Synthetic dataset: per month, sum the target categories — including their
  // current-month projections (sum of the per-metric linear / weekday-weighted
  // projections), so the projected segment and the tooltip comparison carry over.
  const makeTargetsDataset = (): MonthlyDataPoint[] =>
    padTrailingMonthly<MonthlyDataPoint>(
      rows.map((d) => {
        const value = sumTargets(d);
        const isCurrent = d.projection_day != null;
        const projected = isCurrent
          ? TARGETS_KEYS.reduce((s, k) => s + (d[`${k}_projected`] ?? 0), 0)
          : undefined;
        return {
          date: d.date,
          value,
          gap: projected != null ? projected - value : undefined,
          projected,
          projection_day: d.projection_day ?? undefined,
          projection_days_in_month: d.projection_days_in_month ?? undefined,
          projection_partial_day: d.projection_partial_day,
          daily_median: d.targets_daily_median,
          days_available: d.targets_days,
        };
      }),
      endMonth,
      noDaysMonth,
    );
  const makeDataset = (key: RuLossesMetricKey): MonthlyDataPoint[] =>
    padTrailingMonthly<MonthlyDataPoint>(
      rows.map((d) => {
        const value = typeof d[key] === "number" ? d[key] : null;
        const projected = d[`${key}_projected`];
        return {
          date: d.date,
          value,
          gap: projected != null && value != null ? projected - value : undefined,
          projected,
          projection_day: d.projection_day ?? undefined,
          projection_days_in_month: d.projection_days_in_month ?? undefined,
          projection_partial_day: d.projection_partial_day,
          daily_median: d[`${key}_daily_median`],
          days_available: d[`${key}_days`],
        };
      }),
      endMonth,
      noDaysMonth,
    );

  return (
    <PageScaffold
      title="Monthly Russian Losses - GSUA reports"
      description={<>Monthly sums of daily Russian losses reported by the Ukrainian General Staff · source: <a href="https://github.com/PetroIvaniuk/2022-Ukraine-Russia-War-Dataset" rel="nofollow external" target="_blank">PetroIvaniuk dataset</a></>}
      dataWindow={<DataWindow minDate={dataWindow.minDate} maxDate={dataWindow.maxDate} mode="ru-losses" />}
      // No window picker → no scope toggle either; see StatScopeToggle.
      controls={yr.hidden ? undefined : (
        <>
          <MonthWindowControls yr={yr} min={allRows[0]?.date ?? ""} />
          <MoreControls>
            <StatScopeToggle />
          </MoreControls>
        </>
      )}
      loadState={loadState}
      error={error}
      hasData={hasData}
      loadingMessage="Loading RU losses database…"
      gridChildren={<>
        {RU_LOSSES_METRIC_KEYS.map((k) => (
          <MonthlyBarChart
            key={k}
            title={RU_LOSSES_METRIC_LABELS[k]}
            data={makeDataset(k)}
            wfull={k === "personnel"}
            globalMax={allStats[k]?.max ?? 0}
            globalMedian={allStats[k]?.median ?? 0}
            globalTotal={allStats[k]?.total ?? 0}
          />
        ))}
        <MonthlyBarChart
          key="targets-total"
          title="All Targets — excl. POWs (synthetic)"
          // No daily counterpart: "By day →" opens the daily page at the top.
          drillAnchor=""
          data={makeTargetsDataset()}
          wfull
          globalMax={targetsStats.max}
          globalMedian={targetsStats.median}
          globalTotal={targetsStats.total}
        />
      </>}
    />
  );
}
