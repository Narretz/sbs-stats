import { useMemo } from "react";
import { useUaLossesRuModDatabaseContext } from "@/sites/uaLossesRuMod/context";
import { useMonthlyMetricGrid } from "@/hooks/useMonthlyMetricGrid";
import { MonthlyBarChart } from "@/components/MonthlyBarChart";
import { DataWindow } from "@/components/DataWindow";
import { StatScopeToggle } from "@/components/StatScopeToggle";
import { MonthRangeSelect } from "@/components/MonthRangeSelect";
import { PageScaffold } from "@/components/PageScaffold";
import { padTrailingMonthly, resolvedEndMonth } from "@/utils/padTrailing";
import { maxMedian } from "@/utils/windowStats";
import { armourBreakdown } from "@/utils/armourBreakdown";
import {
  UA_LOSSES_RU_MOD_METRIC_KEYS,
  UA_LOSSES_RU_MOD_METRIC_LABELS,
  type ModelBreakdownEntry,
  type UaLossesRuModMetricKey,
  type MonthlyDataPoint,
} from "@/types";

interface Props {
  refreshKey?: number;
}

// Synthetic "all targets" total, as on the GSUA losses page: every category
// except POWs. That includes the munitions shot down — GSUA's total counts its
// cruise missiles and UAVs (mostly shot down too) the same way.
const TARGETS_KEYS: UaLossesRuModMetricKey[] = UA_LOSSES_RU_MOD_METRIC_KEYS.filter((k) => k !== "captured");
const sumTargets = (r: Partial<Record<UaLossesRuModMetricKey, number>>): number =>
  TARGETS_KEYS.reduce((s, k) => s + (typeof r[k] === "number" ? (r[k] as number) : 0), 0);

export function UaLossesRuModMonthlyPage({ refreshKey }: Props) {
  const { loadState, error, queryMonthly, queryDataWindow } = useUaLossesRuModDatabaseContext();
  const dataWindow = useMemo(() => queryDataWindow(), [queryDataWindow]);
  const { allRows, rows, hasData, yr, allStats } = useMonthlyMetricGrid({
    loadState, queryMonthly, refreshKey, keys: UA_LOSSES_RU_MOD_METRIC_KEYS,
  });

  const endMonth = resolvedEndMonth();

  // Felix's itemisation of the MoD's armour figure, per month (see the daily page).
  const armourByMonth = useMemo(() => {
    const m = new Map<string, ModelBreakdownEntry[]>();
    for (const d of rows) m.set(d.date, armourBreakdown(d.armour, d));
    return m;
  }, [rows]);

  // Whole-dataset stats for the synthetic total (off the un-sliced rows, like
  // the per-metric stats the hook computes).
  const targetsStats = useMemo(() => maxMedian(allRows.map(sumTargets)), [allRows]);

  // Synthetic dataset: per month, sum the target categories — including their
  // current-month projections (sum of the per-metric linear / weekday-weighted
  // projections), so the projected segment and the tooltip comparison carry over.
  const makeTargetsDataset = (): MonthlyDataPoint[] =>
    padTrailingMonthly(
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
        };
      }),
      endMonth,
    );
  const makeDataset = (key: UaLossesRuModMetricKey): MonthlyDataPoint[] =>
    padTrailingMonthly(
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
        };
      }),
      endMonth,
    );

  return (
    <PageScaffold
      title="Monthly Ukrainian Losses - RU MoD claims"
      description={<>Monthly sums of the Ukrainian losses claimed by the Russian Ministry of Defence · compiled by John Felix (<a href="https://x.com/NedSnow2019" rel="nofollow external" target="_blank">@NedSnow2019</a>) from the MoD's reports · Russian claims, unverified</>}
      dataWindow={<DataWindow minDate={dataWindow.minDate} maxDate={dataWindow.maxDate} mode="ua-losses-ru-mod" />}
      // No window picker → no scope toggle either; see StatScopeToggle.
      controls={yr.hidden ? undefined : (
        <>
          <MonthRangeSelect options={yr.monthOptions} value={yr.months} onChange={yr.setMonths} />
          <StatScopeToggle />
        </>
      )}
      loadState={loadState}
      error={error}
      hasData={hasData}
      loadingMessage="Loading RU MoD claims database…"
      gridChildren={<>
        {UA_LOSSES_RU_MOD_METRIC_KEYS.map((k) => (
          <MonthlyBarChart
            key={k}
            title={UA_LOSSES_RU_MOD_METRIC_LABELS[k]}
            data={makeDataset(k)}
            wfull={k === "personnel"}
            breakdownByMonth={k === "armour" ? armourByMonth : undefined}
            globalMax={allStats[k]?.max ?? 0}
            globalMedian={allStats[k]?.median ?? 0}
            globalTotal={allStats[k]?.total ?? 0}
          />
        ))}
        <MonthlyBarChart
          key="targets-total"
          title="All Targets — excl. POWs (synthetic)"
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
